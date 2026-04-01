import { Check, ChevronDown, KeyRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/tauri";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { ConnectionProfile, ConnectionProtocol, KeychainEntry } from "@/types/termopen";

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
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-zinc-200">{label}</span>
      <span className="text-[11px] text-zinc-500">{description}</span>
      {children}
    </label>
  );
}

function describeKeychainEntry(entry: KeychainEntry, fallback: string): string {
  const parts: string[] = [];
  if (entry.password) {
    parts.push("Password");
  }
  if (entry.private_key) {
    parts.push("Private Key");
  }
  if (entry.public_key) {
    parts.push("Public Key");
  }
  if (entry.passphrase) {
    parts.push("Passphrase");
  }
  return parts.length ? parts.join(" • ") : fallback;
}

export function HostFormDrawer() {
  const t = useT();
  const openState = useAppStore((state) => state.hostDrawerOpen);
  const initialProfile = useAppStore((state) => state.hostDraft);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const busy = useAppStore((state) => state.busy);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const saveHost = useAppStore((state) => state.saveHost);

  const [protocolMenuOpen, setProtocolMenuOpen] = useState(false);
  const [keychainMenuOpen, setKeychainMenuOpen] = useState(false);
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const protocolMenuRef = useRef<HTMLDivElement | null>(null);
  const keychainMenuRef = useRef<HTMLDivElement | null>(null);

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
  const hasSftp = watchedProtocols.includes("sftp");

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!protocolMenuRef.current?.contains(target)) {
        setProtocolMenuOpen(false);
      }
      if (!keychainMenuRef.current?.contains(target)) {
        setKeychainMenuOpen(false);
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
    setKeychainMenuOpen(false);
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
      remote_path: hasSftp ? values.remote_path.trim() || "/" : null,
      kind: undefined,
    };
    void saveHost(profile);
  };

  return (
    <Drawer
      open={openState}
      onClose={closeHostDrawer}
      title={initialProfile.id ? t.hostDrawer.titleEdit : t.hostDrawer.titleNew}
      description={t.hostDrawer.description}
      widthClassName="w-[640px]"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        <div className="rounded-lg border border-white/10 bg-zinc-950/60 p-3">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">{t.hostDrawer.protocols.label}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {watchedProtocols.map((protocol) => (
              <Badge key={protocol} variant="outline">
                {protocolLabel(protocol)}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t.hostDrawer.name.label} description={t.hostDrawer.name.description}>
            <Input placeholder={t.hostDrawer.name.placeholder} {...register("name")} />
          </Field>

          <Field label={t.hostDrawer.host.label} description={t.hostDrawer.host.description}>
            <Input placeholder={t.hostDrawer.host.placeholder} {...register("host", { required: true })} />
          </Field>

          <Field label={t.hostDrawer.port.label} description={t.hostDrawer.port.description}>
            <Input type="number" placeholder={t.hostDrawer.port.placeholder} {...register("port", { valueAsNumber: true })} />
          </Field>

          <Field label={t.hostDrawer.username.label} description={t.hostDrawer.username.description}>
            <Input placeholder={t.hostDrawer.username.placeholder} {...register("username", { required: true })} />
          </Field>

          {hasSftp ? (
            <Field label={t.hostDrawer.remotePath.label} description={t.hostDrawer.remotePath.description}>
              <Input className="col-span-2" placeholder={t.hostDrawer.remotePath.placeholder} {...register("remote_path")} />
            </Field>
          ) : null}
        </div>

        <Field label={t.hostDrawer.protocols.label} description={t.hostDrawer.protocols.description}>
          <Controller
            control={control}
            name="protocols"
            render={({ field }) => (
              <div ref={protocolMenuRef} className="relative">
                <button
                  type="button"
                  className="flex h-9 w-full items-center justify-between rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
                  onClick={() => setProtocolMenuOpen((value) => !value)}
                >
                  <span className="truncate">
                    {field.value.length ? field.value.map((item) => protocolLabel(item)).join(", ") : t.hostDrawer.protocols.placeholder}
                  </span>
                  <ChevronDown className="h-4 w-4 text-zinc-400" />
                </button>
                {protocolMenuOpen ? (
                  <div className="absolute z-[240] mt-1 w-full rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
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
                          <span className="mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border border-white/20 text-cyan-300">
                            {active ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span>
                            <span className="block text-xs font-medium text-zinc-200">{protocolLabel(protocol)}</span>
                            <span className="block text-[11px] text-zinc-500">
                              {protocol === "ssh" ? t.hostDrawer.protocols.sshDescription : t.hostDrawer.protocols.sftpDescription}
                            </span>
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
          <Field label={t.hostDrawer.password.label} description={t.hostDrawer.password.description}>
            <Input placeholder={t.hostDrawer.password.placeholder} type="password" {...register("password")} />
          </Field>

          <Field label={t.hostDrawer.keychainField.label} description={t.hostDrawer.keychainField.description}>
            <Controller
              control={control}
              name="keychain_id"
              render={({ field }) => {
                const selected = keychainEntries.find((entry) => entry.id === field.value);
                return (
                  <div ref={keychainMenuRef} className="relative">
                    <button
                      type="button"
                      className="flex h-9 w-full items-center justify-between rounded-md border border-white/15 bg-zinc-900 px-3 text-sm text-zinc-100"
                      onClick={() => setKeychainMenuOpen((current) => !current)}
                    >
                      <span className="truncate">{selected?.name ?? t.hostDrawer.keychainField.none}</span>
                      <ChevronDown className="h-4 w-4 text-zinc-400" />
                    </button>
                    {keychainMenuOpen ? (
                      <div className="absolute z-[240] mt-1 w-full rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                        <button
                          type="button"
                          className="w-full rounded px-2 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-900"
                          onClick={() => {
                            field.onChange("");
                            setKeychainMenuOpen(false);
                          }}
                        >
                          {t.hostDrawer.keychainField.none}
                        </button>
                        {keychainEntries.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            className="w-full rounded px-2 py-2 text-left hover:bg-zinc-900"
                            onClick={() => {
                              field.onChange(entry.id);
                              setKeychainMenuOpen(false);
                            }}
                          >
                            <p className="text-xs font-medium text-zinc-200">{entry.name}</p>
                            <p className="mt-0.5 text-[11px] text-zinc-500">
                              {describeKeychainEntry(entry, t.hostDrawer.keychainField.none)}
                            </p>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
          </Field>
        </div>

        <Field
          label={t.hostDrawer.privateKey.label}
          description={t.hostDrawer.privateKey.description}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void open({
                    title: t.hostDrawer.privateKey.selectFile,
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
                {t.hostDrawer.privateKey.selectFile}
              </Button>
              <Input value={privateKeyPath} readOnly placeholder={t.hostDrawer.privateKey.noFile} />
            </div>
            <Textarea rows={6} placeholder={t.hostDrawer.privateKey.placeholder} {...register("private_key")} />
          </div>
        </Field>

        <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
          <Button type="button" variant="outline" onClick={closeHostDrawer}>
            {t.hostDrawer.cancel}
          </Button>
          <Button type="submit" disabled={busy || !watchedHost || !watchedUser || watchedProtocols.length === 0}>
            {t.hostDrawer.save}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
