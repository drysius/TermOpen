import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WorkTab } from "@/types/workspace";

interface WorkTabsProps {
  tabs: WorkTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreateWorkspace: () => void;
}

type TabLabelMode = "full" | "truncate" | "compact" | "minimal";
const ADD_TAB_BUTTON_WIDTH = 38;

function trimTitle(title: string, max: number): string {
  if (title.length <= max) {
    return title;
  }
  return `${title.slice(0, Math.max(1, max - 1)).trim()}...`;
}

function renderTabTitle(tab: WorkTab, mode: TabLabelMode, index: number): string {
  if (mode === "full") {
    return tab.title;
  }
  if (mode === "truncate") {
    return trimTitle(tab.title, 18);
  }
  if (mode === "compact") {
    const [firstWord] = tab.title.split(/\s+/);
    return trimTitle(firstWord || tab.title, 10);
  }
  return String(index + 1);
}

export function WorkTabs({ tabs, activeId, onSelect, onClose, onCreateWorkspace }: WorkTabsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootWidth, setRootWidth] = useState(720);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setRootWidth(Math.max(240, Math.floor(width)));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const { tabWidth, labelMode, showCloseButton } = useMemo(() => {
    if (tabs.length === 0) {
      return {
        tabWidth: 140,
        labelMode: "full" as TabLabelMode,
        showCloseButton: true,
      };
    }

    const available = Math.max(120, rootWidth - ADD_TAB_BUTTON_WIDTH);
    const widthPerTab = Math.max(54, Math.floor(available / tabs.length));
    const mode: TabLabelMode =
      widthPerTab >= 180 ? "full" : widthPerTab >= 132 ? "truncate" : widthPerTab >= 90 ? "compact" : "minimal";
    return {
      tabWidth: widthPerTab,
      labelMode: mode,
      showCloseButton: widthPerTab >= 82,
    };
  }, [rootWidth, tabs.length]);

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className="flex h-full min-w-0 items-stretch overflow-hidden bg-transparent"
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          data-tauri-drag-region="false"
          className={`group flex h-full items-center border-r border-white/10 text-sm ${
            activeId === tab.id
              ? "border-b border-b-cyan-400/70 bg-zinc-900 text-zinc-100"
              : "bg-zinc-950 text-zinc-400"
          }`}
          style={{
            width: tabWidth,
            minWidth: tabWidth,
            maxWidth: tabWidth,
          }}
        >
          <button
            data-tauri-drag-region="false"
            className={`min-w-0 flex-1 truncate text-left ${labelMode === "minimal" ? "px-1 text-center" : "px-2"}`}
            onClick={() => onSelect(tab.id)}
            title={tab.title}
          >
            {renderTabTitle(tab, labelMode, index)}
          </button>
          {tab.closable && showCloseButton ? (
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

