import { LayoutDashboard, Plus, X } from "lucide-react";

import type { WorkTab } from "@/types/workspace";

interface WorkTabsProps {
  tabs: WorkTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreateWorkspace: () => void;
}

function tabLabel(tab: WorkTab): string {
  return tab.title || "Workspace";
}

export function WorkTabs({ tabs, activeId, onSelect, onClose, onCreateWorkspace }: WorkTabsProps) {
  return (
    <div className="flex h-full items-center gap-1 pl-2 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={`flex items-center gap-1.5 px-2.5 h-7 rounded text-[11px] transition-colors shrink-0 ${
            activeId === tab.id
              ? "bg-primary/15 text-primary border border-primary/30"
              : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border border-transparent"
          }`}
          title={tab.title}
        >
          <LayoutDashboard className="h-3 w-3" />
          <span className="max-w-[150px] truncate">{tabLabel(tab)}</span>
          {tab.closable ? (
            <X
              className="h-2.5 w-2.5 ml-0.5 text-muted-foreground hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            />
          ) : null}
        </button>
      ))}
      <button
        type="button"
        onClick={onCreateWorkspace}
        className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
        title="Novo Workspace"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

