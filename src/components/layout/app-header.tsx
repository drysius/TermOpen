import { Maximize2, Minimize2, RefreshCw, Sidebar as SidebarIcon, UserRound, X } from "lucide-react";
import { type CSSProperties, useMemo } from "react";

import { WorkTabs } from "@/components/layout/work-tabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useT } from "@/langs";
import { cn } from "@/lib/utils";
import type { SyncLoggedUser, SyncProgressState } from "@/types/termopen";
import type { WorkTab } from "@/types/workspace";

interface AppHeaderProps {
  tabs: WorkTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCreateWorkspaceTab: () => void;
  syncRunning: boolean;
  syncProgress: SyncProgressState | null;
  loggedUser: SyncLoggedUser | null;
  onSyncLogin: () => void;
  onSyncNow: () => void;
  maximized?: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
  compact?: boolean;
}

function mapSyncStageLabel(stage: string, t: ReturnType<typeof useT>): string {
  if (stage === "uploading") {
    return t.app.header.stageUploading;
  }
  if (stage === "downloading") {
    return t.app.header.stageDownloading;
  }
  if (stage === "cleaning_remote") {
    return t.app.header.stageCleaningRemote;
  }
  if (stage === "complete") {
    return t.app.header.stageComplete;
  }
  return t.app.header.syncing;
}

function initialsFromUser(user: SyncLoggedUser | null): string {
  if (!user) {
    return "?";
  }
  const source = user.name?.trim() || user.email?.trim() || "";
  if (!source) {
    return "?";
  }
  const parts = source.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function AppHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateWorkspaceTab,
  syncRunning,
  syncProgress,
  loggedUser,
  onSyncLogin,
  onSyncNow,
  maximized = false,
  onMinimize,
  onToggleMaximize,
  onCloseWindow,
  compact = false,
}: AppHeaderProps) {
  const t = useT();
  const isConnected = Boolean(loggedUser?.name || loggedUser?.email || loggedUser?.picture_url);
  const displayName = loggedUser?.name?.trim() || loggedUser?.email?.trim() || t.app.header.guest;
  const progressPercent = Math.max(0, Math.min(100, syncProgress?.percent ?? 0));
  const progressLabel = useMemo(() => {
    if (!syncProgress) {
      return t.app.header.syncing;
    }
    const base = mapSyncStageLabel(syncProgress.stage, t);
    if (syncProgress.current_file) {
      return `${base} - ${syncProgress.current_file}`;
    }
    return base;
  }, [syncProgress, t]);

  return (
    <header className="sticky top-0 z-30 h-11 flex items-center border-b border-border/50 bg-background/80 backdrop-blur-sm">
      {compact ? null : <div data-tauri-drag-region className="h-full flex items-center px-2">
        <div style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <SidebarTrigger
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title={t.app.header.sidebarToggle}
          >
            <SidebarIcon className="h-4 w-4" />
          </SidebarTrigger>
        </div>
      </div>}

      {compact ? (
        <div data-tauri-drag-region className="ml-4 flex-1 text-xs font-semibold text-muted-foreground">
          {t.app.name}
        </div>
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

      <div className="ml-auto mr-1 flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
        {!compact ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="h-8 w-10 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors relative"
                title={isConnected ? t.app.header.statusConnected : t.app.header.statusDisconnected}
              >
                {loggedUser?.picture_url ? (
                  <img src={loggedUser.picture_url} alt={displayName} className="h-5 w-5 rounded-full object-cover" />
                ) : (
                  <span className="h-5 w-5 rounded-full bg-secondary border border-border text-[10px] text-foreground inline-flex items-center justify-center font-semibold">
                    {initialsFromUser(loggedUser)}
                  </span>
                )}
                {syncRunning ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary animate-pulse-glow" /> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-72 p-3 border-border bg-card">
              <div className="flex items-center gap-2">
                {loggedUser?.picture_url ? (
                  <img src={loggedUser.picture_url} alt={displayName} className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-secondary text-foreground">
                    <UserRound className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {t.app.header.hello} {displayName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{loggedUser?.email ?? t.app.header.statusDisconnected}</p>
                </div>
                <span
                  className={cn(
                    "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                    isConnected ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {isConnected ? t.app.header.statusConnected : t.app.header.statusDisconnected}
                </span>
              </div>

              {syncRunning || syncProgress ? (
                <div className="mt-3 rounded border border-border bg-secondary/40 p-2">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <RefreshCw className={cn("h-3.5 w-3.5", syncRunning ? "animate-spin text-primary" : "text-muted-foreground")} />
                    <span className="truncate">{progressLabel}</span>
                    <span className="ml-auto font-mono">{progressPercent}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              ) : null}

              <div className="mt-3 grid gap-2">
                {!isConnected ? (
                  <Button size="sm" className="h-8 text-xs" onClick={onSyncLogin} disabled={syncRunning}>
                    {t.app.header.login}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onSyncNow} disabled={syncRunning}>
                    {t.app.header.syncNow}
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          className="h-8 w-10 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title={t.app.header.windowMinimize}
          onClick={onMinimize}
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </button>
        <button
          className="h-8 w-10 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title={maximized ? t.app.header.windowRestore : t.app.header.windowMaximize}
          onClick={onToggleMaximize}
        >
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          className="h-8 w-10 flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
          title={t.app.header.windowClose}
          onClick={onCloseWindow}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
