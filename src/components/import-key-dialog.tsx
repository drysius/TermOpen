import { useEffect, useMemo, useState } from "react";
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
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
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

export function ImportKeyDialog({
  open,
  onOpenChange,
  initialMethod = "file",
  initialEntry = null,
}: ImportKeyDialogProps) {
  const t = useT();
  const saveKeychain = useAppStore((state) => state.saveKeychain);
  const busy = useAppStore((state) => state.busy);

  const [method, setMethod] = useState<ImportMethod>(initialMethod);
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [rawKey, setRawKey] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [manualType, setManualType] = useState<KeychainEntryType>("password");
  const [manualPassword, setManualPassword] = useState("");
  const [manualPrivateKey, setManualPrivateKey] = useState("");
  const [manualPublicKey, setManualPublicKey] = useState("");
  const [algorithm, setAlgorithm] = useState<SshKeyGenerateInput["algorithm"]>("ed25519");
  const [generateComment, setGenerateComment] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedFingerprint, setGeneratedFingerprint] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submitLabel = useMemo(
    () => (method === "generate" ? t.keychain.importDialog.generateAction : t.keychain.importDialog.importAction),
    [method, t.keychain.importDialog.generateAction, t.keychain.importDialog.importAction],
  );

  function resetState(defaultMethod: ImportMethod = initialMethod) {
    setMethod(defaultMethod);
    setName("");
    setPassphrase("");
    setRawKey("");
    setSourcePath("");
    setManualType("password");
    setManualPassword("");
    setManualPrivateKey("");
    setManualPublicKey("");
    setAlgorithm("ed25519");
    setGenerateComment("");
    setGeneratedFingerprint(null);
    setErrorMessage(null);
  }

  function hydrateFromEntry(entry: KeychainEntry) {
    setMethod("manual");
    setName(entry.name ?? "");
    setPassphrase(entry.passphrase ?? "");
    setSourcePath("");
    setManualType(entry.entry_type);
    setManualPassword(entry.password ?? "");
    setManualPrivateKey(entry.private_key ?? "");
    setManualPublicKey(entry.public_key ?? "");
    setRawKey(entry.private_key ?? entry.public_key ?? "");
    setAlgorithm("ed25519");
    setGenerateComment("");
    setGeneratedFingerprint(null);
    setErrorMessage(null);
  }

  useEffect(() => {
    if (open) {
      if (initialEntry) {
        hydrateFromEntry(initialEntry);
      } else {
        resetState(initialMethod);
        setErrorMessage(null);
      }
    }
  }, [initialEntry, initialMethod, open]);

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
      setRawKey(content);
      if (!name) {
        setName(defaultKeyName(selected));
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

  async function handleSubmit() {
    setErrorMessage(null);
    const existingId = initialEntry?.id ?? "";
    const existingCreatedAt = initialEntry?.created_at ?? 0;
    try {
      if (method === "manual") {
        const nextName = (name || "credential").trim();
        const nextPassword = manualPassword.trim();
        const nextPrivateKey = manualPrivateKey.trim();
        const nextPublicKey = manualPublicKey.trim();
        const nextPassphrase = passphrase.trim();

        if (manualType === "password" && !nextPassword) {
          setErrorMessage(t.keychain.importDialog.missingManualData);
          return;
        }
        if (manualType === "ssh_key" && !nextPrivateKey && !nextPublicKey) {
          setErrorMessage(t.keychain.importDialog.missingManualData);
          return;
        }
        if (manualType === "secret" && !nextPassword && !nextPrivateKey && !nextPublicKey) {
          setErrorMessage(t.keychain.importDialog.missingManualData);
          return;
        }

        await persistEntry({
          id: existingId,
          name: nextName,
          entry_type: manualType,
          password: manualType === "password" || manualType === "secret" ? (nextPassword || null) : null,
          private_key: manualType === "ssh_key" || manualType === "secret" ? (nextPrivateKey || null) : null,
          public_key: manualType === "ssh_key" || manualType === "secret" ? (nextPublicKey || null) : null,
          passphrase: manualType === "ssh_key" || manualType === "secret" ? (nextPassphrase || null) : null,
          created_at: existingCreatedAt,
        });
        return;
      }

      if (method === "generate") {
        setGenerating(true);
        const generated = await api.sshKeyGenerate({
          algorithm,
          comment: generateComment || name || null,
          passphrase: passphrase || null,
        });
        setGeneratedFingerprint(generated.fingerprint);
        await persistEntry({
          id: existingId,
          name: (name || generated.name_suggestion || "ssh_key").trim(),
          entry_type: "ssh_key",
          password: null,
          private_key: generated.private_key,
          public_key: generated.public_key,
          passphrase: passphrase || null,
          created_at: existingCreatedAt,
        });
        return;
      }

      const keyValue = rawKey.trim();
      if (!keyValue) {
        setErrorMessage(t.keychain.importDialog.missingKey);
        return;
      }

      const keyFields = inferKeyFields(keyValue);
      await persistEntry({
        id: existingId,
        name: (name || "ssh_key").trim(),
        entry_type: "ssh_key",
        password: null,
        private_key: keyFields.private_key,
        public_key: keyFields.public_key,
        passphrase: passphrase || null,
        created_at: existingCreatedAt,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t.keychain.importDialog.saveError);
    } finally {
      setGenerating(false);
    }
  }

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
                onClick={() => setMethod(item.id)}
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
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t.keychain.importDialog.namePlaceholder}
              />
            </div>
            {method !== "manual" || manualType !== "password" ? (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.passphraseLabel}</label>
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  placeholder={t.keychain.importDialog.passphrasePlaceholder}
                />
              </div>
            ) : null}
          </div>

          {method === "manual" ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.drawer.typeLabel}</label>
                <Select value={manualType} onValueChange={(value) => setManualType(value as KeychainEntryType)}>
                  <SelectTrigger className="h-9 bg-secondary/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">{t.keychain.typePassword}</SelectItem>
                    <SelectItem value="ssh_key">{t.keychain.typeSshKey}</SelectItem>
                    <SelectItem value="secret">{t.keychain.typeSecret}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {manualType === "password" || manualType === "secret" ? (
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.password}</label>
                  <Input
                    type="password"
                    value={manualPassword}
                    onChange={(event) => setManualPassword(event.target.value)}
                    placeholder={t.keychain.drawer.passwordPlaceholder}
                  />
                </div>
              ) : null}

              {manualType === "ssh_key" || manualType === "secret" ? (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.privateKey}</label>
                    <Textarea
                      rows={6}
                      value={manualPrivateKey}
                      onChange={(event) => setManualPrivateKey(event.target.value)}
                      placeholder={t.keychain.drawer.privateKeyPlaceholder}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.publicKey}</label>
                    <Textarea
                      rows={4}
                      value={manualPublicKey}
                      onChange={(event) => setManualPublicKey(event.target.value)}
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
                value={rawKey}
                onChange={(event) => setRawKey(event.target.value)}
                placeholder={t.keychain.importDialog.fileContentPlaceholder}
                className="font-mono text-xs"
              />
            </div>
          ) : null}

          {method === "paste" ? (
            <div className="space-y-3">
              <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.pasteLabel}</label>
              <Textarea
                rows={8}
                value={rawKey}
                onChange={(event) => setRawKey(event.target.value)}
                placeholder={t.keychain.importDialog.pastePlaceholder}
                className="font-mono text-xs"
              />
            </div>
          ) : null}

          {method === "generate" ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.algorithmLabel}</label>
                <Select
                  value={algorithm}
                  onValueChange={(value) => setAlgorithm(value as SshKeyGenerateInput["algorithm"])}
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
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t.keychain.importDialog.commentLabel}</label>
                <Input
                  value={generateComment}
                  onChange={(event) => setGenerateComment(event.target.value)}
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
          <Button size="sm" onClick={() => void handleSubmit()} disabled={busy || generating || !name.trim()}>
            {generating ? t.keychain.importDialog.generatingAction : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
