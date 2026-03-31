import { Cloud, Minus, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkTabs } from "@/components/layout/work-tabs";
import type { WorkTab } from "@/types/workspace";

interface AppHeaderProps {
  tabs: WorkTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCreateWorkspaceTab: () => void;
  syncRunning: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
}

export function AppHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateWorkspaceTab,
  syncRunning,
  onMinimize,
  onToggleMaximize,
  onCloseWindow,
}: AppHeaderProps) {
  return (
    <header data-tauri-drag-region className="flex h-10 items-center border-b border-white/10 bg-zinc-950">
      <div className="px-3 text-sm font-semibold text-zinc-100">TermOpen</div>
      <div className="min-w-0 flex-1" data-tauri-drag-region="false">
        <WorkTabs
          tabs={tabs}
          activeId={activeTabId}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onCreateWorkspace={onCreateWorkspaceTab}
        />
      </div>
      <div className="flex items-center" data-tauri-drag-region="false">
        <div className="mr-1 flex h-8 w-8 items-center justify-center text-zinc-400">
          <Cloud className={syncRunning ? "h-4 w-4 animate-pulse text-purple-300" : "h-4 w-4"} />
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none" onClick={onMinimize}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none" onClick={onToggleMaximize}>
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button variant="destructive" size="icon" className="h-8 w-8 rounded-none" onClick={onCloseWindow}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
