import { ChevronRight, Eye, EyeOff, Folder, Globe, HardDrive, Key, Lock, Monitor, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { ConnectionProfile, ConnectionProtocol, KeychainEntry } from "@/types/openptl";

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

type AuthMethod = "password" | "key" | "agent";

const RDP_DEFAULT_PORT = 3389;
const FTP_DEFAULT_PORT = 21;
const SMB_DEFAULT_PORT = 445;

const protocolMeta: Record<
  ConnectionProtocol,
  {
    icon: typeof Monitor;
    defaultPort: number;
    colorClass: string;
  }
> = {
  ssh: {
    icon: Monitor,
    defaultPort: 22,
    colorClass: "bg-primary/15 text-primary border-primary/30",
  },
  sftp: {
    icon: Server,
    defaultPort: 22,
    colorClass: "bg-info/15 text-info border-info/30",
  },
  smb: {
    icon: HardDrive,
    defaultPort: SMB_DEFAULT_PORT,
    colorClass: "bg-warning/15 text-warning border-warning/30",
  },
  ftp: {
    icon: Globe,
    defaultPort: FTP_DEFAULT_PORT,
    colorClass: "bg-success/15 text-success border-success/30",
  },
  ftps: {
    icon: Lock,
    defaultPort: FTP_DEFAULT_PORT,
    colorClass: "bg-success/15 text-success border-success/30",
  },
  rdp: {
    icon: Monitor,
    defaultPort: RDP_DEFAULT_PORT,
    colorClass: "bg-destructive/15 text-destructive border-destructive/30",
  },
};

function hasFileProtocol(protocols: ConnectionProtocol[]): boolean {
  return protocols.some((item) => item === "sftp" || item === "ftp" || item === "ftps" || item === "smb");
}

function preferredPortForProtocols(protocols: ConnectionProtocol[]): number {
  const primary = primaryProtocolFromList(protocols);
  if (primary === "rdp") {
    return RDP_DEFAULT_PORT;
  }
  if (primary === "smb") {
    return SMB_DEFAULT_PORT;
  }
  if (primary === "ftp" || primary === "ftps") {
    return FTP_DEFAULT_PORT;
  }
  return 22;
}

function primaryProtocolFromList(protocols: ConnectionProtocol[]): ConnectionProtocol {
  const unique = Array.from(new Set(protocols));
  if (unique.includes("rdp")) {
    return "rdp";
  }
  if (unique.includes("ssh")) {
    return "ssh";
  }
  if (unique.includes("sftp")) {
    return "sftp";
  }
  if (unique.includes("smb")) {
    return "smb";
  }
  if (unique.includes("ftp")) {
    return "ftp";
  }
  if (unique.includes("ftps")) {
    return "ftps";
  }
  return "ssh";
}

function buildProtocolList(primary: ConnectionProtocol, sshAlsoSftp: boolean): ConnectionProtocol[] {
  if (primary === "rdp") {
    return ["rdp"];
  }
  if (primary === "ssh") {
    return sshAlsoSftp ? ["ssh", "sftp"] : ["ssh"];
  }
  return [primary];
}

function normalizeProtocolList(protocols: ConnectionProtocol[]): ConnectionProtocol[] {
  const primary = primaryProtocolFromList(protocols);
  const sshAlsoSftp = primary === "ssh" && protocols.includes("sftp");
  return buildProtocolList(primary, sshAlsoSftp);
}

function normalizeProtocols(profile: ConnectionProfile): ConnectionProtocol[] {
  if (profile.protocols?.length) {
    return normalizeProtocolList(profile.protocols);
  }
  if (profile.kind === "host") {
    return ["ssh"];
  }
  if (profile.kind === "sftp") {
    return ["sftp"];
  }
  if (profile.kind === "rdp") {
    return ["rdp"];
  }
  return ["ssh", "sftp"];
}

function protocolLabel(protocol: ConnectionProtocol): string {
  if (protocol === "ssh") {
    return "SSH";
  }
  if (protocol === "sftp") {
    return "SFTP";
  }
  if (protocol === "ftp") {
    return "FTP";
  }
  if (protocol === "ftps") {
    return "FTPS";
  }
  if (protocol === "smb") {
    return "SMB";
  }
  return "RDP";
}

function protocolDescription(protocol: ConnectionProtocol, t: ReturnType<typeof useT>): string {
  if (protocol === "ssh") {
    return t.hostDrawer.protocols.sshDescription;
  }
  if (protocol === "sftp") {
    return t.hostDrawer.protocols.sftpDescription;
  }
  if (protocol === "ftp") {
    return t.hostDrawer.protocols.ftpDescription;
  }
  if (protocol === "ftps") {
    return t.hostDrawer.protocols.ftpsDescription;
  }
  if (protocol === "smb") {
    return t.hostDrawer.protocols.smbDescription;
  }
  return t.hostDrawer.protocols.rdpDescription;
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
  return parts.length ? parts.join(" | ") : fallback;
}

export function HostFormDrawer() {
  const t = useT();
  const openState = useAppStore((state) => state.hostDrawerOpen);
  const initialProfile = useAppStore((state) => state.hostDraft);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const busy = useAppStore((state) => state.busy);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const saveHost = useAppStore((state) => state.saveHost);

  const [step, setStep] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [privateKeyPath, setPrivateKeyPath] = useState("");

  const { control, register, watch, handleSubmit, reset, setValue } = useForm<HostFormValues>({
    defaultValues: {
      id: initialProfile.id ?? "",
      name: initialProfile.name ?? "",
      protocols: normalizeProtocols(initialProfile),
      host: initialProfile.host ?? "",
      port: initialProfile.port ?? preferredPortForProtocols(normalizeProtocols(initialProfile)),
      username: initialProfile.username ?? "",
      password: initialProfile.password ?? "",
      private_key: initialProfile.private_key ?? "",
      keychain_id: initialProfile.keychain_id ?? "",
      remote_path: initialProfile.remote_path ?? "/",
    },
  });

  const watchedName = watch("name");
  const watchedHost = watch("host");
  const watchedUser = watch("username");
  const watchedPort = watch("port");
  const watchedProtocols = watch("protocols");
  const watchedPrivateKey = watch("private_key");
  const watchedKeychainId = watch("keychain_id");
  const selectedProtocol = useMemo(() => primaryProtocolFromList(watchedProtocols), [watchedProtocols]);
  const sshAlsoSftp = selectedProtocol === "ssh" && watchedProtocols.includes("sftp");
  const hasSftp = hasFileProtocol(watchedProtocols);

  const steps = useMemo(
    () => [t.hostDrawer.steps.protocol, t.hostDrawer.steps.connection, t.hostDrawer.steps.auth],
    [t.hostDrawer.steps.auth, t.hostDrawer.steps.connection, t.hostDrawer.steps.protocol],
  );

  useEffect(() => {
    const nextProtocols = normalizeProtocols(initialProfile);
    reset({
      id: initialProfile.id ?? "",
      name: initialProfile.name ?? "",
      protocols: nextProtocols,
      host: initialProfile.host ?? "",
      port: initialProfile.port ?? preferredPortForProtocols(nextProtocols),
      username: initialProfile.username ?? "",
      password: initialProfile.password ?? "",
      private_key: initialProfile.private_key ?? "",
      keychain_id: initialProfile.keychain_id ?? "",
      remote_path: initialProfile.remote_path ?? "/",
    });
    setStep(initialProfile.id ? 1 : 0);
    setShowPassword(false);
    setPrivateKeyPath("");
    if (initialProfile.private_key || initialProfile.keychain_id) {
      setAuthMethod("key");
    } else {
      setAuthMethod("password");
    }
  }, [initialProfile, openState, reset]);

  useEffect(() => {
    const normalized = normalizeProtocolList(watchedProtocols);
    const protocolsChanged =
      normalized.length !== watchedProtocols.length ||
      normalized.some((protocol, index) => watchedProtocols[index] !== protocol);
    if (protocolsChanged) {
      setValue("protocols", normalized, { shouldDirty: true, shouldTouch: true });
      return;
    }
    const preferred = preferredPortForProtocols(normalized);
    if (!Number.isFinite(watchedPort) || watchedPort <= 0) {
      setValue("port", preferred, { shouldDirty: true, shouldTouch: true });
    }
  }, [setValue, watchedPort, watchedProtocols]);

  const canAdvanceStep0 = Boolean(selectedProtocol);
  const canAdvanceStep1 = watchedName.trim().length > 0 && watchedHost.trim().length > 0 && watchedUser.trim().length > 0;
  const canSubmit = canAdvanceStep1 && watchedProtocols.length > 0 && authMethod !== "agent";

  function goToNextStep() {
    setStep((value) => Math.min(2, value + 1));
  }

  function handleProtocolSelect(protocol: ConnectionProtocol) {
    const currentPrimary = primaryProtocolFromList(watchedProtocols);
    const keepSftp = protocol === "ssh" ? currentPrimary === "ssh" && watchedProtocols.includes("sftp") : false;
    const nextProtocols = buildProtocolList(protocol, keepSftp);
    setValue("protocols", nextProtocols, {
      shouldDirty: true,
      shouldTouch: true,
    });
    setValue("port", preferredPortForProtocols(nextProtocols), {
      shouldDirty: true,
      shouldTouch: true,
    });
  }

  function handleSshAlsoSftpToggle(nextValue: boolean) {
    if (selectedProtocol !== "ssh") {
      return;
    }
    const nextProtocols = buildProtocolList("ssh", nextValue);
    setValue("protocols", nextProtocols, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }

  async function handleSelectPrivateKeyFile() {
    const selected = await open({
      title: t.hostDrawer.privateKey.selectFile,
      multiple: false,
      directory: false,
    });
    if (typeof selected !== "string") {
      return;
    }
    try {
      const content = await api.localRead(selected);
      setValue("private_key", content, { shouldDirty: true, shouldTouch: true });
      setPrivateKeyPath(selected);
    } catch {
      setPrivateKeyPath("");
    }
  }

  function submitConnection(values: HostFormValues) {
    const protocols = normalizeProtocolList(values.protocols);
    const profile: ConnectionProfile = {
      ...initialProfile,
      id: values.id,
      name: values.name.trim(),
      protocols,
      host: values.host.trim(),
      port: values.port || preferredPortForProtocols(protocols),
      username: values.username.trim(),
      password: authMethod === "password" ? (values.password.trim() ? values.password : null) : null,
      private_key: authMethod === "key" ? (values.private_key.trim() ? values.private_key : null) : null,
      keychain_id: values.keychain_id || null,
      remote_path: hasFileProtocol(protocols) ? values.remote_path.trim() || "/" : null,
      kind: undefined,
    };
    void saveHost(profile);
  }

  const submitCurrentConnection = handleSubmit((values) => {
    if (step !== 2) {
      return;
    }
    submitConnection(values);
  });

  return (
    <Dialog
      open={openState}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) {
          closeHostDrawer();
        }
      }}
    >
      <DialogContent className="sm:max-w-[620px] bg-card border-border/60 gap-0 p-0 overflow-hidden">
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }

            if (event.target instanceof HTMLTextAreaElement) {
              return;
            }

            // Prevent implicit form submit; saving must happen only via explicit "Criar".
            event.preventDefault();
          }}
        >
          <div className="flex items-center gap-2 px-6 pt-5 pb-3">
            {steps.map((label, index) => (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium transition-colors",
                    index <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {index + 1}
                </div>
                <span className={cn("text-xs", index <= step ? "text-foreground" : "text-muted-foreground")}>
                  {label}
                </span>
                {index < steps.length - 1 ? <ChevronRight className="h-3 w-3 text-muted-foreground/40" /> : null}
              </div>
            ))}
          </div>

          <div className="border-t border-border/30" />

          {step === 0 ? (
            <div className="p-6 space-y-4">
              <DialogHeader>
                <DialogTitle className="text-base">{t.hostDrawer.wizard.selectProtocolTitle}</DialogTitle>
                <DialogDescription>{t.hostDrawer.wizard.selectProtocolDescription}</DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-3 gap-2">
                {(["ssh", "sftp", "smb", "ftp", "ftps", "rdp"] as ConnectionProtocol[]).map((protocol) => {
                  const meta = protocolMeta[protocol];
                  const Icon = meta.icon;
                  const active = selectedProtocol === protocol;
                  return (
                    <button
                      key={protocol}
                      type="button"
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-xl border p-4 transition-all cursor-pointer",
                        active
                          ? `${meta.colorClass} border-current`
                          : "border-border/40 bg-secondary/30 text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                      onClick={() => handleProtocolSelect(protocol)}
                    >
                      <Icon className="h-6 w-6" />
                      <span className="text-xs font-medium">{protocolLabel(protocol)}</span>
                      <span className="text-[10px] opacity-70">{meta.defaultPort}</span>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg border border-border/40 bg-secondary/30 p-3 text-xs text-muted-foreground">
                {selectedProtocol
                  ? [
                      `${protocolLabel(selectedProtocol)}: ${protocolDescription(selectedProtocol, t)}`,
                      ...(selectedProtocol === "ssh" && sshAlsoSftp
                        ? [`${protocolLabel("sftp")}: ${protocolDescription("sftp", t)}`]
                        : []),
                    ].join(" | ")
                  : t.hostDrawer.protocols.description}
              </div>

              {selectedProtocol === "ssh" ? (
                <div className="flex items-center justify-between rounded-lg border border-border/40 bg-secondary/20 p-3">
                  <div className="pr-3">
                    <p className="text-xs font-medium text-foreground">{t.hostDrawer.protocols.sshAlsoSftpLabel}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{t.hostDrawer.protocols.sshAlsoSftpDescription}</p>
                  </div>
                  <Switch checked={sshAlsoSftp} onCheckedChange={(checked) => handleSshAlsoSftpToggle(Boolean(checked))} />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="p-6 space-y-4">
              <DialogHeader>
                <DialogTitle className="text-base">{t.hostDrawer.wizard.connectionTitle}</DialogTitle>
                <DialogDescription>{t.hostDrawer.wizard.connectionDescription}</DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.name.label}</label>
                  <Input placeholder={t.hostDrawer.name.placeholder} {...register("name")} />
                </div>
                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.host.label}</label>
                    <Input placeholder={t.hostDrawer.host.placeholder} {...register("host", { required: true })} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.port.label}</label>
                    <Input
                      type="number"
                      placeholder={t.hostDrawer.port.placeholder}
                      {...register("port", { valueAsNumber: true })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.username.label}</label>
                  <Input placeholder={t.hostDrawer.username.placeholder} {...register("username", { required: true })} />
                </div>
                {hasSftp ? (
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.remotePath.label}</label>
                    <div className="relative">
                      <Input className="pr-9 font-mono" placeholder={t.hostDrawer.remotePath.placeholder} {...register("remote_path")} />
                      <Folder className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="p-6 space-y-4">
              <DialogHeader>
                <DialogTitle className="text-base">{t.hostDrawer.wizard.authTitle}</DialogTitle>
                <DialogDescription>{t.hostDrawer.wizard.authDescription}</DialogDescription>
              </DialogHeader>

              <div className="flex gap-1 rounded-lg bg-secondary/50 p-1">
                <button
                  type="button"
                  onClick={() => setAuthMethod("password")}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    authMethod === "password" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.hostDrawer.auth.passwordMethod}
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMethod("key")}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    authMethod === "key" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.hostDrawer.auth.keyMethod}
                </button>
                <button
                  type="button"
                  disabled
                  className="flex-1 cursor-not-allowed rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground/60"
                >
                  {t.hostDrawer.auth.agentMethod}
                </button>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.keychainField.label}</label>
                <Controller
                  control={control}
                  name="keychain_id"
                  render={({ field }) => (
                    <Select
                      value={field.value || "__none__"}
                      onValueChange={(value) => field.onChange(value === "__none__" ? "" : value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t.hostDrawer.keychainField.none}</SelectItem>
                        {keychainEntries.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.name} - {describeKeychainEntry(entry, t.hostDrawer.keychainField.none)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              {authMethod === "password" ? (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.hostDrawer.password.label}</label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder={t.hostDrawer.password.placeholder}
                        className="pr-9"
                        {...register("password")}
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowPassword((current) => !current)}
                      >
                        {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {authMethod === "key" ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleSelectPrivateKeyFile()}>
                      <Key className="mr-2 h-4 w-4" />
                      {t.hostDrawer.privateKey.selectFile}
                    </Button>
                    <Input readOnly value={privateKeyPath} placeholder={t.hostDrawer.privateKey.noFile} />
                  </div>
                  <Textarea
                    rows={8}
                    placeholder={t.hostDrawer.privateKey.placeholder}
                    className="font-mono text-xs"
                    {...register("private_key")}
                  />
                </div>
              ) : null}

              {authMethod === "agent" ? (
                <div className="rounded-lg border border-border/40 bg-secondary/30 p-3">
                  <p className="text-sm font-medium text-foreground">{t.hostDrawer.auth.agentUnavailableTitle}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t.hostDrawer.auth.agentUnavailableDescription}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="border-t border-border/30" />
          <DialogFooter className="px-6 py-4">
            {step > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep((value) => Math.max(0, value - 1))}>
                {t.hostDrawer.wizard.back}
              </Button>
            ) : (
              <div />
            )}

            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={closeHostDrawer} disabled={busy}>
                {t.hostDrawer.cancel}
              </Button>
              {step < 2 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={step === 0 ? !canAdvanceStep0 : !canAdvanceStep1}
                  onClick={goToNextStep}
                >
                  {t.hostDrawer.wizard.next}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void submitCurrentConnection()}
                  disabled={busy || !canSubmit || (authMethod === "key" && !watchedPrivateKey.trim() && !watchedKeychainId)}
                >
                  {t.hostDrawer.wizard.create}
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
