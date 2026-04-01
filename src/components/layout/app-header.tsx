import { Maximize2, Minimize2, RefreshCw, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { WorkTabs } from "@/components/layout/work-tabs";
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

const buttonBase =
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const isConnected = Boolean(loggedUser?.name || loggedUser?.email || loggedUser?.picture_url);
  const displayName = loggedUser?.name?.trim() || loggedUser?.email?.trim() || t.app.header.guest;
  const progressPercent = Math.max(0, Math.min(100, syncProgress?.percent ?? 0));
  const progressLabel = useMemo(() => {
    if (!syncProgress) {
      return t.app.header.syncing;
    }
    const base = mapSyncStageLabel(syncProgress.stage, t);
    if (syncProgress.current_file) {
      return `${base} • ${syncProgress.current_file}`;
    }
    return base;
  }, [syncProgress, t]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current) {
        return;
      }
      if (!menuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

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
      <div data-tauri-drag-region className="h-full w-2" />

      <div className="flex h-full items-center" data-tauri-drag-region="false">
        {!compact ? (
          <div ref={menuRef} className="relative mr-2">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-zinc-900/60 text-zinc-100 transition hover:border-white/30"
              onClick={() => setProfileMenuOpen((current) => !current)}
              title={isConnected ? t.app.header.statusConnected : t.app.header.statusDisconnected}
            >
              {loggedUser?.picture_url ? (
                <img src={loggedUser.picture_url} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <span className="text-[11px] font-semibold">{initialsFromUser(loggedUser)}</span>
              )}
              {syncRunning ? (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-cyan-400 ring-2 ring-zinc-950" />
              ) : null}
            </button>

            {profileMenuOpen ? (
              <div className="absolute right-0 top-10 z-[240] w-72 rounded-lg border border-white/10 bg-zinc-950/95 p-3 shadow-2xl shadow-black/60">
                <div className="flex items-center gap-2">
                  {loggedUser?.picture_url ? (
                    <img src={loggedUser.picture_url} alt={displayName} className="h-8 w-8 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-zinc-900 text-zinc-200">
                      <UserRound className="h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-100">
                      {t.app.header.hello} {displayName}
                    </p>
                    <p className="truncate text-xs text-zinc-500">{loggedUser?.email ?? t.app.header.statusDisconnected}</p>
                  </div>
                  <span
                    className={cn(
                      "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                      isConnected ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400",
                    )}
                  >
                    {isConnected ? t.app.header.statusConnected : t.app.header.statusDisconnected}
                  </span>
                </div>

                {syncRunning || syncProgress ? (
                  <div className="mt-3 rounded border border-white/10 bg-zinc-900/50 p-2">
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-300">
                      <RefreshCw className={cn("h-3.5 w-3.5", syncRunning ? "animate-spin text-cyan-300" : "text-zinc-400")} />
                      <span className="truncate">{progressLabel}</span>
                      <span className="ml-auto font-mono text-zinc-400">{progressPercent}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-cyan-400 transition-all duration-300"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 grid gap-2">
                  {!isConnected ? (
                    <button
                      type="button"
                      className="h-8 rounded border border-cyan-400/40 bg-cyan-500/10 text-xs font-medium text-cyan-100 transition hover:bg-cyan-500/20"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        onSyncLogin();
                      }}
                      disabled={syncRunning}
                    >
                      {t.app.header.login}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="h-8 rounded border border-white/20 bg-zinc-900 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        onSyncNow();
                      }}
                      disabled={syncRunning}
                    >
                      {t.app.header.syncNow}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
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
