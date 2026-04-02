import type { ReactNode } from "react";
import { Bug, CircleHelp, Globe, Home, KeyRound, NotebookTabs, Settings2 } from "lucide-react";

import { IconTooltip } from "@/components/ui/tooltip";
import { LOCALE_LABELS, useI18n, useT, type Locale } from "@/langs";
import type { SidebarSection } from "@/types/workspace";

interface AppSidebarProps {
  current: SidebarSection;
  onSelect: (section: SidebarSection) => void;
}

const icons: Record<SidebarSection, ReactNode> = {
  home: <Home className="h-4 w-4" />,
  keychain: <KeyRound className="h-4 w-4" />,
  known_hosts: <NotebookTabs className="h-4 w-4" />,
  settings: <Settings2 className="h-4 w-4" />,
  debug_logs: <Bug className="h-4 w-4" />,
  about: <CircleHelp className="h-4 w-4" />,
};

const sectionIds: SidebarSection[] = ["home", "keychain", "known_hosts", "settings", "debug_logs", "about"];

export function AppSidebar({ current, onSelect }: AppSidebarProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();

  const labels: Record<SidebarSection, string> = {
    home: t.sidebar.home,
    keychain: t.sidebar.keychain,
    known_hosts: t.sidebar.knownHosts,
    settings: t.sidebar.settings,
    debug_logs: t.sidebar.debugLogs,
    about: t.sidebar.about,
  };

  const nextLocale: Locale = locale === "pt_BR" ? "en_US" : "pt_BR";

  return (
    <aside className="flex w-[58px] flex-col items-center border-r border-white/10 bg-zinc-950 py-3">
      {sectionIds.map((id) => (
        <IconTooltip key={id} label={labels[id]}>
          <button
            className={`mb-2 flex h-10 w-10 items-center justify-center rounded-md border transition ${
              current === id
                ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-200"
                : "border-transparent text-zinc-300 hover:border-white/15 hover:bg-zinc-900"
            }`}
            onClick={() => onSelect(id)}
          >
            {icons[id]}
          </button>
        </IconTooltip>
      ))}

      <div className="mt-auto">
        <IconTooltip label={LOCALE_LABELS[nextLocale]}>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-zinc-400 transition hover:border-white/15 hover:bg-zinc-900 hover:text-zinc-200"
            onClick={() => setLocale(nextLocale)}
          >
            <Globe className="h-4 w-4" />
          </button>
        </IconTooltip>
      </div>
    </aside>
  );
}
