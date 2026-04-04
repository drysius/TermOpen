import { Monitor, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useT } from "@/langs";
import { cn } from "@/lib/utils";
import type {
  ConnectionProfile,
  RdpSessionFocusInput,
} from "@/types/openptl";
import {
  onRdpCursor,
  onRdpVideoRects,
} from "@/pages/tabs/workspace/natives/rdp-stream";

import type { RdpBlock } from "./types";
import type { WorkspaceBlockModule } from "./block-module";

export interface RdpBlockViewProps {
  block: RdpBlock;
  active: boolean;
  profiles: ConnectionProfile[];
  captureUnavailableMessage?: string | null;
  onFocus: () => void;
  onProfileChange: (profileId: string) => void;
  onFocusChange: (focus: RdpSessionFocusInput) => void;
  onRetry: () => void;
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

interface CursorState {
  kind: "default" | "hidden" | "position" | "bitmap";
  x: number;
  y: number;
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  bitmap: Uint8ClampedArray | null;
}

const EMPTY_CURSOR: CursorState = {
  kind: "default",
  x: 0,
  y: 0,
  hotspotX: 0,
  hotspotY: 0,
  width: 0,
  height: 0,
  bitmap: null,
};

export function RdpBlockView({
  block,
  active,
  profiles,
  captureUnavailableMessage,
  onFocus,
  onProfileChange,
  onFocusChange,
  onRetry,
  onPasswordDraftChange,
  onSavePasswordChange,
  onSubmitPassword,
}: RdpBlockViewProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<CursorState>(EMPTY_CURSOR);
  const drawRectRef = useRef({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  });
  const isConnected = block.connectStage === "ready" && block.imageWidth > 0 && block.imageHeight > 0;

  const ensureSurface = useCallback((width: number, height: number): HTMLCanvasElement | null => {
    if (width <= 0 || height <= 0) {
      return null;
    }
    const current = surfaceCanvasRef.current ?? document.createElement("canvas");
    if (current.width !== width || current.height !== height) {
      current.width = width;
      current.height = height;
      const context = current.getContext("2d");
      if (context) {
        context.fillStyle = "#000000";
        context.fillRect(0, 0, width, height);
      }
    }
    surfaceCanvasRef.current = current;
    return current;
  }, []);

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

    context.fillStyle = "#09090b";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const surface = surfaceCanvasRef.current;
    if (surface && block.imageWidth > 0 && block.imageHeight > 0) {
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
      context.drawImage(surface, offsetX, offsetY, drawWidth, drawHeight);

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
  }, [block.imageHeight, block.imageWidth]);

  useEffect(() => {
    const detachVideo = onRdpVideoRects(({ blockId, packet }) => {
      if (blockId !== block.id) {
        return;
      }

      const surface = ensureSurface(packet.width, packet.height);
      if (!surface) {
        return;
      }
      const context = surface.getContext("2d");
      if (!context) {
        return;
      }

      for (const rect of packet.rects) {
        const expectedSize = rect.width * rect.height * 4;
        if (rect.pixels.byteLength < expectedSize) {
          continue;
        }
        const rgbaPixels = new Uint8ClampedArray(rect.pixels);
        for (let index = 0; index + 3 < rgbaPixels.length; index += 4) {
          const blue = rgbaPixels[index];
          rgbaPixels[index] = rgbaPixels[index + 2];
          rgbaPixels[index + 2] = blue;
        }
        context.putImageData(new ImageData(rgbaPixels, rect.width, rect.height), rect.x, rect.y);
      }

      if (packet.frameEnd) {
        drawFrame();
      }
    });

    const detachCursor = onRdpCursor(({ blockId, packet }) => {
      if (blockId !== block.id) {
        return;
      }

      if (packet.kind === "default" || packet.kind === "hidden") {
        cursorRef.current = {
          ...EMPTY_CURSOR,
          kind: packet.kind,
        };
      } else if (packet.kind === "position") {
        cursorRef.current = {
          ...cursorRef.current,
          kind: "position",
          x: packet.x,
          y: packet.y,
        };
      } else {
        const previous = cursorRef.current;
        const fallbackToPrevious =
          packet.x === 0 &&
          packet.y === 0 &&
          (previous.x !== 0 || previous.y !== 0);
        cursorRef.current = {
          kind: "bitmap",
          // Some servers emit bitmap with stale/zero position; fallback keeps continuity.
          x: fallbackToPrevious ? previous.x : packet.x,
          y: fallbackToPrevious ? previous.y : packet.y,
          hotspotX: packet.hotspotX,
          hotspotY: packet.hotspotY,
          width: packet.width,
          height: packet.height,
          bitmap: packet.bitmap ? new Uint8ClampedArray(packet.bitmap) : null,
        };
      }
      drawFrame();
    });

    return () => {
      detachVideo();
      detachCursor();
    };
  }, [block.id, drawFrame, ensureSurface]);

  useEffect(() => {
    drawFrame();
  }, [drawFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(() => {
      drawFrame();
      const bounds = canvas.getBoundingClientRect();
      onFocusChange({
        focused: active,
        viewport_rect: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.floor(canvas.clientWidth)),
          height: Math.max(1, Math.floor(canvas.clientHeight)),
        },
        surface_rect: {
          x: bounds.left,
          y: bounds.top,
          width: Math.max(1, bounds.width),
          height: Math.max(1, bounds.height),
        },
        dpi_scale: window.devicePixelRatio || 1,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, drawFrame, onFocusChange]);

  const emitFocusedState = useCallback((focused: boolean) => {
    const canvas = canvasRef.current;
    const bounds = canvas?.getBoundingClientRect();
    onFocusChange({
      focused,
      viewport_rect: canvas
        ? {
            x: 0,
            y: 0,
            width: Math.max(1, Math.floor(canvas.clientWidth)),
            height: Math.max(1, Math.floor(canvas.clientHeight)),
          }
        : null,
      surface_rect: bounds
        ? {
            x: bounds.left,
            y: bounds.top,
            width: Math.max(1, bounds.width),
            height: Math.max(1, bounds.height),
          }
        : null,
      dpi_scale: window.devicePixelRatio || 1,
    });
  }, [onFocusChange]);

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      onFocus();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      emitFocusedState(true);
    },
    [emitFocusedState, onFocus],
  );

  const handleCanvasWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>) => {
      if (isConnected) {
        event.preventDefault();
      }
    },
    [isConnected],
  );

  const statusMessage = block.connectMessage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/50 px-2 py-1.5">
        <select
          className="h-8 rounded border border-border/50 bg-background px-2 text-xs text-foreground"
          value={block.profileId}
          onChange={(event) => onProfileChange(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.host}:{profile.port})
            </option>
          ))}
        </select>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div
          className={cn(
            "relative h-full overflow-hidden rounded border bg-background",
            active
              ? "border-primary/45 shadow-[0_0_16px_hsl(var(--primary)/0.2)]"
              : "border-border/50",
          )}
        >
          <canvas
            ref={canvasRef}
            tabIndex={isConnected ? 0 : -1}
            className={cn(
              "h-full w-full outline-none",
              "cursor-default",
            )}
            onPointerDown={handleCanvasPointerDown}
            onPointerEnter={() => emitFocusedState(true)}
            onPointerLeave={() => emitFocusedState(false)}
            onFocus={() => emitFocusedState(true)}
            onBlur={() => emitFocusedState(false)}
            onWheel={handleCanvasWheel}
            onContextMenu={(event) => event.preventDefault()}
          />

          {isConnected && captureUnavailableMessage ? (
            <div className="absolute left-3 right-3 top-3 z-20 rounded border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {captureUnavailableMessage}
            </div>
          ) : null}

          {!isConnected ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3">
              <div className="w-full max-w-md rounded-lg border border-border/60 bg-background/95 p-4 shadow-2xl shadow-black/20">
                <div className="inline-flex items-center gap-2 text-sm text-foreground">
                  {block.connectStage === "connecting" ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <Monitor className="h-4 w-4 text-primary" />
                  )}
                  <span>{statusMessage}</span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <p className={cn(block.connectStage === "connecting" ? "text-primary" : undefined)}>1. {t.workspace.rdp.connecting}</p>
                  <p className={cn(block.connectStage === "awaiting_password" ? "text-primary" : undefined)}>
                    2. {t.workspace.rdp.authRequired}
                  </p>
                  <p className={cn(block.connectStage === "error" ? "text-primary" : undefined)}>3. {t.workspace.rdp.error}</p>
                </div>

                {(block.connectStage === "awaiting_password" || block.connectStage === "error") ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      value={block.passwordDraft}
                      className="h-9 w-full rounded border border-border/60 bg-secondary/70 px-2 text-sm text-foreground outline-none focus:border-primary/60"
                      placeholder={t.workspace.rdp.passwordPlaceholder}
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
                        {t.workspace.rdp.applyPassword}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/70 px-2 py-1 text-xs text-foreground/90 hover:bg-secondary"
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

      <div className="flex h-8 items-center gap-4 border-t border-border/50 px-3 text-[11px] text-muted-foreground">
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
  description: "Bloco de transmissao RDP por dirty rects e cursor dedicado.",
  render: (props) => <RdpBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `RDP nao encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no RDP (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `RDP dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do RDP atualizado (${action}) [${blockId}] => ${status}`,
};

export default rdpWorkspaceModule;
