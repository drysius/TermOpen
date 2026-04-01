import { KeyRound, MoreVertical, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";

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
    <div ref={rootRef} className="h-full overflow-auto px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-100">{t.keychain.title}</h2>
        <Button size="sm" onClick={() => openKeychainDrawer()}>
          <Plus className="mr-1 h-4 w-4" /> {t.keychain.newKey}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {entries.map((entry) => {
          const isMenuOpen = menuOpenId === entry.id;
          return (
            <Card key={entry.id} className="rounded-md border-white/10 bg-zinc-950/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-purple-300" />
                    {entry.name}
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
                      <div className="absolute right-0 top-8 z-30 min-w-[140px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
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
                <div className="flex gap-1">
                  {entry.private_key ? <Badge variant="secondary">{t.keychain.privateKey}</Badge> : null}
                  {entry.public_key ? <Badge variant="secondary">{t.keychain.publicKey}</Badge> : null}
                  {entry.passphrase ? <Badge variant="secondary">{t.keychain.passphrase}</Badge> : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
