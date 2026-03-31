import { KeyRound, Lock } from "lucide-react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/store/app-store";

interface InitFormValues {
  password: string;
  allowNoPassword: boolean;
}

interface UnlockFormValues {
  password: string;
}

export function VaultGatePage() {
  const status = useAppStore((state) => state.vaultStatus);
  const busy = useAppStore((state) => state.busy);
  const vaultInit = useAppStore((state) => state.vaultInit);
  const vaultUnlock = useAppStore((state) => state.vaultUnlock);
  const initForm = useForm<InitFormValues>({
    defaultValues: {
      password: "",
      allowNoPassword: false,
    },
  });
  const unlockForm = useForm<UnlockFormValues>({
    defaultValues: {
      password: "",
    },
  });
  const allowNoPassword = initForm.watch("allowNoPassword");
  const initPassword = initForm.watch("password");
  const isInit = !status?.initialized;

  if (!status) {
    return <main className="h-full w-full bg-zinc-950" />;
  }

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950">
      <Card className="w-full max-w-md border-white/10 bg-zinc-950/90">
        <CardHeader>
          <CardTitle>{isInit ? "Configurar Home" : "Desbloquear Home"}</CardTitle>
          <CardDescription>
            {isInit
              ? "Crie senha mestre ou use keychain do sistema"
              : "Informe sua senha mestre para abrir o perfil"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isInit ? (
            <form
              className="space-y-3"
              onSubmit={initForm.handleSubmit((values) => {
                void vaultInit(values.allowNoPassword ? null : values.password);
                initForm.reset({ password: "", allowNoPassword: values.allowNoPassword });
              })}
            >
              <Input
                type="password"
                placeholder="Senha mestre"
                disabled={allowNoPassword}
                {...initForm.register("password")}
              />
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" {...initForm.register("allowNoPassword")} />
                Continuar sem senha
              </label>
              <Button className="w-full" type="submit" disabled={busy || (!allowNoPassword && initPassword.length < 6)}>
                <KeyRound className="mr-2 h-4 w-4" /> Inicializar
              </Button>
            </form>
          ) : (
            <form
              className="space-y-3"
              onSubmit={unlockForm.handleSubmit((values) => {
                void vaultUnlock(status.key_mode === "password" ? values.password : null);
                unlockForm.reset();
              })}
            >
              {status.key_mode === "password" ? (
                <Input
                  type="password"
                  placeholder="Senha mestre"
                  {...unlockForm.register("password")}
                />
              ) : (
                <p className="text-sm text-zinc-300">Perfil com keychain do sistema.</p>
              )}
              <Button className="w-full" type="submit" disabled={busy}>
                <Lock className="mr-2 h-4 w-4" /> Desbloquear
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
