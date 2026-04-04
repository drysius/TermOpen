import type { ReactNode } from "react";
import { Rnd } from "react-rnd";

export interface WorkspaceBlockLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkspaceBlockControllerProps {
  id: string;
  title: string;
  subtitle?: string;
  layout: WorkspaceBlockLayout;
  zIndex?: number;
  active?: boolean;
  interactive?: boolean;
  minWidth?: number;
  minHeight?: number;
  headerRight?: ReactNode;
  onFocus?: (id: string) => void;
  onDragStart?: (id: string) => void;
  onDragPreview?: (id: string, nextLayout: WorkspaceBlockLayout) => void;
  onDragEnd?: (id: string) => void;
  onLayoutChange: (id: string, nextLayout: WorkspaceBlockLayout) => void;
  children: ReactNode;
}

export function WorkspaceBlockController({
  id,
  title,
  subtitle,
  layout,
  zIndex = 1,
  active = false,
  interactive = true,
  minWidth = 320,
  minHeight = 220,
  headerRight,
  onFocus,
  onDragStart,
  onDragPreview,
  onDragEnd,
  onLayoutChange,
  children,
}: WorkspaceBlockControllerProps) {
  const enabledResizeHandles = interactive
    ? {
        top: true,
        right: true,
        bottom: true,
        left: true,
        topRight: true,
        bottomRight: true,
        bottomLeft: true,
        topLeft: true,
      }
    : false;

  const resizeHandleStyles = interactive
    ? {
        top: { height: 8, top: -4, cursor: "ns-resize" },
        right: { width: 8, right: -4, cursor: "ew-resize" },
        bottom: { height: 8, bottom: -4, cursor: "ns-resize" },
        left: { width: 8, left: -4, cursor: "ew-resize" },
        topRight: { width: 12, height: 12, top: -6, right: -6, cursor: "nesw-resize" },
        bottomRight: { width: 12, height: 12, bottom: -6, right: -6, cursor: "nwse-resize" },
        bottomLeft: { width: 12, height: 12, bottom: -6, left: -6, cursor: "nesw-resize" },
        topLeft: { width: 12, height: 12, top: -6, left: -6, cursor: "nwse-resize" },
      }
    : undefined;

  return (
    <Rnd
      bounds="parent"
      minWidth={minWidth}
      minHeight={minHeight}
      size={{ width: layout.width, height: layout.height }}
      position={{ x: layout.x, y: layout.y }}
      disableDragging={!interactive}
      enableResizing={enabledResizeHandles}
      resizeHandleStyles={resizeHandleStyles}
      onDragStart={() => {
        onFocus?.(id);
        onDragStart?.(id);
      }}
      onDrag={(_, data) =>
        onDragPreview?.(id, {
          ...layout,
          x: data.x,
          y: data.y,
        })
      }
      onDragStop={(_, data) =>
        {
          onLayoutChange(id, {
            ...layout,
            x: data.x,
            y: data.y,
          });
          onDragEnd?.(id);
        }
      }
      onResizeStop={(_, __, ref, ___, position) =>
        onLayoutChange(id, {
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
      }
      dragHandleClassName="workspace-block-handle"
      className={
        active
          ? "overflow-hidden rounded-lg border border-primary/65 bg-card shadow-xl"
          : "overflow-hidden rounded-lg border border-border/55 bg-card shadow-xl"
      }
      style={{ zIndex }}
      onMouseDown={() => onFocus?.(id)}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="workspace-block-handle flex cursor-move items-center justify-between gap-2 border-b border-border/55 bg-secondary/35 px-2 py-1.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">{title}</p>
            {subtitle ? <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="flex items-center gap-1">{headerRight}</div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </Rnd>
  );
}
