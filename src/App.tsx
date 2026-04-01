import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { HostFormDrawer } from "@/components/drawers/host-form-drawer";
import { KeychainFormDrawer } from "@/components/drawers/keychain-form-drawer";
import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { AboutPage } from "@/pages/sections/about-page";
import { HomePage } from "@/pages/sections/home-page";
import { KeychainPage } from "@/pages/sections/keychain-page";
import { KnownHostsPage } from "@/pages/sections/known-hosts-page";
import { SettingsPage } from "@/pages/sections/settings-page";
import { EditorTabPage } from "@/pages/tabs/editor-tab-page";
import { SftpWorkspaceTabPage } from "@/pages/tabs/sftp-workspace-tab-page";
import { VaultGatePage } from "@/pages/vault-gate-page";
import { useAppStore } from "@/store/app-store";
import type { SyncConflictDecision, SyncKeepSide, SyncLoggedUser, SyncProgressState, SyncState } from "@/types/termopen";
import type { SidebarSection } from "@/types/workspace";

function sectionFromPath(pathname: string): SidebarSection {
  if (pathname.startsWith("/about")) {
    return "about";
  }
  if (pathname.startsWith("/settings")) {
    return "settings";
  }
  if (pathname.startsWith("/known-hosts")) {
    return "known_hosts";
  }
  if (pathname.startsWith("/keychain")) {
    return "keychain";
  }
  return "home";
}

function pathFromSection(section: SidebarSection): string {
  if (section === "about") {
    return "/about";
  }
  if (section === "keychain") {
    return "/keychain";
  }
  if (section === "known_hosts") {
    return "/known-hosts";
  }
  if (section === "settings") {
    return "/settings";
  }
  return "/home";
}

function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();

  const vaultStatus = useAppStore((state) => state.vaultStatus);
  const settings = useAppStore((state) => state.settings);
  const syncState = useAppStore((state) => state.syncState);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const editorTabs = useAppStore((state) => state.editorTabs);
  const workspaceBlockCountByTab = useAppStore((state) => state.workspaceBlockCountByTab);
  const startupConflicts = useAppStore((state) => state.startupConflicts);
  const startupSyncBusy = useAppStore((state) => state.startupSyncBusy);
  const settingsUnsavedDraft = useAppStore((state) => state.settingsUnsavedDraft);

  const bootstrap = useAppStore((state) => state.bootstrap);
  const resolveStartupConflicts = useAppStore((state) => state.resolveStartupConflicts);
  const clearSessionListeners = useAppStore((state) => state.clearSessionListeners);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const openTab = useAppStore((state) => state.openTab);
  const setEditorContent = useAppStore((state) => state.setEditorContent);
  const saveEditor = useAppStore((state) => state.saveEditor);
  const openEditorExternal = useAppStore((state) => state.openEditorExternal);
  const vaultLock = useAppStore((state) => state.vaultLock);
  const runSync = useAppStore((state) => state.runSync);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const setSettingsUnsavedDraft = useAppStore((state) => state.setSettingsUnsavedDraft);

  const lastActivityRef = useRef<number>(Date.now());
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [closingWorkspace, setClosingWorkspace] = useState(false);
  const [booting, setBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState("Iniciando TermOpen...");
  const [syncChoices, setSyncChoices] = useState<Record<string, SyncKeepSide>>({});
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [loggedUser, setLoggedUser] = useState<SyncLoggedUser | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null);
  const [headerSyncBusy, setHeaderSyncBusy] = useState(false);
  const [pendingSettingsNavigation, setPendingSettingsNavigation] = useState<SidebarSection | null>(null);
  const [leavingSettingsBusy, setLeavingSettingsBusy] = useState(false);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const pendingCloseTab = useMemo(
    () => tabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, tabs],
  );
  const settingsDiffPreview = useMemo(() => {
    if (!settingsUnsavedDraft) {
      return [] as Array<{ key: string; from: string; to: string }>;
    }
    return (Object.keys(settingsUnsavedDraft) as Array<keyof typeof settingsUnsavedDraft>)
      .filter((key) => settings[key] !== settingsUnsavedDraft[key])
      .map((key) => ({
        key,
        from: formatSettingValue(settings[key]),
        to: formatSettingValue(settingsUnsavedDraft[key]),
      }));
  }, [settings, settingsUnsavedDraft]);
  const currentSection = activeTabId ? "home" : sectionFromPath(location.pathname);
  const shellClass = isWindowMaximized
    ? "flex h-full w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100"
    : "flex w-full h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl";

  async function refreshMaximizeState() {
    const value = await api.windowIsMaximized().catch(() => false);
    setIsWindowMaximized(value);
  }

  async function handleToggleMaximize() {
    const value = await api.windowToggleMaximize().catch(() => isWindowMaximized);
    setIsWindowMaximized(value);
  }

  async function refreshLoggedUser() {
    const user = await api.syncLoggedUser().catch(() => null);
    setLoggedUser(user);
  }

  async function handleHeaderSync(action: "login" | "push") {
    if (syncState.status === "running" || headerSyncBusy) {
      return;
    }
    setHeaderSyncBusy(true);
    try {
      await runSync(action);
      await refreshLoggedUser();
    } finally {
      setHeaderSyncBusy(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        setBootMessage("Verificando atualizacoes...");
        const release = await api.releaseCheckLatest().catch(() => null);
        if (mounted && release?.available) {
          toast.message(release.message);
        }
      } finally {
        if (mounted) {
          setBootMessage("Carregando dados locais...");
        }
      }

      await bootstrap().catch(() => undefined);
      if (mounted) {
        setBooting(false);
      }
    })();

    return () => {
      mounted = false;
      clearSessionListeners();
    };
  }, [bootstrap, clearSessionListeners]);

  useEffect(() => {
    if (!vaultStatus || vaultStatus.locked) {
      return;
    }

    const mark = () => {
      lastActivityRef.current = Date.now();
    };

    const events: Array<keyof WindowEventMap> = ["mousemove", "mousedown", "keydown", "scroll", "focus"];
    events.forEach((eventName) => window.addEventListener(eventName, mark, { passive: true }));

    const timer = window.setInterval(() => {
      const limit = Math.max(1, settings.inactivity_lock_minutes) * 60_000;
      if (Date.now() - lastActivityRef.current > limit) {
        void vaultLock(true);
      }
    }, 15_000);

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, mark));
      window.clearInterval(timer);
    };
  }, [settings.inactivity_lock_minutes, vaultLock, vaultStatus]);

  useEffect(() => {
    if (!vaultStatus || vaultStatus.locked || !syncState.connected || !settings.sync_auto_enabled) {
      return;
    }

    const timer = window.setInterval(() => {
      useAppStore.setState((state) => ({
        syncState: { ...state.syncState, status: "running", message: "Sincronizacao automatica em andamento..." },
      }));
      void api
        .syncPush()
        .then((state) => {
          useAppStore.setState({ syncState: state });
        })
        .catch(() => {
          useAppStore.setState((state) => ({
            syncState: {
              ...state.syncState,
              status: "error",
              message: "Falha na sincronizacao automatica.",
            },
          }));
        });
    }, Math.max(1, settings.sync_interval_minutes) * 60_000);

    return () => window.clearInterval(timer);
  }, [settings.sync_auto_enabled, settings.sync_interval_minutes, syncState.connected, vaultStatus]);

  useEffect(() => {
    if (!vaultStatus || !vaultStatus.initialized || vaultStatus.locked) {
      setLoggedUser(null);
      return;
    }
    void refreshLoggedUser();
  }, [syncState.last_sync_at, syncState.status, vaultStatus]);

  useEffect(() => {
    if (startupConflicts.length === 0) {
      setSyncChoices({});
      return;
    }
    const next: Record<string, SyncKeepSide> = {};
    for (const item of startupConflicts) {
      next[`${item.kind}:${item.id}`] = "server";
    }
    setSyncChoices(next);
  }, [startupConflicts]);

  useEffect(() => {
    if (!vaultStatus || vaultStatus.locked) {
      return;
    }
    const timer = window.setInterval(() => {
      void api.windowStateSave().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [vaultStatus]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | null = null;

    void refreshMaximizeState();
    void appWindow.onResized(() => {
      void refreshMaximizeState();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let stopSyncStatus: (() => void) | null = null;
    let stopSyncProgress: (() => void) | null = null;

    void listen<SyncState>("sync:status", (event) => {
      useAppStore.setState({ syncState: event.payload });
      if (event.payload.status !== "running") {
        setSyncProgress(null);
      }
    }).then((unlisten) => {
      stopSyncStatus = unlisten;
    });

    void listen<SyncProgressState>("sync:progress", (event) => {
      setSyncProgress(event.payload);
    }).then((unlisten) => {
      stopSyncProgress = unlisten;
    });

    return () => {
      stopSyncStatus?.();
      stopSyncProgress?.();
    };
  }, []);

  async function handleResolveStartupConflicts() {
    const decisions: SyncConflictDecision[] = startupConflicts.map((item) => ({
      kind: item.kind,
      id: item.id,
      keep: syncChoices[`${item.kind}:${item.id}`] ?? "server",
    }));
    await resolveStartupConflicts(decisions);
  }

  async function continueNavigationAfterSettings(section: SidebarSection, saveDraft: boolean) {
    if (leavingSettingsBusy) {
      return;
    }
    setLeavingSettingsBusy(true);
    try {
      if (saveDraft && settingsUnsavedDraft) {
        await saveSettings(settingsUnsavedDraft);
      }
      setSettingsUnsavedDraft(null);
      setActiveTab(null);
      navigate(pathFromSection(section));
      setPendingSettingsNavigation(null);
    } finally {
      setLeavingSettingsBusy(false);
    }
  }

  if (booting) {
    return (
      <main className={shellClass}>
        <Toaster theme="dark" richColors position="bottom-right" />
        <AppHeader
          tabs={[]}
          activeTabId={null}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onCreateWorkspaceTab={() => undefined}
          syncRunning={false}
          syncProgress={null}
          loggedUser={null}
          onSyncLogin={() => undefined}
          onSyncNow={() => undefined}
          maximized={isWindowMaximized}
          onMinimize={() => void api.windowMinimize()}
          onToggleMaximize={() => void handleToggleMaximize()}
          onCloseWindow={() => void api.windowClose()}
          compact
        />
        <section className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm px-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/5">
              <span className="text-xl font-semibold text-zinc-100">TO</span>
            </div>
            <p className="text-xl font-semibold text-zinc-100">TermOpen</p>
            <p className="mt-3 text-sm text-zinc-300">{bootMessage}</p>
          </div>
        </section>
      </main>
    );
  }

  if (!vaultStatus || !vaultStatus.initialized || vaultStatus.locked) {
    return (
      <main className={shellClass}>
        <Toaster theme="dark" richColors position="bottom-right" />
        <AppHeader
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTab}
          onCloseTab={(id) => void closeTab(id)}
          onCreateWorkspaceTab={() =>
            openTab({
              id: `workspace:${Date.now()}:${Math.random().toString(16).slice(2, 7)}`,
              type: "workspace",
              title: "Workspace",
              closable: true,
            })
          }
          syncRunning={false}
          syncProgress={null}
          loggedUser={null}
          onSyncLogin={() => undefined}
          onSyncNow={() => undefined}
          maximized={isWindowMaximized}
          onMinimize={() => void api.windowMinimize()}
          onToggleMaximize={() => void handleToggleMaximize()}
          onCloseWindow={() => void api.windowClose()}
          compact
        />
        <VaultGatePage />
      </main>
    );
  }

  return (
    <main className={shellClass}>
      <Toaster theme="dark" richColors position="bottom-right" />

      <AppHeader
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={(id) => {
          const tab = tabs.find((item) => item.id === id);
          if (!tab) {
            return;
          }
          if (tab.type !== "workspace") {
            void closeTab(id);
            return;
          }
          const hasBlocks = (workspaceBlockCountByTab[id] ?? 0) > 0;
          if (!hasBlocks) {
            void closeTab(id);
            return;
          }
          setPendingCloseTabId(id);
        }}
        onCreateWorkspaceTab={() =>
          openTab({
            id: `workspace:${Date.now()}:${Math.random().toString(16).slice(2, 7)}`,
            type: "workspace",
            title: "Workspace",
            closable: true,
          })
        }
        syncRunning={syncState.status === "running" || headerSyncBusy}
        syncProgress={syncProgress}
        loggedUser={loggedUser}
        onSyncLogin={() => void handleHeaderSync("login")}
        onSyncNow={() => void handleHeaderSync("push")}
        maximized={isWindowMaximized}
        onMinimize={() => void api.windowMinimize()}
        onToggleMaximize={() => void handleToggleMaximize()}
        onCloseWindow={() => void api.windowClose()}
      />

      <div className="flex min-h-0 flex-1">
        <AppSidebar
          current={currentSection}
          onSelect={(next) => {
            if (currentSection === "settings" && next !== "settings" && settingsUnsavedDraft) {
              setPendingSettingsNavigation(next);
              return;
            }
            setSettingsUnsavedDraft(null);
            setActiveTab(null);
            navigate(pathFromSection(next));
          }}
        />

        <section className="min-h-0 flex-1 bg-zinc-950/80">
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeTabId ? "h-full" : "hidden h-full"}>
              {tab.type === "editor" ? (
                <EditorTabPage
                  path={editorTabs[tab.id]?.path ?? ""}
                  content={editorTabs[tab.id]?.content ?? ""}
                  view={editorTabs[tab.id]?.view ?? "text"}
                  language={editorTabs[tab.id]?.language ?? "plaintext"}
                  mimeType={editorTabs[tab.id]?.mimeType ?? null}
                  mediaBase64={editorTabs[tab.id]?.mediaBase64 ?? null}
                  previewError={editorTabs[tab.id]?.previewError ?? null}
                  sizeBytes={editorTabs[tab.id]?.sizeBytes ?? null}
                  onContentChange={(value) => setEditorContent(tab.id, value)}
                  onSave={() => void saveEditor(tab.id)}
                  onOpenExternal={() => void openEditorExternal(tab.id)}
                />
              ) : null}
              {tab.type === "workspace" ? (
                <SftpWorkspaceTabPage
                  key={`workspace:${tab.id}`}
                  tabId={tab.id}
                  initialBlock={tab.initialBlock}
                  initialSourceId={tab.initialSourceId ?? tab.sessionId ?? undefined}
                />
              ) : null}
            </div>
          ))}

          {!activeTab ? (
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/hosts" element={<Navigate to="/home" replace />} />
              <Route path="/sftp" element={<Navigate to="/home" replace />} />
              <Route path="/keychain" element={<KeychainPage />} />
              <Route path="/known-hosts" element={<KnownHostsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          ) : null}
        </section>
      </div>

      <HostFormDrawer />
      <KeychainFormDrawer />
      <Dialog
        open={startupConflicts.length > 0}
        title="Conflitos de Sincronizacao"
        description="Foram detectadas diferencas entre cliente e servidor. Escolha qual lado manter para cada item."
        onClose={() => undefined}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
              disabled={startupSyncBusy}
              onClick={() => void handleResolveStartupConflicts()}
            >
              {startupSyncBusy ? "Aplicando..." : "Aplicar Resolucao"}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          {startupConflicts.map((item) => {
            const key = `${item.kind}:${item.id}`;
            const selected = syncChoices[key] ?? "server";
            return (
              <div key={key} className="rounded-lg border border-white/10 p-3">
                <p className="text-sm font-medium text-zinc-100">{item.label}</p>
                <p className="mt-1 truncate text-xs text-zinc-500">
                  Local: {item.local_hash ?? "ausente"} | Servidor: {item.remote_hash ?? "ausente"}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={`rounded-md px-2 py-1 text-xs ${
                      selected === "client"
                        ? "bg-emerald-600 text-white"
                        : "border border-white/15 text-zinc-300"
                    }`}
                    onClick={() => setSyncChoices((prev) => ({ ...prev, [key]: "client" }))}
                  >
                    Manter Cliente
                  </button>
                  <button
                    type="button"
                    className={`rounded-md px-2 py-1 text-xs ${
                      selected === "server"
                        ? "bg-blue-600 text-white"
                        : "border border-white/15 text-zinc-300"
                    }`}
                    onClick={() => setSyncChoices((prev) => ({ ...prev, [key]: "server" }))}
                  >
                    Manter Servidor
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Dialog>
      <Dialog
        open={pendingSettingsNavigation !== null}
        title={t.settings.unsaved.title}
        description={t.settings.unsaved.description}
        onClose={() => {
          if (!leavingSettingsBusy) {
            setPendingSettingsNavigation(null);
          }
        }}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
              disabled={leavingSettingsBusy}
              onClick={() => setPendingSettingsNavigation(null)}
            >
              {t.settings.unsaved.stay}
            </button>
            <button
              type="button"
              className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
              disabled={leavingSettingsBusy || !pendingSettingsNavigation}
              onClick={() => {
                if (!pendingSettingsNavigation) {
                  return;
                }
                void continueNavigationAfterSettings(pendingSettingsNavigation, false);
              }}
            >
              {t.settings.unsaved.discardAndLeave}
            </button>
            <button
              type="button"
              className="rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60"
              disabled={leavingSettingsBusy || !pendingSettingsNavigation}
              onClick={() => {
                if (!pendingSettingsNavigation) {
                  return;
                }
                void continueNavigationAfterSettings(pendingSettingsNavigation, true);
              }}
            >
              {t.settings.unsaved.saveAndLeave}
            </button>
          </div>
        }
      >
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t.settings.unsaved.preview}</p>
          {settingsDiffPreview.length === 0 ? (
            <p className="text-sm text-zinc-400">{t.settings.unsaved.emptyPreview}</p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-auto rounded border border-white/10 bg-zinc-950/60 p-2">
              {settingsDiffPreview.map((item) => (
                <div key={item.key} className="rounded border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-xs">
                  <p className="font-medium text-zinc-100">{item.key}</p>
                  <p className="mt-0.5 text-zinc-500">
                    {item.from} {"->"} {item.to}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={pendingCloseTab !== null}
        title="Fechar workspace"
        message={
          closingWorkspace
            ? "Fechando terminais e blocos do workspace..."
            : `Deseja realmente fechar "${pendingCloseTab?.title ?? "Workspace"}"? Isso encerrara as sessoes associadas.`
        }
        busy={closingWorkspace}
        confirmLabel={closingWorkspace ? "Fechando..." : "Fechar Workspace"}
        onCancel={() => {
          if (!closingWorkspace) {
            setPendingCloseTabId(null);
          }
        }}
        onConfirm={() => {
          if (!pendingCloseTabId || closingWorkspace) {
            return;
          }
          setClosingWorkspace(true);
          void closeTab(pendingCloseTabId)
            .finally(() => {
              setClosingWorkspace(false);
              setPendingCloseTabId(null);
            });
        }}
      />
    </main>
  );
}

export default App;
