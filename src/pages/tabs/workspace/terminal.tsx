import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RefreshCw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";

import type { TerminalBlock } from "./types";
import type { WorkspaceBlockModule } from "./block-module";
import type { SurfaceRect } from "@/types/termopen";

function terminalDisconnectedLabel(sessionId: string | null): string {
  if (!sessionId) {
    return "Sessao pendente";
  }
  return `${sessionId} (desconectada)`;
}
export interface TerminalBlockViewProps {
  block: TerminalBlock;
  sessionOptions: Array<{ id: string; label: string }>;
  useBackendCaptureInput?: boolean;
  captureUnavailableMessage?: string | null;
  onCaptureContextChange?: (context: {
    surface_rect: SurfaceRect;
    dpi_scale: number;
    cols: number;
    rows: number;
  } | null) => void;
  onSessionChange: (sessionId: string) => void;
  ensureSessionListeners: (sessionId: string) => Promise<void>;
  sshWrite: (sessionId: string, data: string) => Promise<void>;
  onTrustHost: () => void;
  onRetry: () => void;
  onPasswordDraftChange: (value: string) => void;
  onSavePasswordChange: (checked: boolean) => void;
  onSubmitPassword: () => void;
}

type TerminalCaptureContext = {
  surface_rect: SurfaceRect;
  dpi_scale: number;
  cols: number;
  rows: number;
};

function areSurfaceRectsEqual(left: SurfaceRect, right: SurfaceRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function areCaptureContextsEqual(
  left: TerminalCaptureContext | null,
  right: TerminalCaptureContext | null,
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    areSurfaceRectsEqual(left.surface_rect, right.surface_rect) &&
    left.dpi_scale === right.dpi_scale &&
    left.cols === right.cols &&
    left.rows === right.rows
  );
}

export function TerminalBlockView({
  block,
  sessionOptions,
  useBackendCaptureInput,
  captureUnavailableMessage,
  onCaptureContextChange,
  onSessionChange,
  ensureSessionListeners,
  sshWrite,
  onTrustHost,
  onRetry,
  onPasswordDraftChange,
  onSavePasswordChange,
  onSubmitPassword,
}: TerminalBlockViewProps) {
  const { sessionId } = block;
  const selectableSessions = useMemo(() => {
    if (!sessionId) {
      return [{ id: "", label: terminalDisconnectedLabel(null) }, ...sessionOptions];
    }
    if (sessionOptions.some((option) => option.id === sessionId)) {
      return sessionOptions;
    }
    return [{ id: sessionId, label: terminalDisconnectedLabel(sessionId) }, ...sessionOptions];
  }, [sessionId, sessionOptions]);
  const buffer = useAppStore((state) => (sessionId ? state.sessionBuffers[sessionId] ?? "" : ""));
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const captureContextRef = useRef<TerminalCaptureContext | null>(null);
  const onCaptureContextChangeRef = useRef(onCaptureContextChange);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const hasLiveSession = !!sessionId && sessionOptions.some((option) => option.id === sessionId);
  const isConnected = block.connectStage === "ready" && hasLiveSession;

  useEffect(() => {
    onCaptureContextChangeRef.current = onCaptureContextChange;
  }, [onCaptureContextChange]);

  const publishCaptureContext = useCallback((context: TerminalCaptureContext | null) => {
    const callback = onCaptureContextChangeRef.current;
    if (!callback) {
      captureContextRef.current = context;
      return;
    }
    if (areCaptureContextsEqual(captureContextRef.current, context)) {
      return;
    }
    captureContextRef.current = context;
    callback(context);
  }, []);

  const emitCaptureContext = useCallback(() => {
    if (!isConnected || !sessionId) {
      publishCaptureContext(null);
      return;
    }
    const host = hostRef.current;
    const term = termRef.current;
    if (!host || !term) {
      publishCaptureContext(null);
      return;
    }
    const bounds = host.getBoundingClientRect();
    publishCaptureContext({
      surface_rect: {
        x: bounds.left,
        y: bounds.top,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      },
      dpi_scale: window.devicePixelRatio || 1,
      cols: Math.max(1, term.cols),
      rows: Math.max(1, term.rows),
    });
  }, [isConnected, publishCaptureContext, sessionId]);

  const safeResize = useCallback(() => {
    if (!sessionId) {
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) {
      return;
    }
    fit.fit();
    void api.sshResize(sessionId, term.cols, term.rows).catch(() => undefined);
    emitCaptureContext();
  }, [emitCaptureContext, sessionId]);

  useEffect(() => {
    emitCaptureContext();
  }, [emitCaptureContext]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    void ensureSessionListeners(sessionId);
  }, [ensureSessionListeners, isConnected, sessionId]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#a855f7",
        black: "#09090b",
        red: "#f43f5e",
        green: "#4ade80",
        yellow: "#f59e0b",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#fb7185",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();

    const onContextMenu = (event: globalThis.MouseEvent) => {
      event.preventDefault();
    };
    host.addEventListener("contextmenu", onContextMenu);

    termRef.current = terminal;
    fitRef.current = fitAddon;
    writtenRef.current = 0;

    void api.sshResize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
    emitCaptureContext();
    void sshWrite(sessionId, "");

    return () => {
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      publishCaptureContext(null);
      host.removeEventListener("contextmenu", onContextMenu);
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, [
    emitCaptureContext,
    isConnected,
    sessionId,
    publishCaptureContext,
    sshWrite,
  ]);

  useEffect(() => {
    inputDisposableRef.current?.dispose();
    inputDisposableRef.current = null;
    if (!sessionId || !isConnected) {
      return;
    }
    const terminal = termRef.current;
    if (!terminal) {
      return;
    }
    if (useBackendCaptureInput) {
      return;
    }
    inputDisposableRef.current = terminal.onData((value) => {
      void sshWrite(sessionId, value);
    });
    return () => {
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
    };
  }, [isConnected, sessionId, sshWrite, useBackendCaptureInput]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }
    const term = termRef.current;
    if (!term) {
      return;
    }
    if (buffer.length < writtenRef.current) {
      writtenRef.current = 0;
    }
    const delta = buffer.slice(writtenRef.current);
    if (delta.length > 0) {
      term.write(delta);
      writtenRef.current = buffer.length;
    }
  }, [buffer]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const timer = window.setInterval(() => {
      void sshWrite(sessionId, "");
    }, 180);
    return () => window.clearInterval(timer);
  }, [isConnected, sessionId, sshWrite]);

  useEffect(() => {
    if (!sessionId || !isConnected) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => safeResize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [isConnected, safeResize, sessionId]);

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background p-1.5">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-border/50 bg-background">
        <div className="flex h-9 items-center gap-2 border-b border-border/50 px-2">
          <TerminalSquare className="h-4 w-4 text-primary" />
          <select
            className="h-7 min-w-[220px] rounded border border-border/50 bg-background px-2 text-xs text-foreground"
            value={sessionId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                onSessionChange(event.target.value);
              }
            }}
          >
            {selectableSessions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden px-1 py-1">
          <div ref={hostRef} className={cn("h-full w-full overflow-hidden", !isConnected ? "opacity-40" : "")} />
          {isConnected && captureUnavailableMessage ? (
            <div className="absolute left-3 right-3 top-3 z-20 rounded border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {captureUnavailableMessage}
            </div>
          ) : null}
          {!isConnected ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-3">
              <div className="w-full max-w-md rounded-lg border border-border/60 bg-background/95 p-4 shadow-2xl shadow-black/20">
                <div className="inline-flex items-center gap-2 text-sm text-foreground">
                  {block.connectStage === "connecting" ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <TerminalSquare className="h-4 w-4 text-primary" />
                  )}
                  <span>{block.connectMessage}</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <p className={cn(block.connectStage === "connecting" ? "text-primary" : undefined)}>1. Conectando...</p>
                  <p className={cn(block.connectStage === "verifying_fingerprint" ? "text-primary" : undefined)}>
                    2. Verificando fingerprint...
                  </p>
                  <p
                    className={cn(
                      block.connectStage === "awaiting_password" || block.connectStage === "error"
                        ? "text-primary"
                        : undefined,
                    )}
                  >
                    3. Logando...
                  </p>
                </div>

                {block.connectStage === "verifying_fingerprint" && block.hostChallenge ? (
                  <div className="mt-3 rounded border border-border/50 bg-secondary/70 p-3 text-xs text-foreground/90">
                    <p className="font-medium text-foreground">{block.hostChallenge.message}</p>
                    <p className="mt-1">
                      {block.hostChallenge.host}:{block.hostChallenge.port}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      {block.hostChallenge.keyType} {block.hostChallenge.fingerprint}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                        onClick={onTrustHost}
                      >
                        Confiar e continuar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/70 px-2 py-1 text-xs text-foreground/90 hover:bg-secondary"
                        onClick={onRetry}
                      >
                        Tentar novamente
                      </button>
                    </div>
                  </div>
                ) : null}

                {(block.connectStage === "awaiting_password" || block.connectStage === "error") &&
                block.pendingProfileId ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      value={block.passwordDraft}
                      className="h-9 w-full rounded border border-border/60 bg-secondary/70 px-2 text-sm text-foreground outline-none focus:border-primary/60"
                      placeholder="Senha SSH"
                      onChange={(event) => onPasswordDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          onSubmitPassword();
                        }
                      }}
                    />
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={block.savePasswordChoice}
                        onChange={(event) => onSavePasswordChange(event.target.checked)}
                      />
                      Salvar senha no perfil
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                        onClick={onSubmitPassword}
                      >
                        Logar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/70 px-2 py-1 text-xs text-foreground/90 hover:bg-secondary"
                        onClick={onRetry}
                      >
                        Repetir conexao
                      </button>
                    </div>
                  </div>
                ) : null}

                {block.retryInSeconds !== null ? (
                  <p className="mt-3 text-xs text-amber-300">Timeout detectado. Nova tentativa em {block.retryInSeconds}s...</p>
                ) : null}

                {block.connectError ? (
                  <p className="mt-3 text-xs text-red-300">{block.connectError}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const terminalWorkspaceModule: WorkspaceBlockModule<TerminalBlockViewProps> = {
  name: "terminal",
  description: "Bloco de terminal remoto/local com estágios de conexão.",
  render: (props) => <TerminalBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `Terminal não encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no terminal (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, value }) => `Sessão selecionada no terminal [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do terminal atualizado (${action}) [${blockId}] => ${status}`,
};

export default terminalWorkspaceModule;


