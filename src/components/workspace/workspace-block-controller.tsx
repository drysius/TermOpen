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
  interactive?: boolean;
  minWidth?: number;
  minHeight?: number;
  headerRight?: ReactNode;
  onFocus?: (id: string) => void;
  onLayoutChange: (id: string, nextLayout: WorkspaceBlockLayout) => void;
  children: ReactNode;
}

export function WorkspaceBlockController({
  id,
  title,
  subtitle,
  layout,
  zIndex = 1,
  interactive = true,
  minWidth = 320,
  minHeight = 220,
  headerRight,
  onFocus,
  onLayoutChange,
  children,
}: WorkspaceBlockControllerProps) {
  return (
    <Rnd
      bounds="parent"
      minWidth={minWidth}
      minHeight={minHeight}
      size={{ width: layout.width, height: layout.height }}
      position={{ x: layout.x, y: layout.y }}
      disableDragging={!interactive}
      enableResizing={interactive}
      onDragStop={(_, data) =>
        onLayoutChange(id, {
          ...layout,
          x: data.x,
          y: data.y,
        })
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
      className="overflow-hidden rounded-md border border-white/10 bg-zinc-950 shadow-2xl"
      style={{ zIndex }}
      onMouseDown={() => onFocus?.(id)}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="workspace-block-handle flex cursor-move items-center justify-between gap-2 border-b border-white/10 px-2 py-1.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-zinc-100">{title}</p>
            {subtitle ? <p className="truncate text-[11px] text-zinc-500">{subtitle}</p> : null}
          </div>
          <div className="flex items-center gap-1">{headerRight}</div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </Rnd>
  );
}
