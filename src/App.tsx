import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { HostFormDrawer } from "@/components/drawers/host-form-drawer";
import { KeychainFormDrawer } from "@/components/drawers/keychain-form-drawer";
import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { getError } from "@/functions/common";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { AboutPage } from "@/pages/sections/about-page";
import { HomePage } from "@/pages/sections/home-page";
import { KeychainPage } from "@/pages/sections/keychain-page";
import { KnownHostsPage } from "@/pages/sections/known-hosts-page";
import { SettingsPage } from "@/pages/sections/settings-page";
import { EditorTabPage } from "@/pages/tabs/editor-tab-page";
import { RdpWorkspaceTabPage } from "@/pages/tabs/rdp-workspace-tab-page";
import { SftpWorkspaceTabPage } from "@/pages/tabs/sftp-workspace-tab-page";
import { VaultGatePage } from "@/pages/vault-gate-page";
import { useAppStore } from "@/store/app-store";
import type {
  AuthServer,
  ConnectionProfile,
  SyncConflictDecision,
  SyncKeepSide,
  SyncLoggedUser,
  SyncProgressState,
  SyncState,
} from "@/types/termopen";
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
    return "-";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

type DeepLinkProtocol = "ssh" | "sftp" | "rdp";

interface ParsedConnectionDeepLink {
  protocol: DeepLinkProtocol;
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

type PingMap = Record<string, number | null>;

function normalizeDeepLinkInput(raw: string): string {
  return raw
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace("termopen:://", "termopen://")
    .replace("openterm:://", "openterm://");
}

function parseDirectConnectionUrl(url: URL): ParsedConnectionDeepLink | null {
  const protocol = url.protocol.replace(":", "").toLowerCase();
  if (protocol !== "ssh" && protocol !== "sftp" && protocol !== "rdp") {
    return null;
  }

  const host = url.hostname.trim();
  if (!host) {
    return null;
  }

  const parsedPort = url.port ? Number(url.port) : protocol === "rdp" ? 3389 : 22;
  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  const username = decodeURIComponent(url.username || "").trim();
  const pathname = decodeURIComponent(url.pathname || "/").trim();
  const remotePath = protocol === "sftp" ? (pathname.length ? pathname : "/") : "/";

  return {
    protocol,
    host,
    port: parsedPort,
    username,
    remotePath,
  };
}

function parseConnectionDeepLink(raw: string): ParsedConnectionDeepLink | null {
  const normalized = normalizeDeepLinkInput(raw);
  if (!normalized.includes("://")) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const direct = parseDirectConnectionUrl(parsed);
  if (direct) {
    return direct;
  }

  const protocol = parsed.protocol.replace(":", "").toLowerCase();
  if (protocol !== "termopen" && protocol !== "openterm") {
    return null;
  }

  const embedded =
    parsed.searchParams.get("url") ??
    parsed.searchParams.get("target") ??
    parsed.searchParams.get("uri") ??
    parsed.searchParams.get("link");
  if (embedded) {
    return parseConnectionDeepLink(decodeURIComponent(embedded));
  }

  const hostBasedProtocol = parsed.hostname.toLowerCase();
  if (hostBasedProtocol === "ssh" || hostBasedProtocol === "sftp" || hostBasedProtocol === "rdp") {
    const rebuilt = `${hostBasedProtocol}://${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`;
    return parseConnectionDeepLink(rebuilt);
  }

  return null;
}

function pickRecommendedAuthServer(servers: AuthServer[], pings: PingMap): string | null {
  if (servers.length === 0) {
    return null;
  }

  const onlineOfficials = servers
    .filter((server) => server.official && typeof pings[server.id] === "number")
    .sort((left, right) => (pings[left.id] ?? Number.POSITIVE_INFINITY) - (pings[right.id] ?? Number.POSITIVE_INFINITY));
  if (onlineOfficials.length > 0) {
    return onlineOfficials[0].id;
  }

  const officials = servers.filter((server) => server.official);
  if (officials.length > 0) {
    return officials[0].id;
  }

  const online = servers
    .filter((server) => typeof pings[server.id] === "number")
    .sort((left, right) => (pings[left.id] ?? Number.POSITIVE_INFINITY) - (pings[right.id] ?? Number.POSITIVE_INFINITY));
  if (online.length > 0) {
    return online[0].id;
  }

  return servers[0].id;
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
  const openSsh = useAppStore((state) => state.openSsh);
  const openSftpWorkspace = useAppStore((state) => state.openSftpWorkspace);
  const openRdp = useAppStore((state) => state.openRdp);
  const openHostDrawer = useAppStore((state) => state.openHostDrawer);

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
  const deepLinkProcessingRef = useRef(false);
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
  const [pendingDeepLinks, setPendingDeepLinks] = useState<string[]>([]);
  const [loginServerModalOpen, setLoginServerModalOpen] = useState(false);
  const [loginServerLoading, setLoginServerLoading] = useState(false);
  const [loginServerBusy, setLoginServerBusy] = useState(false);
  const [loginServers, setLoginServers] = useState<AuthServer[]>([]);
  const [loginServerPings, setLoginServerPings] = useState<PingMap>({});
  const [selectedLoginServerId, setSelectedLoginServerId] = useState<string | null>(null);
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
  const recommendedLoginServerId = useMemo(
    () => pickRecommendedAuthServer(loginServers, loginServerPings),
    [loginServerPings, loginServers],
  );
  const loginServersSorted = useMemo(
    () =>
      [...loginServers].sort((left, right) => {
        const leftPing = loginServerPings[left.id];
        const rightPing = loginServerPings[right.id];
        const leftRank = typeof leftPing === "number" ? 0 : leftPing === null ? 2 : 1;
        const rightRank = typeof rightPing === "number" ? 0 : rightPing === null ? 2 : 1;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        if (leftRank === 0 && rightRank === 0) {
          return (leftPing ?? Number.POSITIVE_INFINITY) - (rightPing ?? Number.POSITIVE_INFINITY);
        }
        return left.label.localeCompare(right.label);
      }),
    [loginServerPings, loginServers],
  );
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

  async function loadLoginServers() {
    setLoginServerLoading(true);
    setLoginServerPings({});
    try {
      const servers = await api.authServersFetchRemote().catch(() => api.authServersList());
      setLoginServers(servers);
      if (servers.length === 0) {
        setSelectedLoginServerId(null);
        return;
      }

      const pingEntries = await Promise.all(
        servers.map(async (server) => {
          const startedAt = performance.now();
          try {
            const response = await tauriFetch(server.address, { method: "GET" });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            return [server.id, Math.round(performance.now() - startedAt)] as const;
          } catch {
            return [server.id, null] as const;
          }
        }),
      );
      const nextPings: PingMap = {};
      pingEntries.forEach(([id, value]) => {
        nextPings[id] = value;
      });
      setLoginServerPings(nextPings);
      setSelectedLoginServerId((current) => {
        if (current && servers.some((server) => server.id === current)) {
          return current;
        }
        return pickRecommendedAuthServer(servers, nextPings);
      });
    } catch (error) {
      setLoginServers([]);
      setSelectedLoginServerId(null);
      toast.error(getError(error));
    } finally {
      setLoginServerLoading(false);
    }
  }

  async function openLoginServerModal() {
    if (syncState.status === "running" || headerSyncBusy) {
      return;
    }
    setLoginServerModalOpen(true);
    await loadLoginServers();
  }

  async function handleLoginWithSelectedServer() {
    if (loginServerBusy || headerSyncBusy) {
      return;
    }
    const selected =
      loginServers.find((server) => server.id === selectedLoginServerId) ??
      loginServers.find((server) => server.id === recommendedLoginServerId) ??
      loginServers[0];
    if (!selected) {
      return;
    }

    setLoginServerBusy(true);
    setHeaderSyncBusy(true);
    try {
      await runSync("login", selected.address);
      await refreshLoggedUser();
      setLoginServerModalOpen(false);
    } finally {
      setHeaderSyncBusy(false);
      setLoginServerBusy(false);
    }
  }

  async function handleHeaderSync(action: "login" | "push") {
    if (action === "login") {
      await openLoginServerModal();
      return;
    }

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

  function enqueueDeepLink(rawUrl: string) {
    const normalized = normalizeDeepLinkInput(rawUrl);
    if (!normalized) {
      return;
    }
    setPendingDeepLinks((current) => (current.includes(normalized) ? current : [...current, normalized]));
  }

  async function openConnectionFromDeepLink(rawUrl: string): Promise<boolean> {
    const parsed = parseConnectionDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }

    const protocolList =
      parsed.protocol === "ssh"
        ? (["ssh"] as const)
        : parsed.protocol === "sftp"
          ? (["sftp"] as const)
          : (["rdp"] as const);
    const fallbackName = `${parsed.protocol.toUpperCase()} ${parsed.host}`;

    if (!parsed.username) {
      openHostDrawer(
        {
          id: "",
          name: fallbackName,
          host: parsed.host,
          port: parsed.port,
          username: "",
          password: "",
          private_key: "",
          keychain_id: null,
          remote_path: parsed.remotePath,
          protocols: [...protocolList],
          kind: parsed.protocol === "ssh" ? "host" : parsed.protocol === "sftp" ? "sftp" : "rdp",
        },
        parsed.protocol,
      );
      return true;
    }

    const stateConnections = useAppStore.getState().connections;
    const existing = stateConnections.find((item) => {
      const hasProtocol = item.protocols.includes(parsed.protocol);
      if (!hasProtocol) {
        return false;
      }
      return (
        item.host === parsed.host &&
        item.port === parsed.port &&
        item.username === parsed.username
      );
    });

    let profile: ConnectionProfile;
    if (existing) {
      profile = existing;
    } else {
      const created = await api.connectionSave({
        id: "",
        name: fallbackName,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: "",
        private_key: "",
        keychain_id: null,
        remote_path: parsed.remotePath,
        protocols: [...protocolList],
        kind: parsed.protocol === "ssh" ? "host" : parsed.protocol === "sftp" ? "sftp" : "rdp",
      });
      profile = created;
      useAppStore.setState((current) => ({
        connections: [...current.connections.filter((item) => item.id !== created.id), created].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }));
    }

    if (parsed.protocol === "ssh") {
      await openSsh(profile);
    } else if (parsed.protocol === "sftp") {
      await openSftpWorkspace(profile);
    } else {
      await openRdp(profile);
    }
    return true;
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

  useEffect(() => {
    let stopDeepLinkListener: (() => void) | null = null;

    void api
      .deeplinkTakePending()
      .then((urls) => {
        urls.forEach((url) => enqueueDeepLink(url));
      })
      .catch(() => undefined);

    void listen<string>("app:deeplink", (event) => {
      enqueueDeepLink(event.payload);
    }).then((unlisten) => {
      stopDeepLinkListener = unlisten;
    });

    return () => {
      stopDeepLinkListener?.();
    };
  }, []);

  useEffect(() => {
    if (!vaultStatus || !vaultStatus.initialized || vaultStatus.locked) {
      return;
    }
    if (pendingDeepLinks.length === 0 || deepLinkProcessingRef.current) {
      return;
    }

    const nextUrl = pendingDeepLinks[0];
    deepLinkProcessingRef.current = true;
    void openConnectionFromDeepLink(nextUrl)
      .catch(() => undefined)
      .finally(() => {
        setPendingDeepLinks((current) => current.slice(1));
        deepLinkProcessingRef.current = false;
      });
  }, [openHostDrawer, openRdp, openSftpWorkspace, openSsh, pendingDeepLinks, vaultStatus]);

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
                tab.initialBlock === "rdp" ? (
                  <RdpWorkspaceTabPage
                    key={`rdp-workspace:${tab.id}`}
                    tabId={tab.id}
                    initialSourceId={tab.initialSourceId ?? tab.profileId ?? undefined}
                  />
                ) : (
                  <SftpWorkspaceTabPage
                    key={`workspace:${tab.id}`}
                    tabId={tab.id}
                    initialBlock={tab.initialBlock}
                    initialSourceId={tab.initialSourceId ?? tab.sessionId ?? undefined}
                  />
                )
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
        open={loginServerModalOpen}
        title={t.app.header.loginServerTitle}
        description={t.app.header.loginServerDescription}
        onClose={() => {
          if (loginServerBusy) {
            return;
          }
          setLoginServerModalOpen(false);
        }}
        footer={
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
              onClick={() => void loadLoginServers()}
              disabled={loginServerBusy || loginServerLoading}
            >
              {t.app.header.loginServerRefresh}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
                onClick={() => setLoginServerModalOpen(false)}
                disabled={loginServerBusy}
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                className="rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60"
                onClick={() => void handleLoginWithSelectedServer()}
                disabled={loginServerBusy || loginServerLoading || !selectedLoginServerId}
              >
                {loginServerBusy ? t.app.header.syncing : t.app.header.loginServerAction}
              </button>
            </div>
          </div>
        }
      >
        {loginServerLoading ? (
          <p className="text-sm text-zinc-300">{t.app.header.loginServerLoading}</p>
        ) : loginServersSorted.length === 0 ? (
          <p className="text-sm text-zinc-400">{t.app.header.loginServerEmpty}</p>
        ) : (
          <div className="space-y-2">
            {loginServersSorted.map((server) => {
              const ping = loginServerPings[server.id];
              const selected = selectedLoginServerId === server.id;
              const recommended = recommendedLoginServerId === server.id;
              return (
                <button
                  key={server.id}
                  type="button"
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                    selected
                      ? "border-cyan-400/70 bg-cyan-500/15 text-cyan-100"
                      : "border-white/10 bg-zinc-900/50 text-zinc-200 hover:border-cyan-400/50"
                  }`}
                  onClick={() => setSelectedLoginServerId(server.id)}
                >
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{server.label}</p>
                    {recommended ? (
                      <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-200">
                        {t.app.header.loginServerRecommended}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs font-mono text-zinc-400">
                      {typeof ping === "number"
                        ? `${ping}ms`
                        : ping === null
                          ? t.app.header.loginServerOffline
                          : t.app.header.loginServerUnknownMs}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">{server.address}</p>
                </button>
              );
            })}
          </div>
        )}
      </Dialog>
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
