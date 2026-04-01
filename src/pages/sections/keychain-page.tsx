import { KeyRound, MoreVertical, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { KeychainEntryType } from "@/types/termopen";

function entryTypeLabel(entryType: KeychainEntryType, t: ReturnType<typeof useT>): string {
  if (entryType === "ssh_key") {
    return t.keychain.typeSshKey;
  }
  if (entryType === "secret") {
    return t.keychain.typeSecret;
  }
  return t.keychain.typePassword;
}

export function KeychainPage() {
  const t = useT();
  const entries = useAppStore((state) => state.keychainEntries);
  const openKeychainDrawer = useAppStore((state) => state.openKeychainDrawer);
  const deleteKeychain = useAppStore((state) => state.deleteKeychain);

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current) {
        return;
      }
      if (!rootRef.current.contains(event.target as Node)) {
        setMenuOpenId(null);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div ref={rootRef} className="h-full overflow-auto px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-100">{t.keychain.title}</h2>
        <Button size="sm" onClick={() => openKeychainDrawer()}>
          <Plus className="mr-1 h-4 w-4" /> {t.keychain.newKey}
        </Button>
      </div>

      {entries.length === 0 ? (
        <Card className="rounded-xl border-dashed border-white/20 bg-zinc-950/70">
          <CardContent className="py-8 text-center">
            <p className="text-base font-semibold text-zinc-100">{t.keychain.emptyTitle}</p>
            <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">{t.keychain.emptyDescription}</p>
            <Button className="mt-4" onClick={() => openKeychainDrawer()}>
              <Plus className="mr-1 h-4 w-4" />
              {t.keychain.addFirst}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {entries.map((entry) => {
            const isMenuOpen = menuOpenId === entry.id;
            return (
              <Card key={entry.id} className="rounded-xl border-white/10 bg-zinc-950/70">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <KeyRound className="h-4 w-4 shrink-0 text-cyan-300" />
                      <span className="truncate">{entry.name}</span>
                    </span>
                    <div className="relative">
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded border border-white/15 text-zinc-300 hover:bg-zinc-900"
                        onClick={() => setMenuOpenId(isMenuOpen ? null : entry.id)}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {isMenuOpen ? (
                        <div className="absolute right-0 top-8 z-[240] min-w-[140px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                          <button
                            type="button"
                            className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                            onClick={() => {
                              openKeychainDrawer(entry);
                              setMenuOpenId(null);
                            }}
                          >
                            {t.keychain.edit}
                          </button>
                          <button
                            type="button"
                            className="w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-zinc-900"
                            onClick={() => {
                              void deleteKeychain(entry.id);
                              setMenuOpenId(null);
                            }}
                          >
                            {t.keychain.remove}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </CardTitle>
                  <p className="text-xs text-zinc-400">{new Date(entry.created_at * 1000).toLocaleString()}</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline">{entryTypeLabel(entry.entry_type ?? "password", t)}</Badge>
                    {entry.password ? <Badge variant="secondary">{t.keychain.password}</Badge> : null}
                    {entry.private_key ? <Badge variant="secondary">{t.keychain.privateKey}</Badge> : null}
                    {entry.public_key ? <Badge variant="secondary">{t.keychain.publicKey}</Badge> : null}
                    {entry.passphrase ? <Badge variant="secondary">{t.keychain.passphrase}</Badge> : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
