import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, FileKey, Key, Lock, Shield, Upload } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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
import { Textarea } from "@/components/ui/textarea";
import { resolveBackendMessage } from "@/functions/backend-message";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { importKeySchema, type ImportKeySchemaInput, type ImportKeySchemaValues } from "@/schemas/import-key";
import { useAppStore } from "@/store/app-store";
import type { KeychainEntry, KeychainEntryType, SshKeyGenerateInput } from "@/types/openptl";

interface ImportKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMethod?: ImportMethod;
  initialEntry?: KeychainEntry | null;
}

export type ImportMethod = "manual" | "file" | "paste" | "generate";

function inferKeyFields(raw: string): Pick<KeychainEntry, "private_key" | "public_key"> {
  const value = raw.trim();
  if (!value) {
    return { private_key: null, public_key: null };
  }
  if (value.includes("PRIVATE KEY")) {
    return { private_key: value, public_key: null };
  }
  if (value.startsWith("ssh-") || value.startsWith("ecdsa-")) {
    return { private_key: null, public_key: value };
  }
  return { private_key: value, public_key: null };
}

function defaultKeyName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? "";
  if (!name) {
    return "ssh_key";
  }
  return name.replace(/\.(pem|key|pub|ppk)$/i, "") || "ssh_key";
}

function buildDefaultValues(defaultMethod: ImportMethod): ImportKeySchemaInput {
  return {
    method: defaultMethod,
    name: "",
    passphrase: "",
    rawKey: "",
    manualType: "password",
    manualPassword: "",
    manualPrivateKey: "",
    manualPublicKey: "",
    algorithm: "ed25519",
    generateComment: "",
  };
}

export function ImportKeyDialog({
  open,
  onOpenChange,
  initialMethod = "file",
  initialEntry = null,
}: ImportKeyDialogProps) {
  const t = useT();
  const saveKeychain = useAppStore((state) => state.saveKeychain);
  const busy = useAppStore((state) => state.busy);

  const [sourcePath, setSourcePath] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedFingerprint, setGeneratedFingerprint] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const form = useForm<ImportKeySchemaInput, unknown, ImportKeySchemaValues>({
    resolver: zodResolver(importKeySchema),
    defaultValues: buildDefaultValues(initialMethod),
  });

  const method = form.watch("method");
  const name = form.watch("name");
  const manualType = form.watch("manualType");

  const submitLabel = useMemo(
    () => (method === "generate" ? t.keychain.importDialog.generateAction : t.keychain.importDialog.importAction),
    [method, t.keychain.importDialog.generateAction, t.keychain.importDialog.importAction],
  );

  function resetState(defaultMethod: ImportMethod = initialMethod) {
    form.reset(buildDefaultValues(defaultMethod));
    setSourcePath("");
    setGeneratedFingerprint(null);
    setErrorMessage(null);
  }

  function hydrateFromEntry(entry: KeychainEntry) {
    form.reset({
      method: "manual",
      name: entry.name ?? "",
      passphrase: entry.passphrase ?? "",
      rawKey: entry.private_key ?? entry.public_key ?? "",
      manualType: entry.entry_type,
      manualPassword: entry.password ?? "",
      manualPrivateKey: entry.private_key ?? "",
      manualPublicKey: entry.public_key ?? "",
      algorithm: "ed25519",
      generateComment: "",
    });
    setSourcePath("");
    setGeneratedFingerprint(null);
    setErrorMessage(null);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    if (initialEntry) {
      hydrateFromEntry(initialEntry);
    } else {
      resetState(initialMethod);
    }
  }, [form, initialEntry, initialMethod, open]);

  async function handleSelectFile() {
    const selected = await openDialog({
      title: t.keychain.importDialog.selectFileTitle,
      multiple: false,
      directory: false,
    });
    if (typeof selected !== "string") {
      return;
    }

    try {
      const content = await api.localRead(selected);
      setSourcePath(selected);
      form.setValue("rawKey", content, { shouldDirty: true, shouldValidate: true });
      if (!form.getValues("name").trim()) {
        form.setValue("name", defaultKeyName(selected), { shouldDirty: true, shouldValidate: true });
      }
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t.keychain.importDialog.readFileError);
    }
  }

  async function persistEntry(entry: KeychainEntry) {
    await saveKeychain(entry);
    resetState();
    onOpenChange(false);
  }

  const submit = form.handleSubmit(async (values) => {
    setErrorMessage(null);
    const existingId = initialEntry?.id ?? "";
    const existingCreatedAt = initialEntry?.created_at ?? 0;
    try {
      if (values.method === "manual") {
        const nextPassword = values.manualPassword.trim();
        const nextPrivateKey = values.manualPrivateKey.trim();
        const nextPublicKey = values.manualPublicKey.trim();
        const nextPassphrase = values.passphrase.trim();

        await persistEntry({
          id: existingId,
          name: values.name.trim(),
          entry_type: values.manualType,
          password: values.manualType === "password" || values.manualType === "secret" ? (nextPassword || null) : null,
          private_key: values.manualType === "ssh_key" || values.manualType === "secret" ? (nextPrivateKey || null) : null,
          public_key: values.manualType === "ssh_key" || values.manualType === "secret" ? (nextPublicKey || null) : null,
          passphrase: values.manualType === "ssh_key" || values.manualType === "secret" ? (nextPassphrase || null) : null,
          created_at: existingCreatedAt,
        });
        return;
      }

      if (values.method === "generate") {
        setGenerating(true);
        const generated = await api.sshKeyGenerate({
          algorithm: values.algorithm,
          comment: values.generateComment || values.name || null,
          passphrase: values.passphrase || null,
        });
        setGeneratedFingerprint(generated.fingerprint);
        await persistEntry({
          id: existingId,
          name: values.name.trim() || generated.name_suggestion || "ssh_key",
          entry_type: "ssh_key",
          password: null,
          private_key: generated.private_key,
          public_key: generated.public_key,
          passphrase: values.passphrase || null,
          created_at: existingCreatedAt,
        });
        return;
      }

      const keyFields = inferKeyFields(values.rawKey);
      await persistEntry({
        id: existingId,
        name: values.name.trim(),
        entry_type: "ssh_key",
        password: null,
        private_key: keyFields.private_key,
        public_key: keyFields.public_key,
        passphrase: values.passphrase || null,
        created_at: existingCreatedAt,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t.keychain.importDialog.saveError);
    } finally {
      setGenerating(false);
    }
  });

  const manualPasswordError = form.formState.errors.manualPassword?.message;
  const manualPrivateKeyError = form.formState.errors.manualPrivateKey?.message;
  const rawKeyError = form.formState.errors.rawKey?.message;
  const nameError = form.formState.errors.name?.message;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetState();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[540px] bg-card border-border/60 gap-0 p-0 overflow-hidden">
        <div className="p-6 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Key className="h-4 w-4 text-warning" />
              {t.keychain.importDialog.title}
            </DialogTitle>
            <DialogDescription>{t.keychain.importDialog.description}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              { id: "manual" as ImportMethod, icon: Lock, label: t.keychain.importDialog.methodManual },
              { id: "file" as ImportMethod, icon: Upload, label: t.keychain.importDialog.methodFile },
              { id: "paste" as ImportMethod, icon: Copy, label: t.keychain.importDialog.methodPaste },
              { id: "generate" as ImportMethod, icon: Shield, label: t.keychain.importDialog.methodGenerate },
            ]).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  form.setValue("method", item.id, { shouldDirty: true, shouldValidate: true });
                  form.clearErrors();
                  setErrorMessage(null);
                }}
                className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-all cursor-pointer ${
                  method === item.id
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/40 bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                <item.icon className="h-4 w-4" />
                <span className="text-[11px] font-medium">{item.label}</span>
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.nameLabel}</label>
              <Input
                {...form.register("name")}
                placeholder={t.keychain.importDialog.namePlaceholder}
              />
              {nameError ? (
                <p className="mt-1 text-xs text-destructive">{resolveBackendMessage(String(nameError))}</p>
              ) : null}
            </div>
            {method !== "manual" || manualType !== "password" ? (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.passphraseLabel}</label>
                <Input
                  type="password"
                  {...form.register("passphrase")}
                  placeholder={t.keychain.importDialog.passphrasePlaceholder}
                />
              </div>
            ) : null}
          </div>

          {method === "manual" ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.drawer.typeLabel}</label>
                <Controller
                  control={form.control}
                  name="manualType"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={(value) => field.onChange(value as KeychainEntryType)}>
                      <SelectTrigger className="h-9 bg-secondary/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">{t.keychain.typePassword}</SelectItem>
                        <SelectItem value="ssh_key">{t.keychain.typeSshKey}</SelectItem>
                        <SelectItem value="secret">{t.keychain.typeSecret}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              {manualType === "password" || manualType === "secret" ? (
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.password}</label>
                  <Input
                    type="password"
                    {...form.register("manualPassword")}
                    placeholder={t.keychain.drawer.passwordPlaceholder}
                  />
                  {manualPasswordError ? (
                    <p className="mt-1 text-xs text-destructive">{resolveBackendMessage(String(manualPasswordError))}</p>
                  ) : null}
                </div>
              ) : null}

              {manualType === "ssh_key" || manualType === "secret" ? (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.privateKey}</label>
                    <Textarea
                      rows={6}
                      {...form.register("manualPrivateKey")}
                      placeholder={t.keychain.drawer.privateKeyPlaceholder}
                      className="font-mono text-xs"
                    />
                    {manualPrivateKeyError ? (
                      <p className="mt-1 text-xs text-destructive">{resolveBackendMessage(String(manualPrivateKeyError))}</p>
                    ) : null}
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.publicKey}</label>
                    <Textarea
                      rows={4}
                      {...form.register("manualPublicKey")}
                      placeholder={t.keychain.drawer.publicKeyPlaceholder}
                      className="font-mono text-xs"
                    />
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {method === "file" ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void handleSelectFile()}
                className="w-full flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border/60 bg-secondary/20 p-8 hover:border-primary/40 hover:bg-primary/5 transition-colors"
              >
                <FileKey className="h-8 w-8 text-muted-foreground" />
                <div className="text-center">
                  <p className="text-sm text-foreground">{t.keychain.importDialog.selectFileButton}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{t.keychain.importDialog.fileFormats}</p>
                </div>
              </button>
              {sourcePath ? <p className="text-[11px] text-muted-foreground break-all">{sourcePath}</p> : null}
              <Textarea
                rows={6}
                {...form.register("rawKey")}
                placeholder={t.keychain.importDialog.fileContentPlaceholder}
                className="font-mono text-xs"
              />
              {rawKeyError ? (
                <p className="text-xs text-destructive">{resolveBackendMessage(String(rawKeyError))}</p>
              ) : null}
            </div>
          ) : null}

          {method === "paste" ? (
            <div className="space-y-3">
              <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.pasteLabel}</label>
              <Textarea
                rows={8}
                {...form.register("rawKey")}
                placeholder={t.keychain.importDialog.pastePlaceholder}
                className="font-mono text-xs"
              />
              {rawKeyError ? (
                <p className="text-xs text-destructive">{resolveBackendMessage(String(rawKeyError))}</p>
              ) : null}
            </div>
          ) : null}

          {method === "generate" ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.algorithmLabel}</label>
                <Controller
                  control={form.control}
                  name="algorithm"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value as SshKeyGenerateInput["algorithm"])}
                    >
                      <SelectTrigger className="h-9 bg-secondary/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ed25519">{t.keychain.importDialog.algorithmEd25519}</SelectItem>
                        <SelectItem value="rsa4096">{t.keychain.importDialog.algorithmRsa4096}</SelectItem>
                        <SelectItem value="rsa2048">{t.keychain.importDialog.algorithmRsa2048}</SelectItem>
                        <SelectItem value="ecdsa521">{t.keychain.importDialog.algorithmEcdsa521}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.commentLabel}</label>
                <Input
                  {...form.register("generateComment")}
                  placeholder={t.keychain.importDialog.commentPlaceholder}
                />
              </div>
              {generatedFingerprint ? (
                <div className="rounded-lg border border-success/30 bg-success/10 p-2 text-xs text-success">
                  {t.keychain.importDialog.generatedFingerprint}: {generatedFingerprint}
                </div>
              ) : null}
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {errorMessage}
            </div>
          ) : null}
        </div>

        <div className="border-t border-border/30" />
        <DialogFooter className="px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy || generating}>
            {t.common.cancel}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || generating || !(name ?? "").trim()}>
            {generating ? t.keychain.importDialog.generatingAction : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
