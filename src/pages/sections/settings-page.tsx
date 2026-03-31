import { Cloud, CloudDownload, CloudUpload, Lock, Save } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAppStore } from "@/store/app-store";
import type { AppSettings, ModifiedUploadPolicy } from "@/types/termopen";

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
            <p className="text-sm text-zinc-300">{syncState.message}</p>
            <p className="mt-1 text-xs text-zinc-500">
              Escopo usado: <code>drive.file</code>. Configure OAuth Client do tipo Desktop App no Google Cloud e
              exporte <code>TERMOPEN_GOOGLE_CLIENT_ID</code>.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" onClick={() => void runSync("login")}>
                <Cloud className="mr-2 h-4 w-4" /> Conectar
              </Button>
              <Button type="button" variant="outline" onClick={() => void runSync("push")}>
                <CloudUpload className="mr-2 h-4 w-4" /> Push
              </Button>
              <Button type="button" variant="outline" onClick={() => void runSync("pull")}>
                <CloudDownload className="mr-2 h-4 w-4" /> Pull
              </Button>
            </div>
            <div className="mt-3 space-y-1 text-xs text-zinc-500">
              <p>Como configurar:</p>
              <p>1. Crie OAuth Client (Desktop App) no Google Cloud.</p>
              <p>2. Ative Google Drive API.</p>
              <p>3. Defina TERMOPEN_GOOGLE_CLIENT_ID (e secret se seu projeto exigir).</p>
            </div>
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
