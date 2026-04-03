import { useMemo } from "react";
import pkg from "../../../package.json";
import { Bug, CircleHelp, Globe, Home, KeyRound, NotebookTabs, Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { LOCALE_LABELS, useI18n, useT, type Locale } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { SidebarSection } from "@/types/workspace";

interface AppSidebarProps {
  current: SidebarSection;
  onSelect: (section: SidebarSection) => void;
}

const iconBySection: Record<SidebarSection, typeof Home> = {
  home: Home,
  keychain: KeyRound,
  known_hosts: NotebookTabs,
  settings: Settings2,
  debug_logs: Bug,
  about: CircleHelp,
};

export function AppSidebar({ current, onSelect }: AppSidebarProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { state } = useSidebar();
  const openHostDrawer = useAppStore((store) => store.openHostDrawer);
  const collapsed = state === "collapsed";
  const nextLocale: Locale = locale === "pt_BR" ? "en_US" : "pt_BR";

  const mainItems = useMemo(
    () =>
      [
        { id: "home" as const, label: t.sidebar.home },
        { id: "keychain" as const, label: t.sidebar.keychain },
        { id: "known_hosts" as const, label: t.sidebar.knownHosts },
      ] satisfies Array<{ id: SidebarSection; label: string }>,
    [t.sidebar.home, t.sidebar.keychain, t.sidebar.knownHosts],
  );

  const systemItems = useMemo(
    () =>
      [
        { id: "settings" as const, label: t.sidebar.settings },
        { id: "debug_logs" as const, label: t.sidebar.debugLogs },
        { id: "about" as const, label: t.sidebar.about },
      ] satisfies Array<{ id: SidebarSection; label: string }>,
    [t.sidebar.about, t.sidebar.debugLogs, t.sidebar.settings],
  );

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className={collapsed ? "p-2 flex items-center justify-center" : "p-4"}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3"}`}>
          <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/20 border border-primary/40 flex items-center justify-center">
            <span className="text-xs font-semibold text-primary">CH</span>
          </div>
          {!collapsed ? (
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground">{t.app.name}</span>
              <span className="text-[10px] text-muted-foreground">v{pkg.version}</span>
            </div>
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {!collapsed ? (
          <div className="px-3 mb-2">
            <Button size="sm" className="w-full gap-2 h-8 text-xs" onClick={() => openHostDrawer(undefined, "ssh")}>
              <Plus className="h-3.5 w-3.5" />
              {t.sidebar.newConnection}
            </Button>
          </div>
        ) : null}

        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {t.sidebar.groupMain}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainItems.map((item) => {
                const Icon = iconBySection[item.id];
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={current === item.id}
                      tooltip={item.label}
                      onClick={() => onSelect(item.id)}
                      className={current === item.id ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : ""}
                    >
                      <Icon className="h-4 w-4" />
                      {!collapsed ? <span>{item.label}</span> : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {t.sidebar.groupSystem}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {systemItems.map((item) => {
                const Icon = iconBySection[item.id];
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={current === item.id}
                      tooltip={item.label}
                      onClick={() => onSelect(item.id)}
                      className={current === item.id ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : ""}
                    >
                      <Icon className="h-4 w-4" />
                      {!collapsed ? <span>{item.label}</span> : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => setLocale(nextLocale)}
          title={LOCALE_LABELS[nextLocale]}
        >
          <Globe className="h-4 w-4" />
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
