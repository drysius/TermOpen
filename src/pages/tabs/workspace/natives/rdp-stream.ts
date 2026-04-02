import lz4 from "lz4js";

const VIDEO_PACKET_MAGIC = [0x54, 0x52, 0x44, 0x56] as const; // TRDV
const CURSOR_PACKET_MAGIC = [0x54, 0x52, 0x44, 0x43] as const; // TRDC
const AUDIO_PACKET_MAGIC = [0x54, 0x52, 0x44, 0x41] as const; // TRDA
const PACKET_VERSION = 1;
const VIDEO_PACKET_HEADER_SIZE = 32;
const VIDEO_RECT_HEADER_SIZE = 20;
const CURSOR_PACKET_HEADER_SIZE = 28;
const AUDIO_PACKET_HEADER_SIZE = 24;
const COMPRESSION_NONE = 0;
const COMPRESSION_LZ4 = 1;
const RDP_VIDEO_RECTS_EVENT = "termopen:rdp-video-rects";
const RDP_CURSOR_EVENT = "termopen:rdp-cursor";
const RDP_AUDIO_EVENT = "termopen:rdp-audio";

function readU64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 2 ** 32 + low;
}

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) {
    return false;
  }
  return magic.every((value, index) => bytes[index] === value);
}

function ensureUint8Array(data: Uint8Array | number[]): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function decompressPayload(compression: number, payload: Uint8Array, expectedSize: number): Uint8Array | null {
  if (compression === COMPRESSION_NONE) {
    return payload;
  }
  if (compression !== COMPRESSION_LZ4) {
    return null;
  }

  try {
    const decoded = ensureUint8Array(lz4.decompress(payload));
    if (expectedSize > 0 && decoded.byteLength !== expectedSize) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export interface ParsedRdpVideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface ParsedRdpVideoRectsPacket {
  frameId: number;
  width: number;
  height: number;
  ptsUs: number;
  frameBegin: boolean;
  frameEnd: boolean;
  rects: ParsedRdpVideoRect[];
}

export interface ParsedRdpCursorPacket {
  kind: "default" | "hidden" | "position" | "bitmap";
  x: number;
  y: number;
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  bitmap?: Uint8Array;
}

export interface ParsedRdpAudioPacket {
  channels: number;
  bitsPerSample: number;
  sampleRate: number;
  ptsUs: number;
  pcm: Uint8Array;
}

export interface RdpVideoRectsEventDetail {
  blockId: string;
  packet: ParsedRdpVideoRectsPacket;
}

export interface RdpCursorEventDetail {
  blockId: string;
  packet: ParsedRdpCursorPacket;
}

export interface RdpAudioEventDetail {
  blockId: string;
  packet: ParsedRdpAudioPacket;
}

export function parseRdpVideoRectsPacket(message: ArrayBuffer): ParsedRdpVideoRectsPacket | null {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength < VIDEO_PACKET_HEADER_SIZE || !hasMagic(bytes, VIDEO_PACKET_MAGIC)) {
    return null;
  }

  const view = new DataView(message);
  const version = view.getUint8(4);
  if (version !== PACKET_VERSION) {
    return null;
  }

  const flags = view.getUint8(5);
  const frameId = readU64(view, 8);
  const width = view.getUint16(16, true);
  const height = view.getUint16(18, true);
  const rectCount = view.getUint16(20, true);
  const ptsUs = readU64(view, 24);

  let offset = VIDEO_PACKET_HEADER_SIZE;
  const rects: ParsedRdpVideoRect[] = [];
  for (let index = 0; index < rectCount; index += 1) {
    if (offset + VIDEO_RECT_HEADER_SIZE > bytes.byteLength) {
      return null;
    }

    const x = view.getUint16(offset, true);
    const y = view.getUint16(offset + 2, true);
    const rectWidth = view.getUint16(offset + 4, true);
    const rectHeight = view.getUint16(offset + 6, true);
    const compression = view.getUint8(offset + 8);
    const rawSize = view.getUint32(offset + 12, true);
    const payloadSize = view.getUint32(offset + 16, true);
    offset += VIDEO_RECT_HEADER_SIZE;

    if (offset + payloadSize > bytes.byteLength) {
      return null;
    }
    const payload = bytes.slice(offset, offset + payloadSize);
    offset += payloadSize;

    const pixels = decompressPayload(compression, payload, rawSize);
    if (!pixels) {
      return null;
    }

    rects.push({
      x,
      y,
      width: rectWidth,
      height: rectHeight,
      pixels,
    });
  }

  return {
    frameId,
    width,
    height,
    ptsUs,
    frameBegin: (flags & 0b1) === 0b1,
    frameEnd: (flags & 0b10) === 0b10,
    rects,
  };
}

export function parseRdpCursorPacket(message: ArrayBuffer): ParsedRdpCursorPacket | null {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength < CURSOR_PACKET_HEADER_SIZE || !hasMagic(bytes, CURSOR_PACKET_MAGIC)) {
    return null;
  }

  const view = new DataView(message);
  const version = view.getUint8(4);
  if (version !== PACKET_VERSION) {
    return null;
  }

  const kindId = view.getUint8(5);
  const x = view.getUint16(8, true);
  const y = view.getUint16(10, true);
  const hotspotX = view.getUint16(12, true);
  const hotspotY = view.getUint16(14, true);
  const width = view.getUint16(16, true);
  const height = view.getUint16(18, true);
  const payloadSize = view.getUint32(20, true);
  const compression = view.getUint8(24);

  if (CURSOR_PACKET_HEADER_SIZE + payloadSize > bytes.byteLength) {
    return null;
  }
  const payload = bytes.slice(CURSOR_PACKET_HEADER_SIZE, CURSOR_PACKET_HEADER_SIZE + payloadSize);

  const kind = kindId === 0 ? "default" : kindId === 1 ? "hidden" : kindId === 2 ? "position" : "bitmap";
  if (kind !== "bitmap") {
    return {
      kind,
      x,
      y,
      hotspotX,
      hotspotY,
      width,
      height,
    };
  }

  const expectedSize = width > 0 && height > 0 ? width * height * 4 : 0;
  const bitmap = decompressPayload(compression, payload, expectedSize);
  if (!bitmap) {
    return null;
  }

  return {
    kind: "bitmap",
    x,
    y,
    hotspotX,
    hotspotY,
    width,
    height,
    bitmap,
  };
}

export function parseRdpAudioPacket(message: ArrayBuffer): ParsedRdpAudioPacket | null {
  const bytes = new Uint8Array(message);
  if (bytes.byteLength < AUDIO_PACKET_HEADER_SIZE || !hasMagic(bytes, AUDIO_PACKET_MAGIC)) {
    return null;
  }

  const view = new DataView(message);
  const version = view.getUint8(4);
  if (version !== PACKET_VERSION) {
    return null;
  }

  const compression = view.getUint8(5);
  const channels = view.getUint8(6);
  const bitsPerSample = view.getUint8(7);
  const sampleRate = view.getUint32(8, true);
  const ptsUs = readU64(view, 12);
  const payloadSize = view.getUint32(20, true);
  if (AUDIO_PACKET_HEADER_SIZE + payloadSize > bytes.byteLength) {
    return null;
  }

  const payload = bytes.slice(AUDIO_PACKET_HEADER_SIZE, AUDIO_PACKET_HEADER_SIZE + payloadSize);
  const pcm = decompressPayload(compression, payload, payloadSize);
  if (!pcm) {
    return null;
  }

  return {
    channels,
    bitsPerSample,
    sampleRate,
    ptsUs,
    pcm,
  };
}

export function emitRdpVideoRects(detail: RdpVideoRectsEventDetail): void {
  window.dispatchEvent(new CustomEvent<RdpVideoRectsEventDetail>(RDP_VIDEO_RECTS_EVENT, { detail }));
}

export function onRdpVideoRects(listener: (detail: RdpVideoRectsEventDetail) => void): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RdpVideoRectsEventDetail>;
    if (custom.detail) {
      listener(custom.detail);
    }
  };
  window.addEventListener(RDP_VIDEO_RECTS_EVENT, handler);
  return () => window.removeEventListener(RDP_VIDEO_RECTS_EVENT, handler);
}

export function emitRdpCursor(detail: RdpCursorEventDetail): void {
  window.dispatchEvent(new CustomEvent<RdpCursorEventDetail>(RDP_CURSOR_EVENT, { detail }));
}

export function onRdpCursor(listener: (detail: RdpCursorEventDetail) => void): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RdpCursorEventDetail>;
    if (custom.detail) {
      listener(custom.detail);
    }
  };
  window.addEventListener(RDP_CURSOR_EVENT, handler);
  return () => window.removeEventListener(RDP_CURSOR_EVENT, handler);
}

export function emitRdpAudio(detail: RdpAudioEventDetail): void {
  window.dispatchEvent(new CustomEvent<RdpAudioEventDetail>(RDP_AUDIO_EVENT, { detail }));
}

export function onRdpAudio(listener: (detail: RdpAudioEventDetail) => void): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RdpAudioEventDetail>;
    if (custom.detail) {
      listener(custom.detail);
    }
  };
  window.addEventListener(RDP_AUDIO_EVENT, handler);
  return () => window.removeEventListener(RDP_AUDIO_EVENT, handler);
}

