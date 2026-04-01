import { Cloud, Maximize2, Minimize2, X } from "lucide-react";
import { WorkTabs } from "@/components/layout/work-tabs";
import { cn } from "@/lib/utils";
import type { WorkTab } from "@/types/workspace";

interface AppHeaderProps {
  tabs: WorkTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCreateWorkspaceTab: () => void;
  syncRunning: boolean;
  maximized?: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
  compact?: boolean;
}

const buttonBase =
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
export function AppHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateWorkspaceTab,
  syncRunning,
  maximized = false,
  onMinimize,
  onToggleMaximize,
  onCloseWindow,
  compact = false,
}: AppHeaderProps) {
  return (
    <header className="flex h-10 items-center border-b border-white/10 bg-zinc-950">
      <div data-tauri-drag-region className="h-full px-3 text-sm font-semibold text-zinc-100 flex items-center">
        TermOpen
      </div>
      {compact ? (
        <div data-tauri-drag-region className="h-full flex-1" />
      ) : (
        <div className="h-full flex-1 min-w-0">
          <WorkTabs
            tabs={tabs}
            activeId={activeTabId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onCreateWorkspace={onCreateWorkspaceTab}
          />
        </div>
      )}
      <div data-tauri-drag-region className="h-full w-3" />
      <div className="flex h-full items-center" data-tauri-drag-region="false">
        {!compact ? (
          <div className="mr-1 flex h-full w-10 items-center justify-center text-zinc-400">
            <Cloud className={syncRunning ? "h-4 w-4 animate-pulse text-purple-300" : "h-4 w-4"} />
          </div>
        ) : null}
        <button
          type="button"
          className={cn(buttonBase, "h-full w-10 hover:bg-accent hover:text-accent-foreground")}
          onClick={onMinimize}
        >
          <span className="mb-3">__</span>
        </button>
        <button
          type="button"
          className={cn(buttonBase, "h-full w-10 hover:bg-accent hover:text-accent-foreground")}
          onClick={onToggleMaximize}
        >
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className={cn(buttonBase, "h-full w-10 bg-destructive text-destructive-foreground hover:bg-destructive/90")}
          onClick={onCloseWindow}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
