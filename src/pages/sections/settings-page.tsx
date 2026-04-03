import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudUpload,
  ExternalLink,
  FolderOpen,
  Lock,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  TerminalSquare,
  TriangleAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/app-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getError } from "@/functions/common";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import { api } from "@/lib/tauri";
import type { AppSettings, AuthServer, ModifiedUploadPolicy, SyncLoggedUser } from "@/types/termopen";
import { OptionDropdown } from "@/pages/sections/settings/option-dropdown";
import { SettingsPanel } from "@/pages/sections/settings/settings-panel";
import { SettingsRow } from "@/pages/sections/settings/settings-row";
import type { PasswordFormValues, SettingsFormValues } from "@/pages/sections/settings/types";

const uploadPolicyStorageKey = "termopen.upload-policy.prompted";

function normalizeSettingsValues(values: SettingsFormValues): AppSettings {
  return {
    ...values,
    external_editor_command: values.external_editor_command?.trim() ?? "",
    known_hosts_path: values.known_hosts_path?.trim() ?? "",
    sync_interval_minutes: values.sync_interval_minutes || 5,
    sftp_chunk_size_kb: values.sftp_chunk_size_kb || 1024,
    sftp_reconnect_delay_seconds: values.sftp_reconnect_delay_seconds || 5,
    inactivity_lock_minutes: values.inactivity_lock_minutes || 10,
    reconnect_delay_seconds: values.reconnect_delay_seconds || 5,
  };
}

export function SettingsPage() {
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const syncState = useAppStore((state) => state.syncState);
  const connections = useAppStore((state) => state.connections);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const knownHosts = useAppStore((state) => state.knownHosts);
  const busy = useAppStore((state) => state.busy);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const setSettingsUnsavedDraft = useAppStore((state) => state.setSettingsUnsavedDraft);
  const runSync = useAppStore((state) => state.runSync);
  const syncCancel = useAppStore((state) => state.syncCancel);
  const changeMasterPassword = useAppStore((state) => state.changeMasterPassword);
  const bootstrap = useAppStore((state) => state.bootstrap);

  const [showUploadPolicyModal, setShowUploadPolicyModal] = useState(false);
  const [authServers, setAuthServers] = useState<AuthServer[]>([]);
  const [loggedUser, setLoggedUser] = useState<SyncLoggedUser | null>(null);
  const [driveTab, setDriveTab] = useState<"account" | "config">("account");
  const [settingsTab, setSettingsTab] = useState<"general" | "sftp" | "terminal" | "sync" | "security">("general");
  const [serverPings, setServerPings] = useState<Record<string, number | null>>({});
  const [serverFilter, setServerFilter] = useState("");
  const [serverFilterStatus, setServerFilterStatus] = useState<"all" | "online" | "offline">("all");
  const [serverPage, setServerPage] = useState(0);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncAction, setSyncAction] = useState<"login" | "push" | "pull" | null>(null);
  const [serverDraft, setServerDraft] = useState({ id: "", label: "", address: "", author: "" });
  const [showLocalServerModal, setShowLocalServerModal] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteCloudData, setDeleteCloudData] = useState(false);
  const [deleteCurrentPassword, setDeleteCurrentPassword] = useState("");
  const SERVERS_PER_PAGE = 5;

  const settingsForm = useForm<SettingsFormValues>({
    defaultValues: settings,
  });
  const passwordForm = useForm<PasswordFormValues>({
    defaultValues: {
      oldPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });
  const saveInFlightRef = useRef(false);
  const pendingSettingsRef = useRef<AppSettings | null>(null);

  useEffect(() => {
    settingsForm.reset(settings);
    setSettingsUnsavedDraft(null);
  }, [setSettingsUnsavedDraft, settings, settingsForm]);

  const flushSettingsSave = useCallback(async () => {
    if (saveInFlightRef.current) {
      return;
    }
    const next =
      pendingSettingsRef.current ??
      normalizeSettingsValues(settingsForm.getValues() as SettingsFormValues);
    pendingSettingsRef.current = null;

    if (JSON.stringify(next) === JSON.stringify(settings)) {
      setSettingsUnsavedDraft(null);
      return;
    }

    saveInFlightRef.current = true;
    try {
      await saveSettings(next, { silent: true });
    } finally {
      saveInFlightRef.current = false;
      setSettingsUnsavedDraft(null);
      if (pendingSettingsRef.current) {
        void flushSettingsSave();
      }
    }
  }, [saveSettings, setSettingsUnsavedDraft, settings, settingsForm]);

  const requestSettingsSave = useCallback(
    (immediate = false) => {
      pendingSettingsRef.current = normalizeSettingsValues(settingsForm.getValues() as SettingsFormValues);
      if (immediate) {
        void flushSettingsSave();
      }
    },
    [flushSettingsSave, settingsForm],
  );

  useEffect(() => {
    const prompted = localStorage.getItem(uploadPolicyStorageKey);
    if (!prompted) {
      setShowUploadPolicyModal(true);
    }
  }, []);

  useEffect(() => {
    void api.authServersList().then(setAuthServers);
    void api.syncLoggedUser().then(setLoggedUser);
  }, [syncState]);

  useEffect(() => {
    if (driveTab !== "config") return;

    // Buscar lista atualizada do GitHub, fallback pra lista local
    void api.authServersFetchRemote()
      .then(setAuthServers)
      .catch(() => void api.authServersList().then(setAuthServers).catch(() => setAuthServers([])));
  }, [driveTab]);

  useEffect(() => {
    if (driveTab !== "config" || authServers.length === 0) return;

    setServerPings({});
    for (const server of authServers) {
      const start = performance.now();
      tauriFetch(server.address, { method: "GET" })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          setServerPings((prev) => ({ ...prev, [server.id]: Math.round(performance.now() - start) }));
        })
        .catch(() => {
          setServerPings((prev) => ({ ...prev, [server.id]: null }));
        });
    }
  }, [authServers]);

  async function handleRunSync(action: "login" | "push" | "pull") {
    if (syncBusy) {
      return;
    }
    setSyncBusy(true);
    setSyncAction(action);
    try {
      await runSync(action);
    } finally {
      setSyncBusy(false);
      setSyncAction(null);
    }
  }

  async function handleCancelSync() {
    if (!syncBusy) {
      return;
    }
    await syncCancel();
    setSyncBusy(false);
    setSyncAction(null);
  }

  async function handleSelectServer(id: string) {
    if (syncBusy) {
      await handleCancelSync();
    }
    await saveSettings({ ...settings, selected_auth_server_id: id }, { silent: true });
  }

  async function handleSaveServer() {
    const label = serverDraft.label.trim();
    const address = serverDraft.address.trim();
    if (!label || !address) {
      return;
    }
    const payload: AuthServer = {
      id: serverDraft.id || `local:${Date.now()}`,
      label,
      address,
      author: serverDraft.author.trim() || null,
      official: false,
    };
    await api.authServerSave(payload);
    const next = await api.authServersList();
    setAuthServers(next);
    setServerDraft({ id: "", label: "", address: "", author: "" });
    setShowLocalServerModal(false);
  }

  async function handleDeleteServer(id: string) {
    const target = authServers.find((server) => server.id === id);
    if (!target || !target.id.startsWith("local:")) {
      return;
    }

    await api.authServerDelete(id);
    const next = await api.authServersList();
    setAuthServers(next);
    if ((settings.selected_auth_server_id || "default") === id) {
      await saveSettings({ ...settings, selected_auth_server_id: "default" }, { silent: true });
    }
  }

  async function handleDeleteAccount() {
    const password = deleteCurrentPassword.trim();
    if (!password) {
      toast.error(t.settings.security.confirmPasswordRequired);
      return;
    }

    setDeleteAccountBusy(true);
    try {
      await api.vaultDeleteAccount(password, deleteCloudData && Boolean(loggedUser));
      setDeleteAccountOpen(false);
      setDeleteCurrentPassword("");
      setDeleteCloudData(false);
      await bootstrap();
      toast.success(t.settings.security.deleteSuccess);
    } catch (error) {
      toast.error(getError(error));
    } finally {
      setDeleteAccountBusy(false);
    }
  }

  const watchedNewPassword = passwordForm.watch("newPassword");
  const cloudConnected = Boolean(loggedUser);

  const editorOptions = useMemo(
    () => [
      { value: "internal", label: "Internal Monaco", description: "Built-in editor with syntax highlighting." },
      { value: "vscode", label: "VS Code", description: "Open files in VS Code when possible." },
      { value: "system", label: "System Default", description: "Use OS default application association." },
    ] as const,
    [],
  );
  const uploadPolicyOptions = useMemo(
    () => [
      { value: "auto", label: "Auto Upload", description: "Upload text file changes automatically after edits." },
      { value: "ask", label: "Ask Every Time", description: "Prompt before uploading modified files." },
      { value: "manual", label: "Manual Only", description: "Only upload when explicitly requested." },
    ] as const,
    [],
  );
  const serverFilterOptions = useMemo(
    () => [
      { value: "all", label: "All", description: "Show all servers regardless of status." },
      { value: "online", label: "Online", description: "Show only reachable servers." },
      { value: "offline", label: "Offline", description: "Show only unreachable servers." },
    ] as const,
    [],
  );

  function applyUploadPolicy(policy: ModifiedUploadPolicy) {
    settingsForm.setValue("modified_files_upload_policy", policy, { shouldDirty: true });
    requestSettingsSave(true);
    localStorage.setItem(uploadPolicyStorageKey, "1");
    setShowUploadPolicyModal(false);
  }

  function isUserManagedServer(server: AuthServer): boolean {
    return server.id.startsWith("local:");
  }

  const tabLabels = {
    general: t.settings.sections.application,
    sftp: t.settings.sections.sftp,
    terminal: t.settings.sections.terminal,
    sync: t.settings.sections.sync,
    security: t.settings.sections.masterPassword,
  } as const;

  const settingsTabs = useMemo(
    () => [
      { id: "general" as const, label: tabLabels.general, icon: Monitor },
      { id: "sftp" as const, label: tabLabels.sftp, icon: FolderOpen },
      { id: "terminal" as const, label: tabLabels.terminal, icon: TerminalSquare },
      { id: "sync" as const, label: tabLabels.sync, icon: RefreshCw },
      { id: "security" as const, label: tabLabels.security, icon: Shield },
    ],
    [tabLabels.general, tabLabels.security, tabLabels.sftp, tabLabels.sync, tabLabels.terminal],
  );

  const filteredServers = useMemo(() => {
    const q = serverFilter.trim().toLowerCase();
    return authServers
      .filter((server) => {
        const matchesText =
          !q ||
          server.label.toLowerCase().includes(q) ||
          server.address.toLowerCase().includes(q) ||
          (server.author?.toLowerCase().includes(q) ?? false);
        if (!matchesText) {
          return false;
        }
        if (serverFilterStatus === "all") {
          return true;
        }
        const ping = serverPings[server.id];
        if (serverFilterStatus === "online") {
          return ping !== undefined && ping !== null;
        }
        return ping === null;
      })
      .sort((left, right) => {
        const leftPing = serverPings[left.id];
        const rightPing = serverPings[right.id];
        const leftRank = leftPing !== undefined && leftPing !== null ? 0 : leftPing === null ? 2 : 1;
        const rightRank = rightPing !== undefined && rightPing !== null ? 0 : rightPing === null ? 2 : 1;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        if (leftRank === 0 && rightRank === 0) {
          return (leftPing ?? Number.POSITIVE_INFINITY) - (rightPing ?? Number.POSITIVE_INFINITY);
        }
        return left.label.localeCompare(right.label);
      });
  }, [authServers, serverFilter, serverFilterStatus, serverPings]);

  const totalServerPages = Math.max(1, Math.ceil(filteredServers.length / SERVERS_PER_PAGE));
  const resolvedServerPage = Math.min(serverPage, totalServerPages - 1);
  const pagedServers = filteredServers.slice(
    resolvedServerPage * SERVERS_PER_PAGE,
    (resolvedServerPage + 1) * SERVERS_PER_PAGE,
  );

  return (
    <div className="h-full overflow-auto bg-background px-4 py-4">
      <div className="mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t.sidebar.settings}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tabLabels[settingsTab]}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto border-b border-border/40">
          <div className="flex min-w-max gap-1">
            {settingsTabs.map((tab) => {
              const TabIcon = tab.icon;
              const active = settingsTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`relative flex items-center gap-2 rounded-t-lg px-3 py-2.5 text-sm transition-colors ${active
                    ? "bg-card text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground/90"
                    }`}
                  onClick={() => setSettingsTab(tab.id)}
                >
                  <TabIcon className="h-4 w-4" />
                  <span className="whitespace-nowrap">{tab.label}</span>
                  {active ? <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        {settingsTab === "general" ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <SettingsPanel icon={Monitor} title={t.settings.sections.application}>
              <div className="divide-y divide-border/20">
                <SettingsRow
                  title={t.settings.editor.title}
                  description={t.settings.editor.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="preferred_editor"
                      render={({ field }) => (
                        <OptionDropdown
                          value={field.value}
                          onChange={(value) => {
                            field.onChange(value);
                            requestSettingsSave(true);
                          }}
                          options={editorOptions}
                        />
                      )}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.externalCommand.title}
                  description={t.settings.externalCommand.description}
                  control={
                    <Input
                      placeholder={t.settings.externalCommand.placeholder}
                      {...settingsForm.register("external_editor_command", {
                        onBlur: () => requestSettingsSave(true),
                      })}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.inactivityLock.title}
                  description={t.settings.inactivityLock.description}
                  control={
                    <Input
                      type="number"
                      min={1}
                      {...settingsForm.register("inactivity_lock_minutes", {
                        valueAsNumber: true,
                        onBlur: () => requestSettingsSave(true),
                      })}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.debugLogs.title}
                  description={t.settings.debugLogs.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="debug_logs_enabled"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                            requestSettingsSave(true);
                          }}
                        />
                      )}
                    />
                  }
                />
              </div>
            </SettingsPanel>

            <SettingsPanel icon={FolderOpen} title={t.settings.sections.modifiedFiles}>
              <div className="divide-y divide-border/20">
                <SettingsRow
                  title={t.settings.uploadPolicy.title}
                  description={t.settings.uploadPolicy.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="modified_files_upload_policy"
                      render={({ field }) => (
                        <OptionDropdown
                          value={field.value}
                          onChange={(value) => {
                            field.onChange(value);
                            requestSettingsSave(true);
                          }}
                          options={uploadPolicyOptions}
                        />
                      )}
                    />
                  }
                />
              </div>
            </SettingsPanel>
          </div>
        ) : null}

        {settingsTab === "sftp" ? (
          <SettingsPanel icon={Server} title={t.settings.sections.sftp}>
            <div className="divide-y divide-border/20">
              <SettingsRow
                title={t.settings.sftpChunk.title}
                description={t.settings.sftpChunk.description}
                control={
                  <Input
                    type="number"
                    min={64}
                    max={8192}
                    {...settingsForm.register("sftp_chunk_size_kb", {
                      valueAsNumber: true,
                      onBlur: () => requestSettingsSave(true),
                    })}
                  />
                }
              />
              <SettingsRow
                title={t.settings.sftpReconnectDelay.title}
                description={t.settings.sftpReconnectDelay.description}
                control={
                  <Input
                    type="number"
                    min={1}
                    {...settingsForm.register("sftp_reconnect_delay_seconds", {
                      valueAsNumber: true,
                      onBlur: () => requestSettingsSave(true),
                    })}
                  />
                }
              />
            </div>
          </SettingsPanel>
        ) : null}

        {settingsTab === "terminal" ? (
          <SettingsPanel icon={TerminalSquare} title={t.settings.sections.terminal}>
            <div className="divide-y divide-border/20">
              <SettingsRow
                title={t.settings.autoReconnect.title}
                description={t.settings.autoReconnect.description}
                control={
                  <Controller
                    control={settingsForm.control}
                    name="auto_reconnect_enabled"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          requestSettingsSave(true);
                        }}
                      />
                    )}
                  />
                }
              />
              <SettingsRow
                title={t.settings.reconnectDelay.title}
                description={t.settings.reconnectDelay.description}
                control={
                  <Input
                    type="number"
                    min={1}
                    {...settingsForm.register("reconnect_delay_seconds", {
                      valueAsNumber: true,
                      onBlur: () => requestSettingsSave(true),
                    })}
                  />
                }
              />
              <SettingsRow
                title={t.settings.copyOnSelect.title}
                description={t.settings.copyOnSelect.description}
                control={
                  <Controller
                    control={settingsForm.control}
                    name="terminal_copy_on_select"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          requestSettingsSave(true);
                        }}
                      />
                    )}
                  />
                }
              />
              <SettingsRow
                title={t.settings.rightClickPaste.title}
                description={t.settings.rightClickPaste.description}
                control={
                  <Controller
                    control={settingsForm.control}
                    name="terminal_right_click_paste"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          requestSettingsSave(true);
                        }}
                      />
                    )}
                  />
                }
              />
              <SettingsRow
                title={t.settings.ctrlShiftShortcuts.title}
                description={t.settings.ctrlShiftShortcuts.description}
                control={
                  <Controller
                    control={settingsForm.control}
                    name="terminal_ctrl_shift_shortcuts"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          requestSettingsSave(true);
                        }}
                      />
                    )}
                  />
                }
              />
              <SettingsRow
                title={t.settings.knownHosts.title}
                description={t.settings.knownHosts.description}
                control={
                  <div className="flex items-center gap-2">
                    <Input
                      className="flex-1"
                      placeholder={t.settings.knownHosts.placeholder}
                      {...settingsForm.register("known_hosts_path", {
                        onBlur: () => requestSettingsSave(true),
                      })}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void open({
                          title: t.settings.knownHosts.selectDialog,
                          multiple: false,
                          directory: false,
                        }).then((value) => {
                          if (typeof value === "string") {
                            settingsForm.setValue("known_hosts_path", value, { shouldDirty: true });
                            requestSettingsSave(true);
                          }
                        })
                      }
                    >
                      {t.settings.knownHosts.selectButton}
                    </Button>
                  </div>
                }
              />
            </div>
          </SettingsPanel>
        ) : null}

        {settingsTab === "sync" ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <SettingsPanel icon={RefreshCw} title={t.settings.sections.sync}>
              <div className="divide-y divide-border/20">
                <SettingsRow
                  title={t.settings.syncAuto.title}
                  description={t.settings.syncAuto.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="sync_auto_enabled"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                            requestSettingsSave(true);
                          }}
                        />
                      )}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.syncStartup.title}
                  description={t.settings.syncStartup.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="sync_on_startup"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                            requestSettingsSave(true);
                          }}
                        />
                      )}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.syncOnSave.title}
                  description={t.settings.syncOnSave.description}
                  control={
                    <Controller
                      control={settingsForm.control}
                      name="sync_on_settings_change"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                            requestSettingsSave(true);
                          }}
                        />
                      )}
                    />
                  }
                />
                <SettingsRow
                  title={t.settings.syncInterval.title}
                  description={t.settings.syncInterval.description}
                  control={
                    <Input
                      type="number"
                      min={1}
                      className="h-8 w-24 text-xs font-mono"
                      {...settingsForm.register("sync_interval_minutes", {
                        valueAsNumber: true,
                        onBlur: () => requestSettingsSave(true),
                      })}
                    />
                  }
                />
              </div>
            </SettingsPanel>

            <SettingsPanel
              icon={Cloud}
              title={t.settings.sections.googleDrive}
              description={
                driveTab === "account"
                  ? t.settings.drive.tabAccount
                  : t.settings.drive.tabServer
              }
            >
              <div className="space-y-4 p-4">
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/40 bg-secondary/30 p-1">
                  <button
                    type="button"
                    className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200 ${driveTab === "account"
                        ? "bg-card text-foreground shadow-sm border border-border/40"
                        : "text-muted-foreground hover:text-foreground/80"
                      }`}
                    onClick={() => setDriveTab("account")}
                  >
                    <UserRound className="h-3.5 w-3.5" />
                    {t.settings.drive.tabAccount}
                  </button>
                  <button
                    type="button"
                    className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200 ${driveTab === "config"
                        ? "bg-card text-foreground shadow-sm border border-border/40"
                        : "text-muted-foreground hover:text-foreground/80"
                      }`}
                    onClick={() => setDriveTab("config")}
                  >
                    <Server className="h-3.5 w-3.5" />
                    {t.settings.drive.tabServer}
                  </button>
                </div>

                {driveTab === "account" ? (
                  <div className="space-y-3 animate-fade-in">
                    {loggedUser ? (
                      <div className="flex items-center gap-3 rounded-xl border border-success/25 bg-success/5 px-4 py-3 transition-colors">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15 text-sm font-bold text-success ring-2 ring-success/20">
                          {loggedUser.name?.[0]?.toUpperCase() ||
                            loggedUser.email?.[0]?.toUpperCase() ||
                            "?"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {loggedUser.name || t.settings.drive.userLabel}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {loggedUser.email}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-success animate-pulse-glow" />
                          <span className="text-[11px] font-medium text-success">
                            {t.settings.drive.connected}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <div className="rounded-lg border border-border/40 bg-card/50 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${syncState.status === "error"
                              ? "bg-destructive/15"
                              : syncState.status === "ok"
                                ? "bg-success/15"
                                : "bg-muted/30"
                            }`}
                        >
                          {syncState.status === "error" ? (
                            <AlertCircle className="h-3 w-3 text-destructive" />
                          ) : syncState.status === "ok" ? (
                            <CheckCircle2 className="h-3 w-3 text-success" />
                          ) : (
                            <Cloud className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-medium ${syncState.status === "error"
                                ? "text-destructive"
                                : syncState.status === "ok"
                                  ? "text-success"
                                  : "text-foreground/90"
                              }`}
                          >
                            {syncState.message}
                          </p>
                          {syncState.last_sync_at ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {t.settings.drive.lastSync.replace(
                                "{date}",
                                new Date(syncState.last_sync_at).toLocaleString()
                              )}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleRunSync("login")}
                        disabled={syncBusy}
                        className="gap-2"
                      >
                        <Cloud
                          className={`h-3.5 w-3.5 ${syncBusy ? "animate-pulse" : ""}`}
                        />
                        {syncBusy && syncAction === "login"
                          ? t.settings.drive.connecting
                          : loggedUser
                            ? t.settings.drive.reconnect
                            : t.settings.drive.connect}
                      </Button>

                      {syncBusy ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleCancelSync()}
                        >
                          {t.settings.drive.cancel}
                        </Button>
                      ) : null}

                      {loggedUser ? (
                        <div className="flex gap-2 rounded-lg border border-border/30 bg-secondary/20 p-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-2 text-xs"
                            onClick={() => void handleRunSync("push")}
                            disabled={syncBusy}
                          >
                            <CloudUpload className="h-3.5 w-3.5" />
                            {t.settings.drive.push}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-2 text-xs"
                            onClick={() => void handleRunSync("pull")}
                            disabled={syncBusy}
                          >
                            <CloudDownload className="h-3.5 w-3.5" />
                            {t.settings.drive.pull}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 animate-fade-in">
                    <div className="flex items-center justify-between rounded-lg border border-border/30 bg-card/40 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                          {t.settings.localServer.connectionTitle}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {t.settings.localServer.connectionDescription}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          setServerDraft({
                            id: "",
                            label: "",
                            address: "",
                            author: "",
                          });
                          setShowLocalServerModal(true);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t.settings.localServer.newTitle}
                      </Button>
                    </div>

                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_200px]">
                      <Input
                        placeholder={t.settings.drive.serverSearch}
                        className="h-9 text-xs"
                        value={serverFilter}
                        onChange={(event) => {
                          setServerFilter(event.target.value);
                          setServerPage(0);
                        }}
                      />
                      <OptionDropdown
                        value={serverFilterStatus}
                        onChange={(value) => {
                          setServerFilterStatus(value);
                          setServerPage(0);
                        }}
                        options={serverFilterOptions}
                      />
                    </div>

                    <div className="overflow-hidden rounded-xl border border-border/40 bg-card/30">
                      {pagedServers.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8">
                          <Server className="h-8 w-8 text-muted-foreground/30" />
                          <p className="text-xs text-muted-foreground">
                            {t.settings.drive.serverEmpty}
                          </p>
                        </div>
                      ) : (
                        pagedServers.map((server, index) => {
                          const isSelected =
                            (settings.selected_auth_server_id || "default") === server.id;
                          const ping = serverPings[server.id];

                          return (
                            <div
                              key={server.id}
                              className={`group flex cursor-pointer items-start gap-3 px-4 py-3 transition-all duration-200 ${index > 0 ? "border-t border-border/15" : ""
                                } ${isSelected
                                  ? "bg-primary/8 border-l-2 border-l-primary"
                                  : "hover:bg-accent/30 border-l-2 border-l-transparent"
                                }`}
                              onClick={() => void handleSelectServer(server.id)}
                              onKeyDown={() => { }}
                              role="button"
                              tabIndex={0}
                            >
                              <div className="mt-1 flex flex-col items-center gap-1">
                                <div
                                  className={`h-2.5 w-2.5 rounded-full ${server.id in serverPings
                                      ? ping !== null
                                        ? "bg-success"
                                        : "bg-destructive"
                                      : "bg-muted-foreground/30 animate-pulse"
                                    }`}
                                />
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {server.label}
                                  </p>
                                  {server.official ? (
                                    <span className="inline-flex items-center rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] font-semibold text-info">
                                      {t.settings.drive.official}
                                    </span>
                                  ) : null}
                                  {isSelected ? (
                                    <span className="inline-flex items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                      {t.settings.drive.active}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground font-mono">
                                  {server.address}
                                </p>
                                {server.author ? (
                                  <a
                                    href={server.author}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      if (server.author) {
                                        void api.openExternalUrl(server.author).catch(() => undefined);
                                      }
                                    }}
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                    {server.author}
                                  </a>
                                ) : null}
                              </div>

                              <div className="ml-2 flex items-center gap-2 shrink-0">
                                {server.id in serverPings ? (
                                  ping !== null ? (
                                    <span
                                      className={`rounded-md px-2 py-0.5 text-[11px] font-mono font-medium ${ping < 200
                                          ? "bg-success/10 text-success"
                                          : ping < 500
                                            ? "bg-warning/10 text-warning"
                                            : "bg-destructive/10 text-destructive"
                                        }`}
                                    >
                                      {ping}ms
                                    </span>
                                  ) : (
                                    <span className="rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-mono font-medium text-destructive">
                                      {t.settings.drive.offline}
                                    </span>
                                  )
                                ) : (
                                  <span className="text-xs text-muted-foreground animate-pulse">
                                    •••
                                  </span>
                                )}

                                {isUserManagedServer(server) ? (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setServerDraft({
                                          id: server.id,
                                          label: server.label,
                                          address: server.address,
                                          author: server.author || "",
                                        });
                                        setShowLocalServerModal(true);
                                      }}
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleDeleteServer(server.id);
                                      }}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {totalServerPages > 1 ? (
                      <div className="flex items-center justify-between pt-1">
                        <p className="text-[11px] text-muted-foreground">
                          {t.settings.drive.serverCount.replace(
                            "{count}",
                            String(filteredServers.length)
                          )}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            disabled={resolvedServerPage === 0}
                            onClick={() => setServerPage(resolvedServerPage - 1)}
                          >
                            {t.settings.drive.serverPrev}
                          </Button>
                          <span className="px-3 text-[11px] font-medium text-muted-foreground">
                            {resolvedServerPage + 1}/{totalServerPages}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            disabled={resolvedServerPage >= totalServerPages - 1}
                            onClick={() => setServerPage(resolvedServerPage + 1)}
                          >
                            {t.settings.drive.serverNext}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </SettingsPanel>
          </div>
        ) : null}

        {settingsTab === "security" ? (
          <SettingsPanel icon={Shield} title={t.settings.sections.masterPassword}>
            <div className="space-y-4 p-4">
              <div className="rounded-xl border border-destructive/35 bg-destructive/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
                  <TriangleAlert className="h-4 w-4" />
                  {t.settings.security.warningTitle}
                </p>
                <p className="mt-2 text-xs text-destructive/90">{t.settings.security.warningDescription}</p>
              </div>

              <div className="space-y-3 rounded-xl border border-border/40 bg-card/40 p-4">
                <div>
                  <p className="text-sm font-semibold text-foreground">{t.settings.security.changePasswordTitle}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t.settings.security.changePasswordDescription}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Input type="password" placeholder={t.settings.password.currentPlaceholder} {...passwordForm.register("oldPassword")} />
                  <Input type="password" placeholder={t.settings.password.newPlaceholder} {...passwordForm.register("newPassword")} />
                  <Input type="password" placeholder={t.settings.password.confirmPlaceholder} {...passwordForm.register("confirmPassword")} />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !watchedNewPassword}
                    onClick={() =>
                      void passwordForm.handleSubmit((values) =>
                        changeMasterPassword(values.oldPassword, values.newPassword, values.confirmPassword).then(() =>
                          passwordForm.reset(),
                        ),
                      )()
                    }
                  >
                    <Lock className="mr-2 h-4 w-4" /> {t.settings.password.updateButton}
                  </Button>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/40 bg-card/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{t.settings.security.deleteAccountTitle}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t.settings.security.deleteAccountDescription}</p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      setDeleteCurrentPassword("");
                      setDeleteCloudData(cloudConnected);
                      setDeleteAccountOpen(true);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t.settings.security.deleteAccountAction}
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                    {t.settings.security.totalConnections.replace("{count}", String(connections.length))}
                  </div>
                  <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                    {t.settings.security.totalKeychain.replace("{count}", String(keychainEntries.length))}
                  </div>
                  <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                    {t.settings.security.totalKnownHosts.replace("{count}", String(knownHosts.length))}
                  </div>
                </div>
              </div>
            </div>
          </SettingsPanel>
        ) : null}
      </div>

      <AppDialog
        open={deleteAccountOpen}
        title={t.settings.security.deleteModalTitle}
        description={t.settings.security.deleteModalDescription}
        onClose={() => {
          if (deleteAccountBusy) {
            return;
          }
          setDeleteAccountOpen(false);
          setDeleteCurrentPassword("");
          setDeleteCloudData(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={deleteAccountBusy}
              onClick={() => {
                setDeleteAccountOpen(false);
                setDeleteCurrentPassword("");
                setDeleteCloudData(false);
              }}
            >
              {t.common.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteAccountBusy || !deleteCurrentPassword.trim()}
              onClick={() => void handleDeleteAccount()}
            >
              {deleteAccountBusy ? t.settings.security.deletingAction : t.settings.security.deleteConfirmAction}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-destructive">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <TriangleAlert className="h-4 w-4" />
              {t.settings.security.deleteModalWarningTitle}
            </p>
            <p className="mt-2 text-xs text-destructive/90">{t.settings.security.deleteModalWarningDescription}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              {t.settings.security.totalConnections.replace("{count}", String(connections.length))}
            </div>
            <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              {t.settings.security.totalKeychain.replace("{count}", String(keychainEntries.length))}
            </div>
            <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              {t.settings.security.totalKnownHosts.replace("{count}", String(knownHosts.length))}
            </div>
          </div>

          {cloudConnected ? (
            <div className="rounded-lg border border-border/40 bg-card/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t.settings.security.deleteCloudLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t.settings.security.deleteCloudDescription}</p>
                </div>
                <Switch
                  checked={deleteCloudData}
                  disabled={deleteAccountBusy}
                  onCheckedChange={setDeleteCloudData}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
              {t.settings.security.deleteCloudUnavailable}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">{t.settings.security.confirmPasswordLabel}</label>
            <Input
              type="password"
              placeholder={t.settings.security.confirmPasswordPlaceholder}
              value={deleteCurrentPassword}
              disabled={deleteAccountBusy}
              onChange={(event) => setDeleteCurrentPassword(event.target.value)}
            />
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={showLocalServerModal}
        title={serverDraft.id ? t.settings.localServer.editTitle : t.settings.localServer.newTitle}
        description={t.settings.localServer.modalDescription}
        onClose={() => {
          setShowLocalServerModal(false);
          setServerDraft({ id: "", label: "", address: "", author: "" });
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowLocalServerModal(false);
                setServerDraft({ id: "", label: "", address: "", author: "" });
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveServer()}
              disabled={!serverDraft.label.trim() || !serverDraft.address.trim()}
            >
              {serverDraft.id ? t.settings.localServer.saveChanges : t.settings.localServer.addServer}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            placeholder={t.settings.localServer.editTitle}
            value={serverDraft.label}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, label: event.target.value }))
            }
          />
          <Input
            placeholder="https://worker.example.com"
            value={serverDraft.address}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, address: event.target.value }))
            }
          />
          <Input
            className="md:col-span-2"
            placeholder={t.settings.localServer.addServer}
            value={serverDraft.author}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, author: event.target.value }))
            }
          />
        </div>
      </AppDialog>

      {showUploadPolicyModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border/40 bg-background p-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-foreground">{t.settings.uploadPolicy.modalTitle}</h3>
            <p className="mt-2 text-sm text-foreground/90">{t.settings.uploadPolicy.modalDescription}</p>
            <div className="mt-4 flex flex-col gap-2">
              <Button type="button" onClick={() => applyUploadPolicy("auto")}>
                {t.settings.uploadPolicy.auto}
              </Button>
              <Button type="button" variant="outline" onClick={() => applyUploadPolicy("ask")}>
                {t.settings.uploadPolicy.ask}
              </Button>
              <Button type="button" variant="outline" onClick={() => applyUploadPolicy("manual")}>
                {t.settings.uploadPolicy.manual}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


