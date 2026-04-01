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
import { useT } from "@/langs";
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
  const t = useT();
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
              {t.home.stats.hosts}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xl font-semibold text-zinc-100">{connections.length}</p>
            <p className="text-xs text-zinc-500">{t.home.stats.hostsSub}</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Workflow className="h-4 w-4 text-purple-300" />
              {t.home.stats.sessions}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xl font-semibold text-zinc-100">{sessions.length}</p>
            <p className="text-xs text-zinc-500">{t.home.stats.sessionsSub}</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <Cloud className="h-4 w-4 text-emerald-300" />
              {t.home.stats.sync}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm font-semibold text-zinc-100">
              {syncState.connected ? t.home.stats.syncConnected : t.home.stats.syncDisconnected}
            </p>
            <p className="truncate text-xs text-zinc-500">{syncState.message}</p>
          </CardContent>
        </Card>

        <Card className="rounded-md border-white/10 bg-zinc-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="inline-flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-amber-300" />
              {t.home.stats.vault}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm font-semibold text-zinc-100">
              {vaultStatus?.initialized ? t.home.stats.vaultInitialized : t.home.stats.vaultPending}
            </p>
            <p className="text-xs text-zinc-500">{vaultStatus?.locked ? t.home.stats.vaultLocked : t.home.stats.vaultUnlocked}</p>
          </CardContent>
        </Card>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">{t.home.hosts.title}</h2>
          <Button size="sm" onClick={() => openHostDrawer(undefined, "ssh")}>
            <Plus className="mr-1 h-4 w-4" /> {t.home.hosts.newHost}
          </Button>
        </div>

        {hostProfiles.length === 0 ? (
          <Card className="rounded-md border-dashed border-white/15 bg-zinc-950/40">
            <CardContent className="py-6">
              <p className="text-sm font-medium text-zinc-200">{t.home.hosts.emptyTitle}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {t.home.hosts.emptyDescription}
              </p>
              <Button size="sm" className="mt-3" onClick={() => openHostDrawer(undefined, "ssh")}>
                <Plus className="mr-1 h-4 w-4" /> {t.home.hosts.addButton}
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
                              {t.home.hosts.edit}
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
                              {t.home.hosts.remove}
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
                    <p className="text-xs text-zinc-500">{t.home.hosts.clickToOpen}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">{t.home.sftp.title}</h2>
          <Button size="sm" onClick={() => openHostDrawer(undefined, "sftp")}>
            <Plus className="mr-1 h-4 w-4" /> {t.home.sftp.newSftp}
          </Button>
        </div>

        {sftpProfiles.length === 0 ? (
          <Card className="rounded-md border-dashed border-white/15 bg-zinc-950/40">
            <CardContent className="py-6">
              <p className="text-sm font-medium text-zinc-200">{t.home.sftp.emptyTitle}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {t.home.sftp.emptyDescription}
              </p>
              <Button size="sm" className="mt-3" onClick={() => openHostDrawer(undefined, "sftp")}>
                <Plus className="mr-1 h-4 w-4" /> {t.home.sftp.addButton}
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
                              {t.home.sftp.edit}
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
                              {t.home.sftp.remove}
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
                    <p className="text-xs text-zinc-500">{t.home.sftp.clickToOpen}</p>
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
              {t.home.sessionsCard.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-zinc-500">
            {sessions.length > 0
              ? t.home.sessionsCard.active.replace("{count}", String(sessions.length))
              : t.home.sessionsCard.empty}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
