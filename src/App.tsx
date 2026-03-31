import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";

import { HostFormDrawer } from "@/components/drawers/host-form-drawer";
import { KeychainFormDrawer } from "@/components/drawers/keychain-form-drawer";
import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ConfirmDialog } from "@/components/ui/dialog";
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

function App() {
  const location = useLocation();
  const navigate = useNavigate();

  const vaultStatus = useAppStore((state) => state.vaultStatus);
  const settings = useAppStore((state) => state.settings);
  const syncState = useAppStore((state) => state.syncState);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const editorTabs = useAppStore((state) => state.editorTabs);
  const workspaceBlockCountByTab = useAppStore((state) => state.workspaceBlockCountByTab);

  const bootstrap = useAppStore((state) => state.bootstrap);
  const clearSessionListeners = useAppStore((state) => state.clearSessionListeners);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const openTab = useAppStore((state) => state.openTab);
  const setEditorContent = useAppStore((state) => state.setEditorContent);
  const saveEditor = useAppStore((state) => state.saveEditor);
  const openEditorExternal = useAppStore((state) => state.openEditorExternal);
  const vaultLock = useAppStore((state) => state.vaultLock);

  const lastActivityRef = useRef<number>(Date.now());
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [closingWorkspace, setClosingWorkspace] = useState(false);
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const pendingCloseTab = useMemo(
    () => tabs.find((tab) => tab.id === pendingCloseTabId) ?? null,
    [pendingCloseTabId, tabs],
  );
  const currentSection = activeTabId ? "home" : sectionFromPath(location.pathname);

  useEffect(() => {
    void bootstrap();
    return () => {
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

  if (!vaultStatus || !vaultStatus.initialized || vaultStatus.locked) {
    return (
      <main className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
        <Toaster richColors position="bottom-right" />
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
          onMinimize={() => void api.windowMinimize()}
          onToggleMaximize={() => void api.windowToggleMaximize()}
          onCloseWindow={() => void api.windowClose()}
          compact
        />
        <VaultGatePage />
      </main>
    );
  }

  return (
    <main className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
      <Toaster richColors position="bottom-right" />

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
        syncRunning={syncState.status === "running"}
        onMinimize={() => void api.windowMinimize()}
        onToggleMaximize={() => void api.windowToggleMaximize()}
        onCloseWindow={() => void api.windowClose()}
      />

      <div className="flex min-h-0 flex-1">
        <AppSidebar
          current={currentSection}
          onSelect={(next) => {
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
