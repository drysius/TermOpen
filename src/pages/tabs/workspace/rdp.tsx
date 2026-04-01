import { Monitor, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useT } from "@/langs";
import { cn } from "@/lib/utils";
import type { ConnectionProfile, RdpInputAction, StreamControlInput } from "@/types/termopen";

import type { RdpBlock } from "./types";
import type { WorkspaceBlockModule } from "./block-module";

export interface RdpBlockViewProps {
  block: RdpBlock;
  active: boolean;
  profiles: ConnectionProfile[];
  onFocus: () => void;
  onProfileChange: (profileId: string) => void;
  onRefresh: () => void;
  onInteract: (inputActions: RdpInputAction[]) => void;
  onControlChange: (control: StreamControlInput) => void;
  onRetry: () => void;
  onToggleAutoRefresh: () => void;
  onPasswordDraftChange: (value: string) => void;
  onSavePasswordChange: (checked: boolean) => void;
  onSubmitPassword: () => void;
}

function formatCapturedAt(timestamp: number | null): string {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp * 1000).toLocaleString();
}

export function RdpBlockView({
  block,
  active,
  profiles,
  onFocus,
  onProfileChange,
  onRefresh,
  onInteract,
  onControlChange,
  onRetry,
  onToggleAutoRefresh,
  onPasswordDraftChange,
  onSavePasswordChange,
  onSubmitPassword,
}: RdpBlockViewProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameImageRef = useRef<HTMLImageElement | null>(null);
  const drawRectRef = useRef({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  const lastMoveSentAtRef = useRef(0);
  const [localPointer, setLocalPointer] = useState<{ x: number; y: number } | null>(null);
  const isConnected = block.connectStage === "ready" && !!block.imageUrl;
  const emitControlWithViewport = useCallback(
    (control: StreamControlInput) => {
      const canvas = canvasRef.current;
      const viewport = canvas
        ? {
            width: Math.max(1, Math.floor(canvas.clientWidth)),
            height: Math.max(1, Math.floor(canvas.clientHeight)),
          }
        : null;
      onControlChange({
        ...control,
        viewport,
      });
    },
    [onControlChange],
  );

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
    const cssHeight = Math.max(1, Math.floor(canvas.clientHeight));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const renderWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const renderHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#09090b";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const frame = frameImageRef.current;
    if (frame && block.imageWidth > 0 && block.imageHeight > 0) {
      const scale = Math.min(canvas.width / block.imageWidth, canvas.height / block.imageHeight);
      const drawWidth = Math.max(1, Math.floor(block.imageWidth * scale));
      const drawHeight = Math.max(1, Math.floor(block.imageHeight * scale));
      const offsetX = Math.floor((canvas.width - drawWidth) / 2);
      const offsetY = Math.floor((canvas.height - drawHeight) / 2);

      drawRectRef.current = {
        x: offsetX,
        y: offsetY,
        width: drawWidth,
        height: drawHeight,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };

      context.imageSmoothingEnabled = false;
      context.drawImage(frame, offsetX, offsetY, drawWidth, drawHeight);

      if (localPointer) {
        const normalizedX = block.imageWidth > 1 ? localPointer.x / (block.imageWidth - 1) : 0;
        const normalizedY = block.imageHeight > 1 ? localPointer.y / (block.imageHeight - 1) : 0;
        const pointerX = offsetX + normalizedX * drawWidth;
        const pointerY = offsetY + normalizedY * drawHeight;

        context.save();
        context.strokeStyle = "rgba(34, 211, 238, 0.85)";
        context.fillStyle = "rgba(34, 211, 238, 0.18)";
        context.lineWidth = Math.max(1.5, dpr);
        context.beginPath();
        context.arc(pointerX, pointerY, Math.max(4, dpr * 3), 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }
      return;
    }

    drawRectRef.current = {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  }, [block.imageHeight, block.imageWidth, localPointer]);

  useEffect(() => {
    if (!block.imageUrl) {
      frameImageRef.current = null;
      drawFrame();
      return;
    }

    const frame = new Image();
    frame.onload = () => {
      frameImageRef.current = frame;
      drawFrame();
    };
    frame.src = block.imageUrl;
  }, [block.imageUrl, drawFrame]);

  useEffect(() => {
    drawFrame();
  }, [drawFrame, localPointer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(() => {
      drawFrame();
      emitControlWithViewport({});
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawFrame, emitControlWithViewport]);

  const mapClientToRemote = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || block.imageWidth <= 0 || block.imageHeight <= 0) {
        return null;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const canvasX = ((clientX - rect.left) / rect.width) * canvas.width;
      const canvasY = ((clientY - rect.top) / rect.height) * canvas.height;
      const drawRect = drawRectRef.current;
      const drawWidth = Math.max(1, drawRect.width);
      const drawHeight = Math.max(1, drawRect.height);

      const normalizedX = (canvasX - drawRect.x) / drawWidth;
      const normalizedY = (canvasY - drawRect.y) / drawHeight;
      const clampedX = Math.max(0, Math.min(1, normalizedX));
      const clampedY = Math.max(0, Math.min(1, normalizedY));

      const x = Math.round(clampedX * Math.max(0, block.imageWidth - 1));
      const y = Math.round(clampedY * Math.max(0, block.imageHeight - 1));
      return { x, y };
    },
    [block.imageHeight, block.imageWidth],
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      onFocus();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();

      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (!remotePoint) {
        return;
      }
      setLocalPointer(remotePoint);
      emitControlWithViewport({
        active: true,
        pointer_inside: true,
      });

      if (!isConnected) {
        return;
      }

      const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      onInteract([
        {
          kind: "mouse_click",
          x: remotePoint.x,
          y: remotePoint.y,
          button,
          double_click: event.detail >= 2,
        },
      ]);
    },
    [emitControlWithViewport, isConnected, mapClientToRemote, onFocus, onInteract],
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (!remotePoint) {
        return;
      }
      setLocalPointer(remotePoint);

      if (!isConnected || event.buttons === 0) {
        return;
      }

      const now = Date.now();
      if (now - lastMoveSentAtRef.current < 180) {
        return;
      }
      lastMoveSentAtRef.current = now;
      onInteract([
        {
          kind: "mouse_move",
          x: remotePoint.x,
          y: remotePoint.y,
        },
      ]);
    },
    [isConnected, mapClientToRemote, onInteract],
  );

  const handleCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      if (!isConnected) {
        return;
      }

      const actionKey =
        event.key.length === 1 ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.code.startsWith("F") ||
        event.key === "Enter" ||
        event.key === "Backspace" ||
        event.key === "Tab" ||
        event.key === "Escape" ||
        event.key.startsWith("Arrow") ||
        event.key === "Delete" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown";

      if (!actionKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      emitControlWithViewport({
        active: true,
        pointer_inside: true,
      });
      onInteract([
        {
          kind: "key_press",
          code: event.code,
          text: event.key.length === 1 ? event.key : null,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        },
      ]);
    },
    [emitControlWithViewport, isConnected, onInteract],
  );

  const handleCanvasPointerEnter = useCallback(() => {
    emitControlWithViewport({
      pointer_inside: true,
      active: true,
    });
  }, [emitControlWithViewport]);

  const handleCanvasPointerLeave = useCallback(() => {
    setLocalPointer(null);
    emitControlWithViewport({
      pointer_inside: false,
      active: false,
    });
  }, [emitControlWithViewport]);

  const handleCanvasFocus = useCallback(() => {
    emitControlWithViewport({
      active: true,
      pointer_inside: true,
    });
  }, [emitControlWithViewport]);

  const handleCanvasBlur = useCallback(() => {
    emitControlWithViewport({
      active: false,
    });
  }, [emitControlWithViewport]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="grid grid-cols-[minmax(140px,1fr)_auto_auto] items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <select
          className="h-8 rounded border border-white/10 bg-zinc-950 px-2 text-xs text-zinc-100"
          value={block.profileId}
          onChange={(event) => onProfileChange(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.host}:{profile.port})
            </option>
          ))}
        </select>

        <button
          type="button"
          className={cn(
            "rounded border px-2 py-1 text-xs transition",
            block.autoRefresh
              ? "border-cyan-400/70 bg-cyan-500/15 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.35)]"
              : "border-white/15 text-zinc-300 hover:border-cyan-400/60",
          )}
          onClick={onToggleAutoRefresh}
        >
          {t.workspace.rdp.autoRefresh}
        </button>

        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded border border-cyan-400/50 bg-cyan-500/15 px-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
          onClick={onRefresh}
          disabled={block.connectStage === "connecting"}
        >
          {block.connectStage === "connecting" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Monitor className="h-3.5 w-3.5" />}
          {t.workspace.rdp.captureNow}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div
          className={cn(
            "relative h-full overflow-hidden rounded border bg-zinc-950",
            active
              ? "border-cyan-400/45 shadow-[0_0_16px_rgba(34,211,238,0.2)]"
              : "border-white/10",
          )}
        >
          <canvas
            ref={canvasRef}
            tabIndex={isConnected ? 0 : -1}
            className={cn(
              "h-full w-full outline-none",
              isConnected ? "cursor-crosshair" : "cursor-default",
            )}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerEnter={handleCanvasPointerEnter}
            onPointerLeave={handleCanvasPointerLeave}
            onFocus={handleCanvasFocus}
            onBlur={handleCanvasBlur}
            onKeyDown={handleCanvasKeyDown}
            onContextMenu={(event) => event.preventDefault()}
          />

          {!isConnected ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/80 p-3">
              <div className="w-full max-w-md rounded-lg border border-white/15 bg-zinc-950/95 p-4 shadow-2xl shadow-black/50">
                <div className="inline-flex items-center gap-2 text-sm text-zinc-100">
                  {block.connectStage === "connecting" ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-cyan-300" />
                  ) : (
                    <Monitor className="h-4 w-4 text-cyan-300" />
                  )}
                  <span>{block.connectMessage}</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <p className={cn(block.connectStage === "connecting" ? "text-cyan-300" : undefined)}>1. {t.workspace.rdp.connecting}</p>
                  <p className={cn(block.connectStage === "awaiting_password" ? "text-cyan-300" : undefined)}>
                    2. {t.workspace.rdp.authRequired}
                  </p>
                  <p className={cn(block.connectStage === "error" ? "text-cyan-300" : undefined)}>3. {t.workspace.rdp.error}</p>
                </div>

                {(block.connectStage === "awaiting_password" || block.connectStage === "error") ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      value={block.passwordDraft}
                      className="h-9 w-full rounded border border-white/15 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60"
                      placeholder={t.workspace.rdp.passwordPlaceholder}
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
                        {t.workspace.rdp.applyPassword}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        onClick={onRetry}
                      >
                        {t.workspace.rdp.retry}
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

      <div className="flex h-8 items-center gap-4 border-t border-white/10 px-3 text-[11px] text-zinc-400">
        <span>
          {t.workspace.rdp.lastFrame}: {formatCapturedAt(block.capturedAt)}
        </span>
        <span>
          {t.workspace.rdp.resolution}: {block.imageWidth > 0 && block.imageHeight > 0 ? `${block.imageWidth}x${block.imageHeight}` : "-"}
        </span>
      </div>
    </div>
  );
}

const rdpWorkspaceModule: WorkspaceBlockModule<RdpBlockViewProps> = {
  name: "rdp",
  description: "Bloco de transmissão RDP com interação de ponteiro e teclado.",
  render: (props) => <RdpBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `RDP não encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no RDP (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `RDP dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do RDP atualizado (${action}) [${blockId}] => ${status}`,
};

export default rdpWorkspaceModule;


