import { Check, ChevronDown, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/store/app-store";
import type { ConnectionProfile, ConnectionProtocol } from "@/types/termopen";

interface HostFormValues {
  id: string;
  name: string;
  protocols: ConnectionProtocol[];
  host: string;
  port: number;
  username: string;
  password: string;
  private_key: string;
  keychain_id: string;
  remote_path: string;
}

function protocolLabel(protocol: ConnectionProtocol): string {
  return protocol === "ssh" ? "SSH" : "SFTP";
}

function protocolDescription(protocol: ConnectionProtocol): string {
  return protocol === "ssh"
    ? "Abre blocos de terminal remoto no workspace."
    : "Abre explorador de arquivos remoto e transferencias.";
}

function normalizeProtocols(profile: ConnectionProfile): ConnectionProtocol[] {
  if (profile.protocols?.length) {
    return profile.protocols;
  }
  if (profile.kind === "host") {
    return ["ssh"];
  }
  if (profile.kind === "sftp") {
    return ["sftp"];
  }
  return ["ssh", "sftp"];
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-zinc-200">{label}</span>
      <span className="text-[11px] text-zinc-500">{description}</span>
      {children}
    </label>
  );
}

export function HostFormDrawer() {
  const openState = useAppStore((state) => state.hostDrawerOpen);
  const initialProfile = useAppStore((state) => state.hostDraft);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const busy = useAppStore((state) => state.busy);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const saveHost = useAppStore((state) => state.saveHost);

  const [protocolMenuOpen, setProtocolMenuOpen] = useState(false);
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  const { register, handleSubmit, reset, watch, setValue, control } = useForm<HostFormValues>({
    defaultValues: {
      id: initialProfile.id ?? "",
      name: initialProfile.name ?? "",
      protocols: normalizeProtocols(initialProfile),
      host: initialProfile.host ?? "",
      port: initialProfile.port ?? 22,
      username: initialProfile.username ?? "",
      password: initialProfile.password ?? "",
      private_key: initialProfile.private_key ?? "",
      keychain_id: initialProfile.keychain_id ?? "",
      remote_path: initialProfile.remote_path ?? "/",
    },
  });

  const watchedHost = watch("host");
  const watchedUser = watch("username");
  const watchedProtocols = watch("protocols");

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current) {
        return;
      }
      if (!menuRef.current.contains(event.target as Node)) {
        setProtocolMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    reset({
      id: initialProfile.id ?? "",
      name: initialProfile.name ?? "",
      protocols: normalizeProtocols(initialProfile),
      host: initialProfile.host ?? "",
      port: initialProfile.port ?? 22,
      username: initialProfile.username ?? "",
      password: initialProfile.password ?? "",
      private_key: initialProfile.private_key ?? "",
      keychain_id: initialProfile.keychain_id ?? "",
      remote_path: initialProfile.remote_path ?? "/",
    });
    setPrivateKeyPath("");
    setProtocolMenuOpen(false);
  }, [initialProfile, openState, reset]);

  const onSubmit = (values: HostFormValues) => {
    const profile: ConnectionProfile = {
      ...initialProfile,
      id: values.id,
      name: values.name.trim(),
      protocols: values.protocols.length ? values.protocols : ["ssh", "sftp"],
      host: values.host.trim(),
      port: values.port || 22,
      username: values.username.trim(),
      password: values.password.trim() ? values.password : null,
      private_key: values.private_key.trim() ? values.private_key : null,
      keychain_id: values.keychain_id || null,
      remote_path: values.remote_path.trim() || "/",
      kind: undefined,
    };
    void saveHost(profile);
  };

  return (
    <Drawer
      open={openState}
      onClose={closeHostDrawer}
      title={initialProfile.id ? "Editar Conexao" : "Nova Conexao"}
      description="Defina identificacao, protocolos e credenciais da conexao."
      widthClassName="w-[620px]"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome" description="Nome exibido nos cards e tabs do workspace.">
            <Input placeholder="Ex: Produção - API" {...register("name")} />
          </Field>

          <Field label="Host/IP" description="Endereco DNS ou IP da maquina remota.">
            <Input placeholder="Ex: 51.222.104.129" {...register("host", { required: true })} />
          </Field>

          <Field label="Porta" description="Porta do servidor SSH/SFTP (normalmente 22).">
            <Input type="number" placeholder="22" {...register("port", { valueAsNumber: true })} />
          </Field>

          <Field label="Usuario" description="Usuario usado para autenticar no servidor.">
            <Input placeholder="root" {...register("username", { required: true })} />
          </Field>

          <Field label="Path Remoto Inicial" description="Diretorio inicial ao abrir bloco SFTP.">
            <Input className="col-span-2" placeholder="/var/www/app" {...register("remote_path")} />
          </Field>
        </div>

        <Field label="Protocolos" description="Selecione quais recursos esse host podera abrir no app.">
          <Controller
            control={control}
            name="protocols"
            render={({ field }) => (
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  className="flex h-9 w-full items-center justify-between rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
                  onClick={() => setProtocolMenuOpen((value) => !value)}
                >
                  <span className="truncate">
                    {field.value.length ? field.value.map((item) => protocolLabel(item)).join(", ") : "Selecione"}
                  </span>
                  <ChevronDown className="h-4 w-4 text-zinc-400" />
                </button>
                {protocolMenuOpen ? (
                  <div className="absolute z-20 mt-1 w-full rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                    {(["ssh", "sftp"] as ConnectionProtocol[]).map((protocol) => {
                      const active = field.value.includes(protocol);
                      return (
                        <button
                          key={protocol}
                          type="button"
                          className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-zinc-900"
                          onClick={() => {
                            const next = active
                              ? field.value.filter((item) => item !== protocol)
                              : [...field.value, protocol];
                            field.onChange(next.length ? next : field.value);
                          }}
                        >
                          <span className="mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border border-white/20 text-purple-300">
                            {active ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span>
                            <span className="block text-xs font-medium text-zinc-200">{protocolLabel(protocol)}</span>
                            <span className="block text-[11px] text-zinc-500">{protocolDescription(protocol)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Senha" description="Opcional. Usada quando nao houver chave privada.">
            <Input placeholder="Senha (opcional)" type="password" {...register("password")} />
          </Field>

          <Field label="Keychain" description="Selecione uma entrada para preencher senha/chaves automaticamente.">
            <select
              className="h-9 rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
              {...register("keychain_id")}
            >
              <option value="">Sem keychain</option>
              {keychainEntries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Chave Privada"
          description="Opcional. Voce pode colar a chave ou selecionar arquivo local (conteudo salvo no vault)."
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void open({
                    title: "Selecionar chave privada",
                    multiple: false,
                    directory: false,
                  }).then(async (value) => {
                    if (typeof value !== "string") {
                      return;
                    }
                    try {
                      const content = await api.localRead(value);
                      setValue("private_key", content);
                      setPrivateKeyPath(value);
                    } catch {
                      setPrivateKeyPath("");
                    }
                  })
                }
              >
                <KeyRound className="mr-2 h-4 w-4" />
                Selecionar arquivo
              </Button>
              <Input value={privateKeyPath} readOnly placeholder="Nenhum arquivo selecionado" />
            </div>
            <Textarea
              rows={6}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              {...register("private_key")}
            />
          </div>
        </Field>

        <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
          <Button type="button" variant="outline" onClick={closeHostDrawer}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !watchedHost || !watchedUser || watchedProtocols.length === 0}>
            Salvar
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
