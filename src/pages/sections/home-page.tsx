import {
  Cloud,
  FolderOpen,
  MoreVertical,
  Plus,
  Server,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supportsProtocol } from "@/functions/common";
import { useAppStore } from "@/store/app-store";

function protocolsLabel(protocols: string[]): string {
  if (protocols.length === 2) {
    return "SSH + SFTP";
  }
  if (protocols[0] === "ssh") {
    return "SSH";
  }
  return "SFTP";
}

export function HomePage() {
  const connections = useAppStore((state) => state.connections);
  const sessions = useAppStore((state) => state.sessions);
  const syncState = useAppStore((state) => state.syncState);
  const vaultStatus = useAppStore((state) => state.vaultStatus);

  const openHostDrawer = useAppStore((state) => state.openHostDrawer);
  const deleteHost = useAppStore((state) => state.deleteHost);
  const openSsh = useAppStore((state) => state.openSsh);
  const openSftpWorkspace = useAppStore((state) => state.openSftpWorkspace);

  const hostProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "ssh")),
    [connections],
  );
  const sftpProfiles = useMemo(
    () => connections.filter((profile) => supportsProtocol(profile, "sftp")),
    [connections],
  );

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRootRef.current) {
        return;
      }
      if (!menuRootRef.current.contains(event.target as Node)) {
        setMenuOpenId(null);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  const gridClass = "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

  return (
    <div ref={menuRootRef} className="h-full overflow-auto px-3 py-2">
      <section className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Server className="h-4 w-4 text-cyan-300" />
              Hosts
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xl font-semibold text-zinc-100">{connections.length}</p>
            <p className="text-xs text-zinc-500">Profiles saved in vault.</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Workflow className="h-4 w-4 text-purple-300" />
              Active Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xl font-semibold text-zinc-100">{sessions.length}</p>
            <p className="text-xs text-zinc-500">Connected terminals right now.</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Cloud className="h-4 w-4 text-emerald-300" />
              Sync
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm font-semibold text-zinc-100">
              {syncState.connected ? "Connected" : "Disconnected"}
            </p>
            <p className="truncate text-xs text-zinc-500">{syncState.message}</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-amber-300" />
              Vault
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm font-semibold text-zinc-100">
              {vaultStatus?.initialized ? "Initialized" : "Pending"}
            </p>
            <p className="text-xs text-zinc-500">{vaultStatus?.locked ? "Locked" : "Unlocked"}</p>
          </CardContent>
        </Card>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">Hosts</h2>
          <Button size="sm" onClick={() => openHostDrawer(undefined, "ssh")}>
            <Plus className="mr-1 h-4 w-4" /> Novo Host
          </Button>
        </div>

        {hostProfiles.length === 0 ? (
          <Card className="rounded-md border-dashed border-white/15 bg-zinc-950/40">
            <CardContent className="py-6">
              <p className="text-sm font-medium text-zinc-200">Nenhum host SSH cadastrado</p>
              <p className="mt-1 text-xs text-zinc-500">
                Crie um host para abrir terminais e comecar seu workspace.
              </p>
              <Button size="sm" className="mt-3" onClick={() => openHostDrawer(undefined, "ssh")}>
                <Plus className="mr-1 h-4 w-4" /> Adicionar Host SSH
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className={gridClass}>
            {hostProfiles.map((profile) => {
              const protocols = profile.protocols?.length
                ? profile.protocols
                : profile.kind === "host"
                  ? ["ssh"]
                  : profile.kind === "sftp"
                    ? ["sftp"]
                    : ["ssh", "sftp"];
              const isMenuOpen = menuOpenId === profile.id;
              return (
                <Card
                  key={profile.id}
                  className="cursor-pointer rounded-md border-white/10 bg-zinc-950/60 transition hover:border-purple-400/40"
                  onClick={() => void openSsh(profile)}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span className="inline-flex items-center gap-2">
                        <TerminalSquare className="h-4 w-4 text-purple-300" />
                        {profile.name}
                      </span>
                      <div className="relative flex items-center gap-2">
                        <Badge variant="outline">{protocolsLabel(protocols)}</Badge>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded border border-white/15 text-zinc-300 hover:bg-zinc-900"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpenId(isMenuOpen ? null : profile.id);
                          }}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {isMenuOpen ? (
                          <div className="absolute right-0 top-8 z-20 min-w-[150px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                openHostDrawer(profile, "ssh");
                                setMenuOpenId(null);
                              }}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-zinc-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteHost(profile.id);
                                setMenuOpenId(null);
                              }}
                            >
                              Remover
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </CardTitle>
                    <p className="text-xs text-zinc-400">
                      {profile.username}@{profile.host}:{profile.port}
                    </p>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-zinc-500">Clique para abrir terminal SSH.</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">SFTP</h2>
          <Button size="sm" onClick={() => openHostDrawer(undefined, "sftp")}>
            <Plus className="mr-1 h-4 w-4" /> Novo SFTP
          </Button>
        </div>

        {sftpProfiles.length === 0 ? (
          <Card className="rounded-md border-dashed border-white/15 bg-zinc-950/40">
            <CardContent className="py-6">
              <p className="text-sm font-medium text-zinc-200">Nenhum host SFTP cadastrado</p>
              <p className="mt-1 text-xs text-zinc-500">
                Adicione um perfil SFTP para navegar e mover arquivos remotos.
              </p>
              <Button size="sm" className="mt-3" onClick={() => openHostDrawer(undefined, "sftp")}>
                <Plus className="mr-1 h-4 w-4" /> Adicionar Host SFTP
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className={gridClass}>
            {sftpProfiles.map((profile) => {
              const protocols = profile.protocols?.length
                ? profile.protocols
                : profile.kind === "host"
                  ? ["ssh"]
                  : profile.kind === "sftp"
                    ? ["sftp"]
                    : ["ssh", "sftp"];
              const menuId = `${profile.id}:sftp`;
              const isMenuOpen = menuOpenId === menuId;
              return (
                <Card
                  key={profile.id}
                  className="cursor-pointer rounded-md border-white/10 bg-zinc-950/60 transition hover:border-purple-400/40"
                  onClick={() => void openSftpWorkspace(profile)}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span className="inline-flex items-center gap-2">
                        <FolderOpen className="h-4 w-4 text-purple-300" />
                        {profile.name}
                      </span>
                      <div className="relative flex items-center gap-2">
                        <Badge variant="outline">{protocolsLabel(protocols)}</Badge>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded border border-white/15 text-zinc-300 hover:bg-zinc-900"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpenId(isMenuOpen ? null : menuId);
                          }}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {isMenuOpen ? (
                          <div className="absolute right-0 top-8 z-20 min-w-[150px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                openHostDrawer(profile, "sftp");
                                setMenuOpenId(null);
                              }}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-zinc-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteHost(profile.id);
                                setMenuOpenId(null);
                              }}
                            >
                              Remover
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </CardTitle>
                    <p className="text-xs text-zinc-400">
                      {profile.username}@{profile.host}:{profile.port}
                    </p>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-zinc-500">Clique para abrir workspace SFTP.</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Server className="h-4 w-4 text-purple-300" />
              Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-zinc-500">
            {sessions.length > 0
              ? `${sessions.length} active session(s). Open more blocks to work in parallel.`
              : "No active sessions. Use SSH/SFTP cards to start a workspace."}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
