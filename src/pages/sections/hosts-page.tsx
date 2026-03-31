import { MoreHorizontal, Plus } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supportsProtocol } from "@/functions/common";
import { useAppStore } from "@/store/app-store";

export function HostsPage() {
  const connections = useAppStore((state) => state.connections);
  const openHostDrawer = useAppStore((state) => state.openHostDrawer);
  const deleteHost = useAppStore((state) => state.deleteHost);
  const openSsh = useAppStore((state) => state.openSsh);

  const profiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "ssh")),
    [connections],
  );

  return (
    <div className="h-full overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-100">Hosts</h2>
        <Button size="sm" onClick={() => openHostDrawer(undefined, "ssh")}>
          <Plus className="mr-1 h-4 w-4" /> Novo Host
        </Button>
      </div>

      <div className="grid gap-2">
        {profiles.map((profile) => (
          <Card
            key={profile.id}
            className="cursor-pointer rounded-md border-white/10 bg-zinc-950/60 transition hover:border-purple-400/40"
            onClick={() => void openSsh(profile)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>{profile.name}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">SSH</Badge>
                  <details className="relative" onClick={(event) => event.stopPropagation()}>
                    <summary className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded border border-white/15 text-zinc-300 hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
                      <MoreHorizontal className="h-4 w-4" />
                    </summary>
                    <div className="absolute right-0 top-8 z-20 min-w-[140px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                      <button
                        type="button"
                        className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                        onClick={() => openHostDrawer(profile, "ssh")}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-zinc-900"
                        onClick={() => void deleteHost(profile.id)}
                      >
                        Remover
                      </button>
                    </div>
                  </details>
                </div>
              </CardTitle>
              <p className="text-xs text-zinc-400">
                {profile.username}@{profile.host}:{profile.port}
              </p>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xs text-zinc-500">
                Clique no host para abrir SSH + SFTP acoplado.
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
