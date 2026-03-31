import type { ReactNode } from "react";
import { CircleHelp, Home, KeyRound, NotebookTabs, Settings2 } from "lucide-react";

import { IconTooltip } from "@/components/ui/tooltip";
import type { SidebarSection } from "@/types/workspace";

interface AppSidebarProps {
  current: SidebarSection;
  onSelect: (section: SidebarSection) => void;
}

const items: Array<{ id: SidebarSection; label: string; icon: ReactNode }> = [
  { id: "home", label: "Home", icon: <Home className="h-4 w-4" /> },
  { id: "keychain", label: "Keychain", icon: <KeyRound className="h-4 w-4" /> },
  { id: "known_hosts", label: "Known Hosts", icon: <NotebookTabs className="h-4 w-4" /> },
  { id: "settings", label: "Settings", icon: <Settings2 className="h-4 w-4" /> },
  { id: "about", label: "Sobre", icon: <CircleHelp className="h-4 w-4" /> },
];

export function AppSidebar({ current, onSelect }: AppSidebarProps) {
  return (
    <aside className="flex w-[58px] flex-col items-center border-r border-white/10 bg-zinc-950 py-3">
      {items.map((item) => (
        <IconTooltip key={item.id} label={item.label}>
          <button
            className={`mb-2 flex h-10 w-10 items-center justify-center rounded-md border transition ${
              current === item.id
                ? "border-purple-400/60 bg-purple-600/20 text-purple-200"
                : "border-transparent text-zinc-300 hover:border-white/15 hover:bg-zinc-900"
            }`}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
          </button>
        </IconTooltip>
      ))}
    </aside>
  );
}
