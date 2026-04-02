import { api } from "@/lib/tauri";
import type { RdpFrameCodec, RdpInputAction, RdpStreamEvent, RdpStreamStartResult } from "@/types/termopen";

interface SocketRequestPayload {
  id: string;
  method: string;
  params?: unknown;
}

interface SocketResponsePayload {
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface SocketEventPayload {
  kind: "event";
  event: string;
  payload: unknown;
}

interface BackendSocketRdpFramePacket {
  sessionId: string;
  payload: ArrayBuffer;
}

const WS_BINARY_MAGIC = [0x54, 0x4f, 0x57, 0x53] as const; // TOWS
const WS_BINARY_MESSAGE_RDP_FRAME = 1;
const WS_HEADER_SIZE = 12;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
};

type EventListener = (payload: unknown) => void;
type RdpEventListener = (event: RdpStreamEvent) => void;
type RdpFrameListener = (packet: BackendSocketRdpFramePacket) => void;

class BackendSocketClient {
  private socket: WebSocket | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly rdpEventListeners = new Map<string, Set<RdpEventListener>>();
  private readonly rdpFrameListeners = new Map<string, Set<RdpFrameListener>>();
  private readonly latestRdpEventBySession = new Map<string, RdpStreamEvent>();
  private closedByClient = false;
  private token = "";
  private url = "";

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.initInternal();
    return this.initPromise;
  }

  private async initInternal(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (!this.token || !this.url) {
      const bootstrap = await api.wsBootstrap();
      this.token = bootstrap.token;
      this.url = bootstrap.url;
    }
    this.closedByClient = false;

    await this.openSocket();
    await this.requestInternal("auth.connect", { token: this.token }, false);
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Falha ao abrir websocket local."));
      };
      const onClose = () => {
        this.handleDisconnect();
      };
      const onMessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      socket.addEventListener("message", onMessage);
    });
  }

  private handleDisconnect(): void {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Websocket desconectado."));
    });
    this.pending.clear();

    if (this.closedByClient) {
      return;
    }

    this.initPromise = null;
    if (this.rdpEventListeners.size > 0 || this.rdpFrameListeners.size > 0 || this.listeners.size > 0) {
      window.setTimeout(() => {
        void this.init().catch(() => undefined);
      }, 500);
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw === "string") {
      this.handleTextMessage(raw);
      return;
    }
    if (raw instanceof ArrayBuffer) {
      this.handleBinaryMessage(raw);
    }
  }

  private handleTextMessage(text: string): void {
    let parsed: SocketResponsePayload | SocketEventPayload;
    try {
      parsed = JSON.parse(text) as SocketResponsePayload | SocketEventPayload;
    } catch {
      return;
    }

    if (parsed.kind === "response") {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      window.clearTimeout(pending.timeout);
      if (parsed.ok) {
        pending.resolve(parsed.result);
      } else {
        pending.reject(new Error(parsed.error || "Falha na requisicao websocket."));
      }
      return;
    }

    const listeners = this.listeners.get(parsed.event);
    if (listeners) {
      listeners.forEach((listener) => listener(parsed.payload));
    }

    if (parsed.event === "rdp.stream.event") {
      const rdpEvent = parsed.payload as RdpStreamEvent;
      const sessionId = (rdpEvent as { data?: { session_id?: string } }).data?.session_id;
      if (!sessionId) {
        return;
      }

      this.latestRdpEventBySession.set(sessionId, rdpEvent);
      const sessionListeners = this.rdpEventListeners.get(sessionId);
      if (sessionListeners) {
        sessionListeners.forEach((listener) => listener(rdpEvent));
      }
    }
  }

  private handleBinaryMessage(binary: ArrayBuffer): void {
    const bytes = new Uint8Array(binary);
    if (bytes.byteLength < WS_HEADER_SIZE) {
      return;
    }

    const hasMagic =
      bytes[0] === WS_BINARY_MAGIC[0] &&
      bytes[1] === WS_BINARY_MAGIC[1] &&
      bytes[2] === WS_BINARY_MAGIC[2] &&
      bytes[3] === WS_BINARY_MAGIC[3];
    if (!hasMagic || bytes[4] !== 1) {
      return;
    }

    const messageType = bytes[5];
    if (messageType !== WS_BINARY_MESSAGE_RDP_FRAME) {
      return;
    }

    const sessionLength = bytes[6];
    const payloadSize = new DataView(binary).getUint32(8, true);
    const sessionOffset = WS_HEADER_SIZE;
    const payloadOffset = sessionOffset + sessionLength;
    if (payloadOffset + payloadSize > bytes.byteLength) {
      return;
    }

    const sessionBytes = bytes.slice(sessionOffset, payloadOffset);
    const sessionId = new TextDecoder().decode(sessionBytes);
    if (!sessionId) {
      return;
    }

    const payload = bytes.slice(payloadOffset, payloadOffset + payloadSize).buffer;
    const frameListeners = this.rdpFrameListeners.get(sessionId);
    if (frameListeners) {
      frameListeners.forEach((listener) =>
        listener({
          sessionId,
          payload,
        }),
      );
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return await this.requestInternal<T>(method, params, true);
  }

  private async requestInternal<T>(method: string, params: unknown, ensureInit: boolean): Promise<T> {
    if (ensureInit) {
      await this.init();
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Websocket indisponivel.");
    }

    const id = this.createId("ws");
    const payload: SocketRequestPayload = {
      id,
      method,
      params,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Tempo limite de requisicao websocket atingido."));
      }, 20_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.socket?.send(JSON.stringify(payload));
    });
  }

  onEvent(event: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(event) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      const current = this.listeners.get(event);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  subscribeRdpStream(
    sessionId: string,
    handlers: {
      onEvent?: RdpEventListener;
      onFrame?: RdpFrameListener;
    },
  ): () => void {
    if (handlers.onEvent) {
      const listeners = this.rdpEventListeners.get(sessionId) ?? new Set<RdpEventListener>();
      listeners.add(handlers.onEvent);
      this.rdpEventListeners.set(sessionId, listeners);

      const latest = this.latestRdpEventBySession.get(sessionId);
      if (latest) {
        handlers.onEvent(latest);
      }
    }

    if (handlers.onFrame) {
      const listeners = this.rdpFrameListeners.get(sessionId) ?? new Set<RdpFrameListener>();
      listeners.add(handlers.onFrame);
      this.rdpFrameListeners.set(sessionId, listeners);
    }

    return () => {
      if (handlers.onEvent) {
        const listeners = this.rdpEventListeners.get(sessionId);
        listeners?.delete(handlers.onEvent);
        if (listeners && listeners.size === 0) {
          this.rdpEventListeners.delete(sessionId);
        }
      }

      if (handlers.onFrame) {
        const listeners = this.rdpFrameListeners.get(sessionId);
        listeners?.delete(handlers.onFrame);
        if (listeners && listeners.size === 0) {
          this.rdpFrameListeners.delete(sessionId);
        }
      }
    };
  }

  close(): void {
    this.closedByClient = true;
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Websocket encerrado."));
    });
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.initPromise = null;
  }

  private createId(prefix: string): string {
    const random = Math.random().toString(36).slice(2, 10);
    const now = Date.now().toString(36);
    return `${prefix}_${now}_${random}`;
  }
}

const backendSocketClient = new BackendSocketClient();

export async function initializeBackendSocket(): Promise<void> {
  await backendSocketClient.init();
}

export async function backendSocketRequest<T>(method: string, params?: unknown): Promise<T> {
  return await backendSocketClient.request<T>(method, params);
}

export function onBackendSocketEvent(event: string, listener: EventListener): () => void {
  return backendSocketClient.onEvent(event, listener);
}

export function subscribeRdpStreamSocket(
  sessionId: string,
  handlers: {
    onEvent?: RdpEventListener;
    onFrame?: RdpFrameListener;
  },
): () => void {
  return backendSocketClient.subscribeRdpStream(sessionId, handlers);
}

export async function rdpSocketStart(params: {
  profileId: string;
  width?: number;
  height?: number;
  passwordOverride?: string | null;
  keychainIdOverride?: string | null;
  saveAuthChoice?: boolean;
  preferredCodec?: RdpFrameCodec;
}): Promise<RdpStreamStartResult> {
  return await backendSocketRequest<RdpStreamStartResult>("rdp.stream.start", {
    profile_id: params.profileId,
    width: params.width,
    height: params.height,
    password_override: params.passwordOverride,
    keychain_id_override: params.keychainIdOverride,
    save_auth_choice: params.saveAuthChoice,
    preferred_codec: params.preferredCodec,
  });
}

export async function rdpSocketInput(sessionId: string, inputActions: RdpInputAction[]): Promise<void> {
  await backendSocketRequest<void>("rdp.stream.input", {
    session_id: sessionId,
    input_actions: inputActions,
  });
}

export async function rdpSocketControl(
  sessionId: string,
  control: {
    viewport?: { width: number; height: number } | null;
    active?: boolean | null;
    pointer_inside?: boolean | null;
  },
): Promise<void> {
  await backendSocketRequest<void>("rdp.stream.control", {
    session_id: sessionId,
    control,
  });
}

export async function rdpSocketStop(sessionId: string): Promise<void> {
  await backendSocketRequest<void>("rdp.stream.stop", {
    session_id: sessionId,
  });
}
