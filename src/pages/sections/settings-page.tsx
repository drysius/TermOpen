import { ChevronDown, Cloud, CloudDownload, CloudUpload, ExternalLink, Lock, Save, Server } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAppStore } from "@/store/app-store";
import { api } from "@/lib/tauri";
import type { AppSettings, AuthServer, ModifiedUploadPolicy } from "@/types/termopen";

interface SettingsFormValues extends AppSettings {}

interface PasswordFormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const uploadPolicyStorageKey = "termopen.upload-policy.prompted";

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-b border-white/10 py-3 md:grid-cols-[260px_1fr] md:items-center">
      <div>
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-400">{description}</p>
      </div>
      <div>{control}</div>
    </div>
  );
}

function OptionDropdown<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; description: string }>;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((item) => item.value === value) ?? options[0];

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="flex h-10 w-full items-center justify-between rounded-md border border-white/15 bg-zinc-900 px-3 text-left text-sm text-zinc-100"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label}</span>
        <ChevronDown className={`h-4 w-4 text-zinc-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {selected?.description ? (
        <p className="mt-1 text-xs text-zinc-500">{selected.description}</p>
      ) : null}
      {open ? (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`w-full rounded px-2 py-2 text-left transition ${
                option.value === value ? "bg-purple-600/20 text-purple-100" : "text-zinc-300 hover:bg-zinc-900"
              }`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <p className="text-xs font-medium">{option.label}</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{option.description}</p>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const settings = useAppStore((state) => state.settings);
  const syncState = useAppStore((state) => state.syncState);
  const busy = useAppStore((state) => state.busy);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const runSync = useAppStore((state) => state.runSync);
  const syncCancel = useAppStore((state) => state.syncCancel);
  const changeMasterPassword = useAppStore((state) => state.changeMasterPassword);

  const [showUploadPolicyModal, setShowUploadPolicyModal] = useState(false);
  const [authServers, setAuthServers] = useState<AuthServer[]>([]);
  const [loggedUser, setLoggedUser] = useState<{ name: string; email: string } | null>(null);
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

  useEffect(() => {
    settingsForm.reset(settings);
  }, [settings, settingsForm]);

  useEffect(() => {
    const prompted = localStorage.getItem(uploadPolicyStorageKey);
    if (!prompted) {
      setShowUploadPolicyModal(true);
    }
  }, []);

  useEffect(() => {
    void api.authServersList().then(setAuthServers);
    void api.syncLoggedUser().then((data) => {
      if (data) setLoggedUser({ name: data[0], email: data[1] });
    });
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
      fetch(server.address, { mode: "cors" })
        .then(() => {
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
    await saveSettings({ ...settings, selected_auth_server_id: id });
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
      await saveSettings({ ...settings, selected_auth_server_id: "default" });
    }
  }

  const watchedNewPassword = passwordForm.watch("newPassword");

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
    const next = { ...settings, modified_files_upload_policy: policy };
    settingsForm.setValue("modified_files_upload_policy", policy);
    void saveSettings(next);
    localStorage.setItem(uploadPolicyStorageKey, "1");
    setShowUploadPolicyModal(false);
  }

  function isUserManagedServer(server: AuthServer): boolean {
    return server.id.startsWith("local:");
  }

  return (
    <div className="h-full overflow-auto px-4 py-3">
      <form
        onSubmit={settingsForm.handleSubmit((values) =>
          void saveSettings({
            ...values,
            external_editor_command: values.external_editor_command?.trim() ?? "",
            known_hosts_path: values.known_hosts_path?.trim() ?? "",
            sync_interval_minutes: values.sync_interval_minutes || 5,
            sftp_chunk_size_kb: values.sftp_chunk_size_kb || 1024,
            sftp_reconnect_delay_seconds: values.sftp_reconnect_delay_seconds || 5,
            inactivity_lock_minutes: values.inactivity_lock_minutes || 10,
            reconnect_delay_seconds: values.reconnect_delay_seconds || 5,
          }),
        )}
      >
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-zinc-950/40 p-1 text-xs md:grid-cols-5">
          {[
            { id: "general", label: "General" },
            { id: "sftp", label: "SFTP" },
            { id: "terminal", label: "Terminal" },
            { id: "sync", label: "Synchronization" },
            { id: "security", label: "Security" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded px-2 py-1.5 transition ${
                settingsTab === tab.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
              }`}
              onClick={() => setSettingsTab(tab.id as typeof settingsTab)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {settingsTab === "general" ? (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Aplicacao</h3>
          <SettingsRow
            title="Editor padrao"
            description="Defina se o arquivo abre no editor interno, VS Code ou no sistema."
            control={
              <Controller
                control={settingsForm.control}
                name="preferred_editor"
                render={({ field }) => (
                  <OptionDropdown
                    value={field.value}
                    onChange={field.onChange}
                    options={editorOptions}
                  />
                )}
              />
            }
          />
          <SettingsRow
            title="Comando externo"
            description="Comando custom para abrir editor externo. Use {filename} no comando."
            control={<Input placeholder="ex: kitty -e nvim {filename}" {...settingsForm.register("external_editor_command")} />}
          />
          <SettingsRow
            title="Bloqueio por inatividade"
            description="Tempo em minutos para bloquear o vault automaticamente."
            control={<Input type="number" min={1} {...settingsForm.register("inactivity_lock_minutes", { valueAsNumber: true })} />}
          />
        </section>
        ) : null}

        {settingsTab === "sync" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Synchronization</h3>
          <SettingsRow
            title="Sync automatico"
            description="Sincroniza periodicamente quando conectado ao Google Drive."
            control={
              <Controller
                control={settingsForm.control}
                name="sync_auto_enabled"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Sync no startup"
            description="Executa pull automaticamente ao desbloquear o vault."
            control={
              <Controller
                control={settingsForm.control}
                name="sync_on_startup"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Sync ao salvar configuracoes"
            description="Quando configuracoes mudarem, executa push automaticamente."
            control={
              <Controller
                control={settingsForm.control}
                name="sync_on_settings_change"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Intervalo de sync"
            description="Frequencia em minutos da sincronizacao automatica."
            control={<Input type="number" min={1} {...settingsForm.register("sync_interval_minutes", { valueAsNumber: true })} />}
          />
        </section>
        ) : null}

        {settingsTab === "sftp" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">SFTP</h3>
          <SettingsRow
            title="Chunk SFTP (KB)"
            description="Tamanho do bloco usado em leituras/escritas e transferencias SFTP."
            control={
              <Input
                type="number"
                min={64}
                max={8192}
                {...settingsForm.register("sftp_chunk_size_kb", { valueAsNumber: true })}
              />
            }
          />
          <SettingsRow
            title="Delay de reconnect SFTP"
            description="Tempo em segundos para tentar novamente em timeout de conexao/listagem inicial."
            control={
              <Input
                type="number"
                min={1}
                {...settingsForm.register("sftp_reconnect_delay_seconds", { valueAsNumber: true })}
              />
            }
          />
        </section>
        ) : null}

        {settingsTab === "terminal" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Terminal</h3>
          <SettingsRow
            title="Auto reconnect SSH"
            description="Tenta reconectar sessoes SSH desconectadas automaticamente."
            control={
              <Controller
                control={settingsForm.control}
                name="auto_reconnect_enabled"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Delay de reconnect"
            description="Tempo de espera em segundos antes de tentar reconectar."
            control={<Input type="number" min={1} {...settingsForm.register("reconnect_delay_seconds", { valueAsNumber: true })} />}
          />
          <SettingsRow
            title="Copy on select"
            description="Copia automaticamente o texto selecionado no terminal."
            control={
              <Controller
                control={settingsForm.control}
                name="terminal_copy_on_select"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Paste no clique direito"
            description="Permite colar com botao direito dentro do bloco de terminal."
            control={
              <Controller
                control={settingsForm.control}
                name="terminal_right_click_paste"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Atalhos Ctrl+Shift"
            description="Ativa Ctrl+Shift+C/V para copiar e colar no terminal."
            control={
              <Controller
                control={settingsForm.control}
                name="terminal_ctrl_shift_shortcuts"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            }
          />
          <SettingsRow
            title="Known Hosts"
            description="Caminho do arquivo known_hosts usado pelo ambiente SSH."
            control={
              <div className="flex items-center gap-2">
                <Input className="flex-1" placeholder="~/.ssh/known_hosts" {...settingsForm.register("known_hosts_path")} />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void open({
                      title: "Selecionar arquivo known_hosts",
                      multiple: false,
                      directory: false,
                    }).then((value) => {
                      if (typeof value === "string") {
                        settingsForm.setValue("known_hosts_path", value);
                      }
                    })
                  }
                >
                  Selecionar
                </Button>
              </div>
            }
          />
        </section>
        ) : null}

        {settingsTab === "general" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Arquivos Modificados</h3>
          <SettingsRow
            title="Upload de alteracoes"
            description="Define como arquivos alterados no editor interno devem ser enviados."
            control={
              <Controller
                control={settingsForm.control}
                name="modified_files_upload_policy"
                render={({ field }) => (
                  <OptionDropdown
                    value={field.value}
                    onChange={field.onChange}
                    options={uploadPolicyOptions}
                  />
                )}
              />
            }
          />
        </section>
        ) : null}

        {settingsTab === "sync" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Google Drive</h3>
          <div className="border-b border-white/10 py-3">
            <div className="mb-3 flex gap-1 rounded-md bg-zinc-900/50 p-0.5">
              <button
                type="button"
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  driveTab === "account"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                onClick={() => setDriveTab("account")}
              >
                Conta
              </button>
              <button
                type="button"
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  driveTab === "config"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                onClick={() => setDriveTab("config")}
              >
                Servidor
              </button>
            </div>

            {driveTab === "account" ? (
              <div>
                {loggedUser ? (
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-semibold text-emerald-400">
                      {loggedUser.name?.[0]?.toUpperCase() || loggedUser.email?.[0]?.toUpperCase() || "?"}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100">{loggedUser.name || "Usuario"}</p>
                      <p className="text-xs text-zinc-500">{loggedUser.email}</p>
                    </div>
                    <span className="ml-auto rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400">
                      Conectado
                    </span>
                  </div>
                ) : null}
                <p className={`text-sm ${syncState.status === "error" ? "text-red-400" : syncState.status === "ok" ? "text-emerald-400" : "text-zinc-300"}`}>
                  {syncState.message}
                </p>
                {syncState.last_sync_at ? (
                  <p className="mt-1 text-xs text-zinc-500">
                    Ultimo sync: {new Date(syncState.last_sync_at).toLocaleString("pt-BR")}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void handleRunSync("login")} disabled={syncBusy}>
                    <Cloud className={`mr-2 h-4 w-4 ${syncBusy ? "animate-pulse" : ""}`} />
                    {syncBusy && syncAction === "login"
                      ? "Conectando..."
                      : loggedUser
                        ? "Reconectar"
                        : "Conectar"}
                  </Button>
                  {syncBusy ? (
                    <Button type="button" variant="outline" onClick={() => void handleCancelSync()}>
                      Cancelar
                    </Button>
                  ) : null}
                  {loggedUser ? (
                    <>
                      <Button type="button" variant="outline" onClick={() => void handleRunSync("push")} disabled={syncBusy}>
                        <CloudUpload className="mr-2 h-4 w-4" /> Push
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void handleRunSync("pull")} disabled={syncBusy}>
                        <CloudDownload className="mr-2 h-4 w-4" /> Pull
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-3 flex items-center justify-between rounded-md border border-white/10 bg-zinc-900/30 px-3 py-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Local Server</p>
                    <p className="text-xs text-zinc-500">Adicione ou edite servidores locais em uma modal dedicada.</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setServerDraft({ id: "", label: "", address: "", author: "" });
                      setShowLocalServerModal(true);
                    }}
                  >
                    <Server className="mr-2 h-4 w-4" /> Novo Local Server
                  </Button>
                </div>

                <div className="mb-2 flex items-center gap-2">
                  <Input
                    placeholder="Buscar servidor..."
                    className="h-8 flex-1 text-xs"
                    value={serverFilter}
                    onChange={(e) => { setServerFilter(e.target.value); setServerPage(0); }}
                  />
                  <div className="min-w-[180px]">
                    <OptionDropdown
                      value={serverFilterStatus}
                      onChange={(value) => {
                        setServerFilterStatus(value);
                        setServerPage(0);
                      }}
                      options={serverFilterOptions}
                    />
                  </div>
                </div>

                {(() => {
                  const q = serverFilter.toLowerCase();
                  const filtered = authServers
                    .filter((s) => {
                      const matchesText = !q || s.label.toLowerCase().includes(q) || s.address.toLowerCase().includes(q) || (s.author?.toLowerCase().includes(q) ?? false);
                      if (!matchesText) return false;
                      if (serverFilterStatus === "all") return true;
                      const ping = serverPings[s.id];
                      if (serverFilterStatus === "online") return ping !== undefined && ping !== null;
                      return ping === null;
                    })
                    .sort((a, b) => {
                      const pa = serverPings[a.id];
                      const pb = serverPings[b.id];
                      const aOnline = pa !== undefined && pa !== null ? 0 : pa === null ? 2 : 1;
                      const bOnline = pb !== undefined && pb !== null ? 0 : pb === null ? 2 : 1;
                      if (aOnline !== bOnline) return aOnline - bOnline;
                      if (aOnline === 0 && bOnline === 0) return pa! - pb!;
                      return 0;
                    });
                  const totalPages = Math.max(1, Math.ceil(filtered.length / SERVERS_PER_PAGE));
                  const page = Math.min(serverPage, totalPages - 1);
                  const paged = filtered.slice(page * SERVERS_PER_PAGE, (page + 1) * SERVERS_PER_PAGE);

                  return (
                    <>
                      <div className="space-y-1">
                        {paged.map((server) => {
                          const isSelected = (settings.selected_auth_server_id || "default") === server.id;
                          const ping = serverPings[server.id];
                          return (
                            <div
                              key={server.id}
                              className={`flex items-center justify-between rounded-md border px-3 py-2 transition-colors cursor-pointer ${
                                isSelected
                                  ? "border-emerald-500/50 bg-emerald-500/10"
                                  : "border-white/10 bg-zinc-900/30 hover:bg-zinc-900/60"
                              }`}
                              onClick={() => void handleSelectServer(server.id)}
                              onKeyDown={() => {}}
                              role="button"
                              tabIndex={0}
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-zinc-100">
                                  {server.label}
                                  {server.official ? (
                                    <span className="ml-1.5 inline-block rounded bg-blue-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-blue-400">
                                      Oficial
                                    </span>
                                  ) : null}
                                </p>
                                <p className="truncate text-xs text-zinc-500">{server.address}</p>
                                {server.author ? (
                                  <a
                                    href={server.author}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <ExternalLink className="h-3 w-3" /> {server.author}
                                  </a>
                                ) : null}
                              </div>
                              <div className="ml-2 flex items-center gap-2">
                                {server.id in serverPings ? (
                                  ping !== null ? (
                                    <span className={`text-xs font-mono ${
                                      ping! < 200 ? "text-emerald-400" :
                                      ping! < 500 ? "text-yellow-400" : "text-orange-400"
                                    }`}>
                                      {ping}ms
                                    </span>
                                  ) : (
                                    <span className="text-xs font-mono text-red-400">offline</span>
                                  )
                                ) : (
                                  <span className="text-xs text-zinc-600">...</span>
                                )}
                                {isSelected ? (
                                  <span className="text-xs font-medium text-emerald-400">Ativo</span>
                                ) : null}
                                {isUserManagedServer(server) ? (
                                  <>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[11px]"
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
                                      Edit
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[11px] text-red-300 hover:text-red-200"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleDeleteServer(server.id);
                                      }}
                                    >
                                      Delete
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                        {paged.length === 0 ? (
                          <p className="py-4 text-center text-xs text-zinc-500">Nenhum servidor encontrado.</p>
                        ) : null}
                      </div>

                      {totalPages > 1 ? (
                        <div className="mt-2 flex items-center justify-between">
                          <p className="text-xs text-zinc-500">{filtered.length} servidor{filtered.length !== 1 ? "es" : ""}</p>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              disabled={page === 0}
                              onClick={() => setServerPage(page - 1)}
                            >
                              Anterior
                            </Button>
                            <span className="flex items-center px-2 text-xs text-zinc-500">
                              {page + 1}/{totalPages}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              disabled={page >= totalPages - 1}
                              onClick={() => setServerPage(page + 1)}
                            >
                              Proximo
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </section>
        ) : null}

        {settingsTab === "security" ? (
        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Senha Mestre</h3>
          <div className="grid gap-2 border-b border-white/10 py-3 md:grid-cols-3">
            <Input type="password" placeholder="Senha atual" {...passwordForm.register("oldPassword")} />
            <Input type="password" placeholder="Nova senha" {...passwordForm.register("newPassword")} />
            <Input type="password" placeholder="Confirmar" {...passwordForm.register("confirmPassword")} />
            <div className="md:col-span-3 md:flex md:justify-end">
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
                <Lock className="mr-2 h-4 w-4" /> Atualizar Senha
              </Button>
            </div>
          </div>
        </section>
        ) : null}

        <div className="flex justify-end py-4">
          <Button type="submit" disabled={busy}>
            <Save className="mr-2 h-4 w-4" /> Salvar Configuracoes
          </Button>
        </div>
      </form>

      <Dialog
        open={showLocalServerModal}
        title={serverDraft.id ? "Editar Local Server" : "Novo Local Server"}
        description="Configure label, endereco e autor para o servidor local."
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
              {serverDraft.id ? "Salvar alteracoes" : "Adicionar servidor"}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            placeholder="Server label"
            value={serverDraft.label}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, label: event.target.value }))
            }
          />
          <Input
            placeholder="https://my-worker.example.com"
            value={serverDraft.address}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, address: event.target.value }))
            }
          />
          <Input
            className="md:col-span-2"
            placeholder="Author URL (optional)"
            value={serverDraft.author}
            onChange={(event) =>
              setServerDraft((current) => ({ ...current, author: event.target.value }))
            }
          />
        </div>
      </Dialog>

      {showUploadPolicyModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-lg border border-white/10 bg-zinc-950 p-4">
            <h3 className="text-sm font-semibold text-zinc-100">Upload de arquivos modificados</h3>
            <p className="mt-2 text-sm text-zinc-300">
              Como o TermOpen deve tratar arquivos modificados no workspace remoto?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button type="button" onClick={() => applyUploadPolicy("auto")}>
                Enviar automaticamente
              </Button>
              <Button type="button" variant="outline" onClick={() => applyUploadPolicy("ask")}>
                Perguntar sempre
              </Button>
              <Button type="button" variant="outline" onClick={() => applyUploadPolicy("manual")}>
                Somente manual
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
