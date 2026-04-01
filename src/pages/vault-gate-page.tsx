import { Cloud, KeyRound, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getError } from "@/functions/common";
import { LOCALE_LABELS, useI18n, useT, type Locale } from "@/langs";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/store/app-store";
import type { AuthServer } from "@/types/termopen";

interface InitFormValues {
  password: string;
  confirm_password: string;
}

interface UnlockFormValues {
  password: string;
}

export function VaultGatePage() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const status = useAppStore((state) => state.vaultStatus);
  const busy = useAppStore((state) => state.busy);
  const vaultInit = useAppStore((state) => state.vaultInit);
  const vaultUnlock = useAppStore((state) => state.vaultUnlock);
  const loadWorkspace = useAppStore((state) => state.loadWorkspace);
  const bootstrap = useAppStore((state) => state.bootstrap);

  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState<"server" | "password" | "downloading">("server");
  const [servers, setServers] = useState<AuthServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("default");
  const [recoverPassword, setRecoverPassword] = useState("");
  const [recoverAttempts, setRecoverAttempts] = useState(0);
  const [recoverBusy, setRecoverBusy] = useState(false);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const initForm = useForm<InitFormValues>({
    defaultValues: {
      password: "",
      confirm_password: "",
    },
  });
  const unlockForm = useForm<UnlockFormValues>({
    defaultValues: {
      password: "",
    },
  });

  const initPassword = initForm.watch("password");
  const initConfirmPassword = initForm.watch("confirm_password");
  const isInit = !status?.initialized;

  const selectedServer = useMemo(
    () => servers.find((item) => item.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );

  useEffect(() => {
    if (!recoverOpen) {
      return;
    }
    void api
      .authServersFetchRemote()
      .catch(() => api.authServersList())
      .then((data) => {
        setServers(data);
        const first = data[0]?.id ?? "default";
        setSelectedServerId((current) => (data.some((item) => item.id === current) ? current : first));
      })
      .catch(() => setServers([]));
  }, [recoverOpen]);

  if (!status) {
    return <main className="h-full w-full bg-zinc-950" />;
  }

  async function handleRecoveryLogin() {
    if (!selectedServer) {
      toast.error(t.vault.recovery.selectServer);
      return;
    }

    setRecoverBusy(true);
    try {
      await api.syncGoogleLogin(selectedServer.address);
      const probe = await api.syncRecoveryProbe(selectedServer.address);
      if (!probe.found) {
        toast.error(probe.message);
        setRecoverOpen(false);
        setRecoveryStep("server");
        setRecoverAttempts(0);
        setRecoverPassword("");
        return;
      }
      setRecoveryStep("password");
      toast.success(t.vault.recovery.backupFound);
    } catch (error) {
      toast.error(getError(error));
    } finally {
      setRecoverBusy(false);
    }
  }

  async function handleRecoveryRestore() {
    if (!selectedServer) {
      toast.error(t.vault.recovery.invalidServer);
      return;
    }
    if (!recoverPassword.trim()) {
      toast.error(t.vault.recovery.enterPassword);
      return;
    }

    setRecoverBusy(true);
    setRecoveryStep("downloading");
    try {
      const nextStatus = await api.syncRecoveryRestore(recoverPassword, selectedServer.address);
      useAppStore.setState({ vaultStatus: nextStatus });
      setRecoverOpen(false);
      setRecoverPassword("");
      setRecoverAttempts(0);
      await loadWorkspace();
      toast.success(t.vault.recovery.restoreSuccess);
    } catch (error) {
      const attempts = recoverAttempts + 1;
      setRecoverAttempts(attempts);
      setRecoveryStep("password");
      toast.error(getError(error));
      if (attempts >= 5) {
        toast.error(t.vault.recovery.limitReached);
        setRecoverOpen(false);
        setRecoverAttempts(0);
        setRecoverPassword("");
        setRecoveryStep("server");
      }
    } finally {
      setRecoverBusy(false);
    }
  }

  async function handleDeleteAllData() {
    if (deleteInput.trim() !== t.vault.forgot.confirmPhrase) {
      toast.error(t.vault.forgot.confirmError);
      return;
    }

    setDeleteBusy(true);
    try {
      await api.vaultResetAll();
      setForgotOpen(false);
      setDeleteInput("");
      await bootstrap();
      toast.success(t.vault.forgot.deleteSuccess);
    } catch (error) {
      toast.error(getError(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-zinc-950 px-8">
      <div className="absolute right-4 top-4">
        <select
          className="h-8 rounded-md border border-white/15 bg-zinc-900 px-2 text-xs text-zinc-400"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {Object.entries(LOCALE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-white/5">
            <span className="text-lg font-semibold">TO</span>
          </div>
          <h1 className="text-2xl font-semibold text-zinc-100">TermOpen</h1>
        </div>

        {isInit ? (
          <>
            <form
              className="space-y-5"
              onSubmit={initForm.handleSubmit((values) => {
                if (values.password !== values.confirm_password) {
                  toast.error(t.vault.init.mismatch);
                  return;
                }
                void vaultInit(values.password);
                initForm.reset({ password: "", confirm_password: "" });
              })}
            >
              <Input
                type="password"
                placeholder={t.vault.init.passwordPlaceholder}
                className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
                {...initForm.register("password")}
              />
              <Input
                type="password"
                placeholder={t.vault.init.confirmPlaceholder}
                className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
                {...initForm.register("confirm_password")}
              />
              <Button
                className="mt-2 w-full"
                type="submit"
                disabled={busy || initPassword.length < 6 || initConfirmPassword.length < 6}
              >
                <KeyRound className="mr-2 h-4 w-4" /> {t.vault.init.submit}
              </Button>
            </form>

            <Button
              type="button"
              variant="outline"
              className="mt-4 w-full"
              disabled={busy}
              onClick={() => {
                setRecoverOpen(true);
                setRecoveryStep("server");
                setRecoverAttempts(0);
                setRecoverPassword("");
              }}
            >
              <Cloud className="mr-2 h-4 w-4" /> {t.vault.recovery.loginButton}
            </Button>
          </>
        ) : (
          <form
            className="space-y-5"
            onSubmit={unlockForm.handleSubmit((values) => {
              void vaultUnlock(values.password.trim() ? values.password : null);
              unlockForm.reset({ password: "" });
            })}
          >
            <Input
              type="password"
              placeholder={t.vault.unlock.passwordPlaceholder}
              className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
              {...unlockForm.register("password")}
            />
            <Button className="mt-2 w-full" type="submit" disabled={busy}>
              <Lock className="mr-2 h-4 w-4" /> {t.vault.unlock.submit}
            </Button>
            <button
              type="button"
              className="w-full text-xs text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
              onClick={() => setForgotOpen(true)}
            >
              {t.vault.unlock.forgotPassword}
            </button>
          </form>
        )}
      </div>

      <Dialog
        open={recoverOpen}
        title={t.vault.recovery.title}
        description={t.vault.recovery.description}
        onClose={() => {
          if (recoverBusy) return;
          setRecoverOpen(false);
        }}
        footer={
          recoveryStep === "server" ? (
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRecoverOpen(false)}
                disabled={recoverBusy}
              >
                {t.common.cancel}
              </Button>
              <Button type="button" onClick={() => void handleRecoveryLogin()} disabled={recoverBusy}>
                {recoverBusy ? t.vault.recovery.connecting : t.vault.recovery.loginGoogle}
              </Button>
            </div>
          ) : recoveryStep === "password" ? (
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRecoverOpen(false)}
                disabled={recoverBusy}
              >
                {t.common.cancel}
              </Button>
              <Button type="button" onClick={() => void handleRecoveryRestore()} disabled={recoverBusy}>
                {recoverBusy ? t.vault.recovery.validating : t.vault.recovery.restoreButton}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button type="button" disabled>
                {t.vault.recovery.downloading}
              </Button>
            </div>
          )
        }
      >
        {recoveryStep === "server" ? (
          <div className="space-y-3">
            <label className="text-sm text-zinc-300">{t.vault.recovery.serverLabel}</label>
            <select
              className="h-10 w-full rounded-md border border-white/20 bg-zinc-900 px-3 text-sm text-zinc-100"
              value={selectedServerId}
              onChange={(event) => setSelectedServerId(event.target.value)}
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.label}
                </option>
              ))}
            </select>
          </div>
        ) : recoveryStep === "password" ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">
              {t.vault.recovery.backupFound}
            </p>
            <Input
              type="password"
              placeholder={t.vault.unlock.passwordPlaceholder}
              value={recoverPassword}
              onChange={(event) => setRecoverPassword(event.target.value)}
            />
            <p className="text-xs text-zinc-500">{t.vault.recovery.attempts.replace("{count}", String(recoverAttempts))}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-zinc-300">{t.vault.recovery.downloadingInfo}</p>
            <p className="text-xs text-zinc-500">{t.vault.recovery.downloadingWait}</p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={forgotOpen}
        title={t.vault.forgot.title}
        description={t.vault.forgot.description}
        onClose={() => {
          if (deleteBusy) return;
          setForgotOpen(false);
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setForgotOpen(false)}
              disabled={deleteBusy}
            >
              {t.common.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteAllData()}
              disabled={deleteBusy || deleteInput.trim() !== t.vault.forgot.confirmPhrase}
            >
              {deleteBusy ? t.vault.forgot.deleting : t.vault.forgot.deleteButton}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4" />
              {t.vault.forgot.warning}
            </p>
            <p className="mt-2 text-xs text-red-100/90">
              {t.vault.forgot.explanation}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-zinc-400">
              {t.vault.forgot.confirmLabel}
            </label>
            <Input
              placeholder={t.vault.forgot.confirmPlaceholder}
              value={deleteInput}
              onChange={(event) => setDeleteInput(event.target.value)}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
