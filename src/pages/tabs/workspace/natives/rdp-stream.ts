import type { RdpFrameCodec } from "@/types/termopen";

const STREAM_PACKET_MAGIC = [0x54, 0x52, 0x44, 0x50] as const; // TRDP
const STREAM_PACKET_VERSION = 1;
const STREAM_PACKET_HEADER_SIZE = 24;
const H264_CODEC = "avc1.42E01F";
const RDP_VIDEO_CHUNK_EVENT = "termopen:rdp-video-chunk";
const RDP_VIDEO_DECODER_ERROR_EVENT = "termopen:rdp-video-decoder-error";

let preferredCodecPromise: Promise<RdpFrameCodec> | null = null;

export interface ParsedRdpStreamFramePacket {
  codec: RdpFrameCodec;
  keyframe: boolean;
  width: number;
  height: number;
  ptsUs: number;
  payload: Uint8Array;
}

export interface RdpVideoChunkEventDetail {
  blockId: string;
  keyframe: boolean;
  width: number;
  height: number;
  ptsUs: number;
  payload: Uint8Array;
}

export interface RdpVideoDecoderErrorDetail {
  blockId: string;
}

export function parseRdpStreamFramePacket(message: ArrayBuffer): ParsedRdpStreamFramePacket | null {
  const bytes = new Uint8Array(message);

  if (bytes.byteLength < STREAM_PACKET_HEADER_SIZE) {
    return {
      codec: "png",
      keyframe: true,
      width: 0,
      height: 0,
      ptsUs: 0,
      payload: bytes.slice(),
    };
  }

  const hasHeader =
    bytes[0] === STREAM_PACKET_MAGIC[0] &&
    bytes[1] === STREAM_PACKET_MAGIC[1] &&
    bytes[2] === STREAM_PACKET_MAGIC[2] &&
    bytes[3] === STREAM_PACKET_MAGIC[3] &&
    bytes[4] === STREAM_PACKET_VERSION;

  if (!hasHeader) {
    return {
      codec: "png",
      keyframe: true,
      width: 0,
      height: 0,
      ptsUs: 0,
      payload: bytes.slice(),
    };
  }

  const view = new DataView(message);
  const codecId = view.getUint8(5);
  const codec: RdpFrameCodec = codecId === 1 ? "h264" : "png";
  const keyframe = (view.getUint8(6) & 0b1) === 1;
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const ptsLow = view.getUint32(12, true);
  const ptsHigh = view.getUint32(16, true);
  const ptsUs = ptsHigh * 2 ** 32 + ptsLow;
  const payloadSize = view.getUint32(20, true);
  const payloadOffset = STREAM_PACKET_HEADER_SIZE;

  if (payloadOffset + payloadSize > bytes.byteLength) {
    return null;
  }

  const payload = bytes.slice(payloadOffset, payloadOffset + payloadSize);
  return {
    codec,
    keyframe,
    width,
    height,
    ptsUs,
    payload,
  };
}

async function probePreferredCodec(): Promise<RdpFrameCodec> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "png";
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (!userAgent.includes("windows")) {
    return "png";
  }

  const videoDecoderCtor = (globalThis as typeof globalThis & { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
  const encodedVideoChunkCtor = (globalThis as typeof globalThis & { EncodedVideoChunk?: typeof EncodedVideoChunk })
    .EncodedVideoChunk;
  if (!videoDecoderCtor || !encodedVideoChunkCtor || typeof videoDecoderCtor.isConfigSupported !== "function") {
    return "png";
  }

  try {
    const support = await videoDecoderCtor.isConfigSupported({
      codec: H264_CODEC,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
    if (!support.supported) {
      return "png";
    }
  } catch {
    return "png";
  }

  try {
    const mediaCapabilities = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
    if (mediaCapabilities?.decodingInfo) {
      const info = await mediaCapabilities.decodingInfo({
        type: "media-source",
        video: {
          contentType: `video/mp4; codecs="${H264_CODEC}"`,
          width: 1280,
          height: 720,
          bitrate: 3_500_000,
          framerate: 18,
        },
      } as MediaDecodingConfiguration);
      if (!info.supported) {
        return "png";
      }
    }
  } catch {
    // Ignore MediaCapabilities errors and keep the WebCodecs probe result.
  }

  return "h264";
}

export function detectPreferredRdpCodec(): Promise<RdpFrameCodec> {
  if (!preferredCodecPromise) {
    preferredCodecPromise = probePreferredCodec();
  }
  return preferredCodecPromise;
}

export function emitRdpVideoChunk(detail: RdpVideoChunkEventDetail): void {
  window.dispatchEvent(new CustomEvent<RdpVideoChunkEventDetail>(RDP_VIDEO_CHUNK_EVENT, { detail }));
}

export function onRdpVideoChunk(
  listener: (detail: RdpVideoChunkEventDetail) => void,
): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RdpVideoChunkEventDetail>;
    if (custom.detail) {
      listener(custom.detail);
    }
  };
  window.addEventListener(RDP_VIDEO_CHUNK_EVENT, handler);
  return () => window.removeEventListener(RDP_VIDEO_CHUNK_EVENT, handler);
}

export function emitRdpVideoDecoderError(detail: RdpVideoDecoderErrorDetail): void {
  window.dispatchEvent(new CustomEvent<RdpVideoDecoderErrorDetail>(RDP_VIDEO_DECODER_ERROR_EVENT, { detail }));
}

export function onRdpVideoDecoderError(
  listener: (detail: RdpVideoDecoderErrorDetail) => void,
): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RdpVideoDecoderErrorDetail>;
    if (custom.detail) {
      listener(custom.detail);
    }
  };
  window.addEventListener(RDP_VIDEO_DECODER_ERROR_EVENT, handler);
  return () => window.removeEventListener(RDP_VIDEO_DECODER_ERROR_EVENT, handler);
}
