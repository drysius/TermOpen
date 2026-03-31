import { Cloud, KeyRound, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getError } from "@/functions/common";
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

const DELETE_PHRASE = "DELETAR DADOS";

export function VaultGatePage() {
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
      toast.error("Selecione um servidor para continuar.");
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
      toast.success("Backup encontrado. Informe a senha mestre.");
    } catch (error) {
      toast.error(getError(error));
    } finally {
      setRecoverBusy(false);
    }
  }

  async function handleRecoveryRestore() {
    if (!selectedServer) {
      toast.error("Servidor invalido.");
      return;
    }
    if (!recoverPassword.trim()) {
      toast.error("Informe a senha mestre.");
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
      toast.success("Backup restaurado com sucesso.");
    } catch (error) {
      const attempts = recoverAttempts + 1;
      setRecoverAttempts(attempts);
      setRecoveryStep("password");
      toast.error(getError(error));
      if (attempts >= 5) {
        toast.error("Limite de 5 tentativas atingido. Recuperacao cancelada.");
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
    if (deleteInput.trim() !== DELETE_PHRASE) {
      toast.error(`Digite exatamente "${DELETE_PHRASE}" para continuar.`);
      return;
    }

    setDeleteBusy(true);
    try {
      await api.vaultResetAll();
      setForgotOpen(false);
      setDeleteInput("");
      await bootstrap();
      toast.success("Dados locais removidos. Voce pode iniciar do zero.");
    } catch (error) {
      toast.error(getError(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950 px-8">
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
                  toast.error("A confirmacao da senha nao confere.");
                  return;
                }
                void vaultInit(values.password);
                initForm.reset({ password: "", confirm_password: "" });
              })}
            >
              <Input
                type="password"
                placeholder="Senha mestre"
                className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
                {...initForm.register("password")}
              />
              <Input
                type="password"
                placeholder="Confirmar senha"
                className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
                {...initForm.register("confirm_password")}
              />
              <Button
                className="mt-2 w-full"
                type="submit"
                disabled={busy || initPassword.length < 6 || initConfirmPassword.length < 6}
              >
                <KeyRound className="mr-2 h-4 w-4" /> Inicializar
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
              <Cloud className="mr-2 h-4 w-4" /> Logar para recuperar login
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
              placeholder="Senha mestre"
              className="h-11 rounded-none border-0 border-b border-white/20 bg-transparent px-0 shadow-none focus-visible:ring-0"
              {...unlockForm.register("password")}
            />
            <Button className="mt-2 w-full" type="submit" disabled={busy}>
              <Lock className="mr-2 h-4 w-4" /> Desbloquear
            </Button>
            <button
              type="button"
              className="w-full text-xs text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
              onClick={() => setForgotOpen(true)}
            >
              Esqueci a senha?
            </button>
          </form>
        )}
      </div>

      <Dialog
        open={recoverOpen}
        title="Recuperar Login"
        description="Selecione o servidor e recupere seus arquivos da nuvem."
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
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleRecoveryLogin()} disabled={recoverBusy}>
                {recoverBusy ? "Conectando..." : "Login Google"}
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
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleRecoveryRestore()} disabled={recoverBusy}>
                {recoverBusy ? "Validando..." : "Restaurar"}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button type="button" disabled>
                Baixando...
              </Button>
            </div>
          )
        }
      >
        {recoveryStep === "server" ? (
          <div className="space-y-3">
            <label className="text-sm text-zinc-300">Servidor</label>
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
              Backup encontrado. Informe a senha mestre para validar e baixar os arquivos.
            </p>
            <Input
              type="password"
              placeholder="Senha mestre"
              value={recoverPassword}
              onChange={(event) => setRecoverPassword(event.target.value)}
            />
            <p className="text-xs text-zinc-500">Tentativas: {recoverAttempts}/5</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-zinc-300">Baixando arquivos da nuvem...</p>
            <p className="text-xs text-zinc-500">Isso pode levar alguns segundos.</p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={forgotOpen}
        title="Esqueci a senha"
        description="Sem a senha mestre nao existe recuperacao possivel."
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
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteAllData()}
              disabled={deleteBusy || deleteInput.trim() !== DELETE_PHRASE}
            >
              {deleteBusy ? "Deletando..." : "Deletar dados"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4" />
              Nao e possivel recuperar dados sem a senha mestre.
            </p>
            <p className="mt-2 text-xs text-red-100/90">
              Todos os dados do TermOpen sao criptografados localmente. Se voce perdeu a senha,
              a unica opcao e apagar os dados atuais e iniciar uma conta zerada.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-zinc-400">
              Digite <strong>{DELETE_PHRASE}</strong> para continuar
            </label>
            <Input
              placeholder='Digite "DELETAR DADOS"'
              value={deleteInput}
              onChange={(event) => setDeleteInput(event.target.value)}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
