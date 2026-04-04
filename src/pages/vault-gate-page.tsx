import { ArrowLeft, ArrowRight, Cloud, KeyRound, Lock, Shield, Terminal, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/app-dialog";
import { Input } from "@/components/ui/input";
import { getError } from "@/functions/common";
import { LOCALE_LABELS, useI18n, useT, type Locale } from "@/langs";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/store/app-store";
import type { AuthServer } from "@/types/openptl";

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
  const [showIntro, setShowIntro] = useState(false);
  const [introStep, setIntroStep] = useState(0);

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
  const introSteps = useMemo(
    () => [
      {
        icon: Terminal,
        title: t.vault.intro.stepWelcomeTitle,
        description: t.vault.intro.stepWelcomeDescription,
        details: [
          t.vault.intro.stepWelcomePointOne,
          t.vault.intro.stepWelcomePointTwo,
          t.vault.intro.stepWelcomePointThree,
        ],
      },
      {
        icon: Cloud,
        title: t.vault.intro.stepDriveTitle,
        description: t.vault.intro.stepDriveDescription,
        details: [
          t.vault.intro.stepDrivePointOne,
          t.vault.intro.stepDrivePointTwo,
          t.vault.intro.stepDrivePointThree,
        ],
      },
      {
        icon: Shield,
        title: t.vault.intro.stepAuthTitle,
        description: t.vault.intro.stepAuthDescription,
        details: [
          t.vault.intro.stepAuthPointOne,
          t.vault.intro.stepAuthPointTwo,
          t.vault.intro.stepAuthPointThree,
        ],
      },
      {
        icon: Lock,
        title: t.vault.intro.stepSecurityTitle,
        description: t.vault.intro.stepSecurityDescription,
        details: [
          t.vault.intro.stepSecurityPointOne,
          t.vault.intro.stepSecurityPointTwo,
          t.vault.intro.stepSecurityPointThree,
        ],
      },
    ],
    [
      t.vault.intro.stepAuthDescription,
      t.vault.intro.stepAuthPointOne,
      t.vault.intro.stepAuthPointThree,
      t.vault.intro.stepAuthPointTwo,
      t.vault.intro.stepAuthTitle,
      t.vault.intro.stepDriveDescription,
      t.vault.intro.stepDrivePointOne,
      t.vault.intro.stepDrivePointThree,
      t.vault.intro.stepDrivePointTwo,
      t.vault.intro.stepDriveTitle,
      t.vault.intro.stepSecurityDescription,
      t.vault.intro.stepSecurityPointOne,
      t.vault.intro.stepSecurityPointThree,
      t.vault.intro.stepSecurityPointTwo,
      t.vault.intro.stepSecurityTitle,
      t.vault.intro.stepWelcomeDescription,
      t.vault.intro.stepWelcomePointOne,
      t.vault.intro.stepWelcomePointThree,
      t.vault.intro.stepWelcomePointTwo,
      t.vault.intro.stepWelcomeTitle,
    ],
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

  useEffect(() => {
    if (isInit) {
      setShowIntro(true);
      return;
    }
    setShowIntro(false);
  }, [isInit]);

  useEffect(() => {
    if (showIntro) {
      setIntroStep(0);
    }
  }, [showIntro]);

  if (!status) {
    return <main className="h-full w-full bg-background" />;
  }

  function dismissIntro() {
    setShowIntro(false);
  }

  function openRecoveryFlow() {
    setRecoverOpen(true);
    setRecoveryStep("server");
    setRecoverAttempts(0);
    setRecoverPassword("");
  }

  function handleIntroCreateVault() {
    dismissIntro();
  }

  function handleIntroRecoverVault() {
    dismissIntro();
    openRecoveryFlow();
  }

  function skipIntroToSetupStep() {
    setIntroStep(setupStepIndex);
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

  const setupStepIndex = introSteps.length;
  const isSetupStep = introStep === setupStepIndex;
  const totalIntroSteps = introSteps.length + 1;
  const currentIntro = introSteps[Math.min(introStep, Math.max(0, introSteps.length - 1))];
  const IntroIcon = currentIntro.icon;

  return (
    <div className="h-[80%] relative flex min-h-0 flex-1 items-center justify-center bg-background px-6 py-8">
      <div className="absolute right-4 top-4">
        <select
          className="h-8 rounded-md border border-border/50 bg-card px-2 text-xs text-muted-foreground"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {Object.entries(LOCALE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>
      {isInit && showIntro ? (
        <div className="w-full max-w-lg space-y-8">
          {!isSetupStep ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={skipIntroToSetupStep}
                className="gap-1.5"
              >
                {t.vault.intro.skip}
              </Button>
            </div>
          ) : null}

          <div className="flex items-center justify-center gap-2">
            {Array.from({ length: totalIntroSteps }).map((_, index) => (
              <div
                key={`intro-step-${index}`}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  index === introStep
                    ? "w-8 bg-primary"
                    : index < introStep
                      ? "w-4 bg-primary/40"
                      : "w-4 bg-muted"
                }`}
              />
            ))}
          </div>

          <div className="space-y-6 rounded-xl border border-border/60 bg-card p-8">
            {isSetupStep ? (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">{t.vault.intro.setupTitle}</p>
                  <p className="text-xs text-muted-foreground">{t.vault.intro.setupDescription}</p>
                </div>

                <button
                  type="button"
                  onClick={handleIntroCreateVault}
                  className="group flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Lock className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{t.vault.intro.setupCreateTitle}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t.vault.intro.setupCreateDescription}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                </button>

                <button
                  type="button"
                  onClick={handleIntroRecoverVault}
                  className="group flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-info/10">
                    <Cloud className="h-5 w-5 text-info" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{t.vault.intro.setupRecoverTitle}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t.vault.intro.setupRecoverDescription}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-info" />
                </button>

                <div className="rounded-lg border border-border/40 bg-card p-3">
                  <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
                    {t.vault.intro.setupHint}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                    <IntroIcon className="h-8 w-8 text-primary" />
                  </div>
                </div>

                <div className="space-y-2 text-center">
                  <h1 className="text-xl font-semibold text-foreground">{currentIntro.title}</h1>
                  <p className="text-sm leading-relaxed text-muted-foreground">{currentIntro.description}</p>
                </div>

                <div className="space-y-2.5">
                  {currentIntro.details.map((detail) => (
                    <div key={detail} className="flex items-start gap-3 rounded-lg bg-secondary/50 p-3">
                      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
                        <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                      </div>
                      <span className="text-sm text-foreground/80">{detail}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIntroStep((current) => Math.max(0, current - 1))}
              disabled={introStep === 0}
              className="gap-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t.vault.intro.back}
            </Button>

            {!isSetupStep ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setIntroStep((current) => Math.min(setupStepIndex, current + 1))}
                className="gap-1.5"
              >
                {t.vault.intro.next}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <div />
            )}
          </div>
        </div>
      ) : (
        <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card/95 p-6 shadow-xl">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10">
              <span className="text-lg font-semibold text-primary">OP</span>
            </div>
            <h1 className="text-2xl font-semibold text-foreground">{t.app.name}</h1>
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
                className="h-11"
                {...initForm.register("password")}
              />
              <Input
                type="password"
                placeholder={t.vault.init.confirmPlaceholder}
                className="h-11"
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
              onClick={openRecoveryFlow}
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
                className="h-11"
                {...unlockForm.register("password")}
              />
              <Button className="mt-2 w-full" type="submit" disabled={busy}>
                <Lock className="mr-2 h-4 w-4" /> {t.vault.unlock.submit}
              </Button>
              <button
                type="button"
                className="w-full text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setForgotOpen(true)}
              >
                {t.vault.unlock.forgotPassword}
              </button>
            </form>
          )}
        </div>
      )}

      <AppDialog
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
            <label className="text-sm text-foreground/90">{t.vault.recovery.serverLabel}</label>
            <select
              className="h-10 w-full rounded-md border border-border/50 bg-card px-3 text-sm text-foreground"
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
            <p className="text-sm text-foreground/90">
              {t.vault.recovery.backupFound}
            </p>
            <Input
              type="password"
              placeholder={t.vault.unlock.passwordPlaceholder}
              value={recoverPassword}
              onChange={(event) => setRecoverPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t.vault.recovery.attempts.replace("{count}", String(recoverAttempts))}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-foreground/90">{t.vault.recovery.downloadingInfo}</p>
            <p className="text-xs text-muted-foreground">{t.vault.recovery.downloadingWait}</p>
          </div>
        )}
      </AppDialog>

      <AppDialog
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
            <label className="text-xs text-muted-foreground">
              {t.vault.forgot.confirmLabel}
            </label>
            <Input
              placeholder={t.vault.forgot.confirmPlaceholder}
              value={deleteInput}
              onChange={(event) => setDeleteInput(event.target.value)}
            />
          </div>
        </div>
      </AppDialog>
    </div>
  );
}


