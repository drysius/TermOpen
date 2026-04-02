import { Monitor, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useT } from "@/langs";
import { cn } from "@/lib/utils";
import type {
  ConnectionProfile,
  RdpInputEvent,
  RdpSessionFocusInput,
} from "@/types/termopen";
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
  onFocus: () => void;
  onProfileChange: (profileId: string) => void;
  onInteract: (inputEvents: RdpInputEvent[]) => void;
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
  onFocus,
  onProfileChange,
  onInteract,
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
  const lastMoveSentAtRef = useRef(0);
  const pressedButtonsRef = useRef<Record<"left" | "right" | "middle", boolean>>({
    left: false,
    right: false,
    middle: false,
  });
  const lastInputPointerRef = useRef<{ x: number; y: number } | null>(null);
  const isConnected = block.connectStage === "ready" && block.imageWidth > 0 && block.imageHeight > 0;

  const pointerButtonToMouseButton = useCallback((button: number): "left" | "right" | "middle" | null => {
    if (button === 0) {
      return "left";
    }
    if (button === 1) {
      return "middle";
    }
    if (button === 2) {
      return "right";
    }
    return null;
  }, []);

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
      onFocusChange({
        focused: active,
        viewport_rect: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.floor(canvas.clientWidth)),
          height: Math.max(1, Math.floor(canvas.clientHeight)),
        },
        dpi_scale: window.devicePixelRatio || 1,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, drawFrame, onFocusChange]);

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

  const emitFocusedState = useCallback((focused: boolean) => {
    const canvas = canvasRef.current;
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
      dpi_scale: window.devicePixelRatio || 1,
    });
  }, [onFocusChange]);

  const rememberInputCursorPosition = useCallback((x: number, y: number) => {
    cursorRef.current = {
      ...cursorRef.current,
      x,
      y,
    };
  }, []);

  const resolveCurrentPointerPosition = useCallback((): { x: number; y: number } | null => {
    if (lastInputPointerRef.current) {
      return lastInputPointerRef.current;
    }
    if (block.imageWidth <= 0 || block.imageHeight <= 0) {
      return null;
    }
    const cursor = cursorRef.current;
    return {
      x: Math.max(0, Math.min(block.imageWidth - 1, cursor.x)),
      y: Math.max(0, Math.min(block.imageHeight - 1, cursor.y)),
    };
  }, [block.imageHeight, block.imageWidth]);

  const releaseAllPressedButtons = useCallback(() => {
    if (!isConnected) {
      pressedButtonsRef.current.left = false;
      pressedButtonsRef.current.right = false;
      pressedButtonsRef.current.middle = false;
      return;
    }

    const point = resolveCurrentPointerPosition();
    if (!point) {
      pressedButtonsRef.current.left = false;
      pressedButtonsRef.current.right = false;
      pressedButtonsRef.current.middle = false;
      return;
    }

    const events: RdpInputEvent[] = [];
    if (pressedButtonsRef.current.left) {
      events.push({ kind: "mouse_button_up", x: point.x, y: point.y, button: "left" });
      pressedButtonsRef.current.left = false;
    }
    if (pressedButtonsRef.current.middle) {
      events.push({ kind: "mouse_button_up", x: point.x, y: point.y, button: "middle" });
      pressedButtonsRef.current.middle = false;
    }
    if (pressedButtonsRef.current.right) {
      events.push({ kind: "mouse_button_up", x: point.x, y: point.y, button: "right" });
      pressedButtonsRef.current.right = false;
    }

    if (events.length > 0) {
      onInteract(events);
    }
  }, [isConnected, onInteract, resolveCurrentPointerPosition]);

  const hasPressedButtons = useCallback(() => {
    const pressed = pressedButtonsRef.current;
    return pressed.left || pressed.middle || pressed.right;
  }, []);

  useEffect(() => {
    return () => {
      releaseAllPressedButtons();
    };
  }, [releaseAllPressedButtons]);

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      onFocus();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures.
      }

      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (!remotePoint) {
        return;
      }
      lastInputPointerRef.current = remotePoint;
      rememberInputCursorPosition(remotePoint.x, remotePoint.y);
      emitFocusedState(true);

      if (!isConnected) {
        return;
      }

      const button = pointerButtonToMouseButton(event.button);
      if (!button) {
        return;
      }
      pressedButtonsRef.current[button] = true;
      onInteract([{ kind: "mouse_button_down", x: remotePoint.x, y: remotePoint.y, button }]);
    },
    [
      emitFocusedState,
      isConnected,
      mapClientToRemote,
      onFocus,
      onInteract,
      pointerButtonToMouseButton,
      rememberInputCursorPosition,
    ],
  );

  const handleCanvasPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (remotePoint) {
        lastInputPointerRef.current = remotePoint;
        rememberInputCursorPosition(remotePoint.x, remotePoint.y);
      }

      if (!isConnected || !remotePoint) {
        const button = pointerButtonToMouseButton(event.button);
        if (button) {
          pressedButtonsRef.current[button] = false;
        }
        return;
      }

      const button = pointerButtonToMouseButton(event.button);
      if (!button) {
        return;
      }

      pressedButtonsRef.current[button] = false;
      onInteract([{ kind: "mouse_button_up", x: remotePoint.x, y: remotePoint.y, button }]);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release failures.
      }
    },
    [isConnected, mapClientToRemote, onInteract, pointerButtonToMouseButton, rememberInputCursorPosition],
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (!remotePoint) {
        return;
      }
      lastInputPointerRef.current = remotePoint;
      rememberInputCursorPosition(remotePoint.x, remotePoint.y);

      if (!isConnected) {
        return;
      }

      const now = Date.now();
      if (now - lastMoveSentAtRef.current < 16) {
        return;
      }
      lastMoveSentAtRef.current = now;
      onInteract([
        {
          kind: "mouse_move",
          x: remotePoint.x,
          y: remotePoint.y,
          t_ms: now,
        },
      ]);
    },
    [isConnected, mapClientToRemote, onInteract, rememberInputCursorPosition],
  );

  const handleCanvasWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>) => {
      if (!isConnected) {
        return;
      }
      const remotePoint = mapClientToRemote(event.clientX, event.clientY);
      if (!remotePoint) {
        return;
      }
      event.preventDefault();
      lastInputPointerRef.current = remotePoint;
      rememberInputCursorPosition(remotePoint.x, remotePoint.y);
      onInteract([
        {
          kind: "mouse_scroll",
          x: remotePoint.x,
          y: remotePoint.y,
          delta_x: Math.round(event.deltaX),
          delta_y: Math.round(event.deltaY),
        },
      ]);
    },
    [isConnected, mapClientToRemote, onInteract, rememberInputCursorPosition],
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
      emitFocusedState(true);
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
    [emitFocusedState, isConnected, onInteract],
  );

  const statusMessage = block.connectMessage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="border-b border-white/10 px-2 py-1.5">
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
              "cursor-default",
            )}
            onPointerDown={handleCanvasPointerDown}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerUp}
            onPointerMove={handleCanvasPointerMove}
            onPointerEnter={() => emitFocusedState(true)}
            onPointerLeave={() => {
              lastInputPointerRef.current = null;
              if (!hasPressedButtons()) {
                emitFocusedState(false);
              }
            }}
            onFocus={() => emitFocusedState(true)}
            onBlur={() => {
              releaseAllPressedButtons();
              emitFocusedState(false);
            }}
            onWheel={handleCanvasWheel}
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
                  <span>{statusMessage}</span>
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
  description: "Bloco de transmissao RDP por dirty rects e cursor dedicado.",
  render: (props) => <RdpBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `RDP nao encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha no RDP (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `RDP dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado do RDP atualizado (${action}) [${blockId}] => ${status}`,
};

export default rdpWorkspaceModule;
