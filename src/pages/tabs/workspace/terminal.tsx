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

function terminalDisconnectedLabel(sessionId: string | null): string {
  if (!sessionId) {
    return "Sessao pendente";
  }
  return `${sessionId} (desconectada)`;
}
export interface TerminalBlockViewProps {
  block: TerminalBlock;
  sessionOptions: Array<{ id: string; label: string }>;
  onSessionChange: (sessionId: string) => void;
  ensureSessionListeners: (sessionId: string) => Promise<void>;
  sshWrite: (sessionId: string, data: string) => Promise<void>;
  onTrustHost: () => void;
  onRetry: () => void;
  onPasswordDraftChange: (value: string) => void;
  onSavePasswordChange: (checked: boolean) => void;
  onSubmitPassword: () => void;
}

export function TerminalBlockView({
  block,
  sessionOptions,
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
  const settings = useAppStore((state) => state.settings);
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
  const isConnected = block.connectStage === "ready" && !!sessionId;

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
  }, [sessionId]);

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

    const selectionDisposable = settings.terminal_copy_on_select
      ? terminal.onSelectionChange(() => {
          const selection = terminal.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => undefined);
          }
        })
      : null;

    const onContextMenu = (event: globalThis.MouseEvent) => {
      if (!settings.terminal_right_click_paste) {
        return;
      }
      event.preventDefault();
      void navigator.clipboard.readText().then((value) => {
        if (value) {
          void sshWrite(sessionId, value);
        }
      });
    };
    host.addEventListener("contextmenu", onContextMenu);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      if (!settings.terminal_ctrl_shift_shortcuts) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "c") {
        const selection = terminal.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
        }
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        void navigator.clipboard.readText().then((value) => {
          if (value) {
            void sshWrite(sessionId, value);
          }
        });
        return false;
      }
      return true;
    });

    const disposable = terminal.onData((data) => {
      void sshWrite(sessionId, data);
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;
    writtenRef.current = 0;

    void api.sshResize(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
    void sshWrite(sessionId, "");

    return () => {
      disposable.dispose();
      selectionDisposable?.dispose();
      host.removeEventListener("contextmenu", onContextMenu);
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, [
    isConnected,
    sessionId,
    settings.terminal_copy_on_select,
    settings.terminal_ctrl_shift_shortcuts,
    settings.terminal_right_click_paste,
    sshWrite,
  ]);

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
    <div className="h-full min-h-0 overflow-hidden bg-zinc-950 p-1.5">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-white/10 bg-zinc-950">
        <div className="flex h-9 items-center gap-2 border-b border-white/10 px-2">
          <TerminalSquare className="h-4 w-4 text-cyan-300" />
          <select
            className="h-7 min-w-[220px] rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100"
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
          {!isConnected ? (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 p-3">
              <div className="w-full max-w-md rounded-lg border border-white/15 bg-zinc-950/95 p-4 shadow-2xl shadow-black/50">
                <div className="inline-flex items-center gap-2 text-sm text-zinc-100">
                  {block.connectStage === "connecting" ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
                  ) : (
                    <TerminalSquare className="h-4 w-4 text-cyan-300" />
                  )}
                  <span>{block.connectMessage}</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <p className={cn(block.connectStage === "connecting" ? "text-cyan-300" : undefined)}>1. Conectando...</p>
                  <p className={cn(block.connectStage === "verifying_fingerprint" ? "text-cyan-300" : undefined)}>
                    2. Verificando fingerprint...
                  </p>
                  <p
                    className={cn(
                      block.connectStage === "awaiting_password" || block.connectStage === "error"
                        ? "text-cyan-300"
                        : undefined,
                    )}
                  >
                    3. Logando...
                  </p>
                </div>

                {block.connectStage === "verifying_fingerprint" && block.hostChallenge ? (
                  <div className="mt-3 rounded border border-white/10 bg-zinc-900/70 p-3 text-xs text-zinc-300">
                    <p className="font-medium text-zinc-100">{block.hostChallenge.message}</p>
                    <p className="mt-1">
                      {block.hostChallenge.host}:{block.hostChallenge.port}
                    </p>
                    <p className="mt-1 break-all text-zinc-400">
                      {block.hostChallenge.keyType} {block.hostChallenge.fingerprint}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-cyan-400/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20"
                        onClick={onTrustHost}
                      >
                        Confiar e continuar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
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
                      className="h-9 w-full rounded border border-white/15 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60"
                      placeholder="Senha SSH"
                      onChange={(event) => onPasswordDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          onSubmitPassword();
                        }
                      }}
                    />
                    <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
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
                        className="rounded border border-cyan-400/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20"
                        onClick={onSubmitPassword}
                      >
                        Logar
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
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


