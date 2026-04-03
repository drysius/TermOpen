import { Fingerprint, Key, Plus, Shield } from "lucide-react";
import { useState } from "react";

import { ImportKeyDialog, type ImportMethod } from "@/components/import-key-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";

function formatCreatedAt(timestamp: number): string {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp * 1000).toLocaleDateString();
}

function fingerprintPreview(publicKey: string | null | undefined): string {
  if (!publicKey) {
    return "-";
  }
  return publicKey.length > 32 ? `${publicKey.slice(0, 32)}...` : publicKey;
}

export function KeychainPage() {
  const t = useT();
  const entries = useAppStore((state) => state.keychainEntries);
  const openKeychainDrawer = useAppStore((state) => state.openKeychainDrawer);
  const deleteKeychain = useAppStore((state) => state.deleteKeychain);
  const [importOpen, setImportOpen] = useState(false);
  const [importMethod, setImportMethod] = useState<ImportMethod>("file");

  return (
    <div className="flex-1 p-6 space-y-6">
      <ImportKeyDialog open={importOpen} onOpenChange={setImportOpen} initialMethod={importMethod} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t.sidebar.keychain}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t.keychain.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => {
              setImportMethod("manual");
              setImportOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t.keychain.newItem}
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setImportMethod("file");
              setImportOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t.keychain.importKey}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-xl border border-border/60 bg-card p-4 transition-all hover:border-border hover:bg-surface-elevated animate-fade-in"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/15">
                <Key className="h-5 w-5 text-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-foreground font-mono truncate">{entry.name}</h3>
                <span className="text-[10px] text-muted-foreground/60">{formatCreatedAt(entry.created_at)}</span>
              </div>
            </div>
            <div className="space-y-1.5 border-t border-border/40 pt-3">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Shield className="h-3 w-3 shrink-0" />
                {entry.entry_type}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Fingerprint className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">
                  {t.keychain.fingerprintLabel}: {fingerprintPreview(entry.public_key)}
                </span>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-border/20 flex items-center justify-end gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openKeychainDrawer(entry)}>
                {t.keychain.edit}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => void deleteKeychain(entry.id)}>
                {t.keychain.remove}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
