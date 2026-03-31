import { Cloud, CloudDownload, CloudUpload, ExternalLink, Lock, Save } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
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

export function SettingsPage() {
  const settings = useAppStore((state) => state.settings);
  const syncState = useAppStore((state) => state.syncState);
  const busy = useAppStore((state) => state.busy);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const runSync = useAppStore((state) => state.runSync);
  const changeMasterPassword = useAppStore((state) => state.changeMasterPassword);

  const [showUploadPolicyModal, setShowUploadPolicyModal] = useState(false);
  const [authServers, setAuthServers] = useState<AuthServer[]>([]);
  const [loggedUser, setLoggedUser] = useState<{ name: string; email: string } | null>(null);
  const [driveTab, setDriveTab] = useState<"account" | "config">("account");
  const [serverPings, setServerPings] = useState<Record<string, number | null>>({});
  const [serverFilter, setServerFilter] = useState("");
  const [serverFilterStatus, setServerFilterStatus] = useState<"all" | "online" | "offline">("all");
  const [serverPage, setServerPage] = useState(0);
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

  function handleSelectServer(id: string) {
    void saveSettings({ ...settings, selected_auth_server_id: id });
  }

  const watchedNewPassword = passwordForm.watch("newPassword");

  function applyUploadPolicy(policy: ModifiedUploadPolicy) {
    const next = { ...settings, modified_files_upload_policy: policy };
    settingsForm.setValue("modified_files_upload_policy", policy);
    void saveSettings(next);
    localStorage.setItem(uploadPolicyStorageKey, "1");
    setShowUploadPolicyModal(false);
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
            inactivity_lock_minutes: values.inactivity_lock_minutes || 10,
            reconnect_delay_seconds: values.reconnect_delay_seconds || 5,
          }),
        )}
      >
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Aplicacao</h3>
          <SettingsRow
            title="Editor padrao"
            description="Defina se o arquivo abre no editor interno, VS Code ou no sistema."
            control={
              <select
                className="h-9 w-full rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
                {...settingsForm.register("preferred_editor")}
              >
                <option value="internal">Interno (Monaco)</option>
                <option value="vscode">VS Code</option>
                <option value="system">Sistema</option>
              </select>
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

        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Sync e Conectividade</h3>
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

        <section className="mt-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Arquivos Modificados</h3>
          <SettingsRow
            title="Upload de alteracoes"
            description="Define como arquivos alterados no editor interno devem ser enviados."
            control={
              <select
                className="h-9 w-full rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
                {...settingsForm.register("modified_files_upload_policy")}
              >
                <option value="auto">Enviar automaticamente</option>
                <option value="ask">Perguntar sempre</option>
                <option value="manual">Somente manual</option>
              </select>
            }
          />
        </section>

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
                  <Button type="button" onClick={() => void runSync("login")}>
                    <Cloud className="mr-2 h-4 w-4" /> {loggedUser ? "Reconectar" : "Conectar"}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void runSync("push")} disabled={!loggedUser}>
                    <CloudUpload className="mr-2 h-4 w-4" /> Push
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void runSync("pull")} disabled={!loggedUser}>
                    <CloudDownload className="mr-2 h-4 w-4" /> Pull
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Input
                    placeholder="Buscar servidor..."
                    className="h-8 flex-1 text-xs"
                    value={serverFilter}
                    onChange={(e) => { setServerFilter(e.target.value); setServerPage(0); }}
                  />
                  <select
                    className="h-8 rounded-md border border-white/15 bg-zinc-900 px-2 text-xs text-zinc-100"
                    value={serverFilterStatus}
                    onChange={(e) => { setServerFilterStatus(e.target.value as "all" | "online" | "offline"); setServerPage(0); }}
                  >
                    <option value="all">Todos</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </select>
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
                              onClick={() => handleSelectServer(server.id)}
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

        <div className="flex justify-end py-4">
          <Button type="submit" disabled={busy}>
            <Save className="mr-2 h-4 w-4" /> Salvar Configuracoes
          </Button>
        </div>
      </form>

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
