import { Plus, X } from "lucide-react";

import type { WorkTab } from "@/types/workspace";

interface WorkTabsProps {
  tabs: WorkTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreateWorkspace: () => void;
}

export function WorkTabs({ tabs, activeId, onSelect, onClose, onCreateWorkspace }: WorkTabsProps) {
  return (
    <div data-tauri-drag-region className="flex h-full min-w-0 items-stretch overflow-x-auto bg-transparent">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-tauri-drag-region="false"
          className={`group flex h-full min-w-[140px] max-w-[260px] items-center border-r border-white/10 text-sm ${
            activeId === tab.id
              ? "border-b border-b-purple-400/70 bg-zinc-900 text-zinc-100"
              : "bg-zinc-950 text-zinc-400"
          }`}
        >
          <button data-tauri-drag-region="false" className="min-w-0 flex-1 truncate px-3 text-left" onClick={() => onSelect(tab.id)}>
            {tab.title}
          </button>
          {tab.closable ? (
            <button
              data-tauri-drag-region="false"
              className="mr-2 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => onClose(tab.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        data-tauri-drag-region="false"
        className="inline-flex h-full w-9 items-center justify-center border-r border-white/10 text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
        onClick={onCreateWorkspace}
        title="Novo workspace"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
