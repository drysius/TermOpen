import { FolderOpen, Monitor, MoreVertical, Plus, Server, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supportsProtocol } from "@/functions/common";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { ConnectionProfile, ConnectionProtocol } from "@/types/termopen";

function normalizedProtocols(profile: ConnectionProfile): ConnectionProtocol[] {
  const raw = profile.protocols?.length
    ? profile.protocols
    : profile.kind === "host"
      ? (["ssh"] as ConnectionProtocol[])
      : profile.kind === "sftp"
        ? (["sftp"] as ConnectionProtocol[])
        : profile.kind === "rdp"
          ? (["rdp"] as ConnectionProtocol[])
          : (["ssh", "sftp"] as ConnectionProtocol[]);
  const unique = Array.from(new Set(raw));
  if (unique.includes("rdp")) {
    return ["rdp"];
  }
  return unique;
}

function protocolLabel(profile: ConnectionProfile, t: ReturnType<typeof useT>): string {
  const protocols = normalizedProtocols(profile);
  const labels: string[] = [];
  for (const protocol of protocols) {
    if (protocol === "ssh") {
      labels.push(t.home.connections.protocolSsh);
    } else if (protocol === "sftp") {
      labels.push(t.home.connections.protocolSftp);
    } else if (protocol === "ftp") {
      labels.push(t.home.connections.protocolFtp);
    } else if (protocol === "ftps") {
      labels.push(t.home.connections.protocolFtps);
    } else if (protocol === "smb") {
      labels.push(t.home.connections.protocolSmb);
    } else if (protocol === "rdp") {
      labels.push(t.home.connections.protocolRdp);
    }
  }

  if (labels.length === 0) {
    return t.home.connections.protocolSsh;
  }
  if (labels.length === 2 && labels.includes(t.home.connections.protocolSsh) && labels.includes(t.home.connections.protocolSftp)) {
    return t.home.connections.protocolBoth;
  }

  return labels.join(" + ");
}

function resolvePrimaryProtocol(profile: ConnectionProfile): "ssh" | "sftp" | "ftp" | "ftps" | "smb" | "rdp" {
  for (const protocol of normalizedProtocols(profile)) {
    if (
      protocol === "ssh" ||
      protocol === "sftp" ||
      protocol === "ftp" ||
      protocol === "ftps" ||
      protocol === "smb" ||
      protocol === "rdp"
    ) {
      return protocol;
    }
  }
  if (supportsProtocol(profile, "ssh")) {
    return "ssh";
  }
  if (supportsProtocol(profile, "sftp") || supportsProtocol(profile, "ftp") || supportsProtocol(profile, "ftps") || supportsProtocol(profile, "smb")) {
    return "sftp";
  }
  return "rdp";
}

export function HomePage() {
  const t = useT();
  const connections = useAppStore((state) => state.connections);
  const sessions = useAppStore((state) => state.sessions);
  const openHostDrawer = useAppStore((state) => state.openHostDrawer);
  const deleteHost = useAppStore((state) => state.deleteHost);
  const openSsh = useAppStore((state) => state.openSsh);
  const openSftpWorkspace = useAppStore((state) => state.openSftpWorkspace);
  const openRdp = useAppStore((state) => state.openRdp);

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

  const subtitle = useMemo(
    () => t.home.connections.subtitle.replace("{count}", String(connections.length)),
    [connections.length, t.home.connections.subtitle],
  );

  return (
    <div ref={menuRootRef} className="h-full overflow-auto px-4 py-4">
      <section className="rounded-xl border border-white/10 bg-gradient-to-br from-cyan-500/15 via-zinc-950 to-zinc-950 p-4 shadow-xl shadow-black/20">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-500/10">
            <Server className="h-5 w-5 text-cyan-200" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-zinc-100">{t.home.connections.title}</p>
            <p className="text-xs text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-zinc-900/70 px-2 py-1 text-xs text-zinc-300">
              {connections.length > 0 ? `${connections.length}` : t.home.connections.zeroLabel}
            </span>
            <Button size="sm" onClick={() => openHostDrawer(undefined, "ssh")}>
              <Plus className="mr-1 h-4 w-4" />
              {t.home.connections.newConnection}
            </Button>
          </div>
        </div>
      </section>

      <section className="mt-4">
        {connections.length === 0 ? (
          <Card className="rounded-xl border-dashed border-white/20 bg-zinc-950/60">
            <CardContent className="py-8 text-center">
              <p className="text-base font-semibold text-zinc-100">{t.home.connections.emptyTitle}</p>
              <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">{t.home.connections.emptyDescription}</p>
              <Button className="mt-4" onClick={() => openHostDrawer(undefined, "ssh")}>
                <Plus className="mr-1 h-4 w-4" />
                {t.home.connections.createFirst}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {connections.map((profile) => {
              const protocols = normalizedProtocols(profile);
              const hasSsh = supportsProtocol(profile, "ssh");
              const hasFileWorkspace = protocols.some(
                (protocol) => protocol === "sftp" || protocol === "ftp" || protocol === "ftps" || protocol === "smb",
              );
              const hasRdp = supportsProtocol(profile, "rdp");
              const primaryProtocol = resolvePrimaryProtocol(profile);
              const editProtocol = protocols.includes("ssh")
                ? "ssh"
                : protocols.includes("sftp")
                  ? "sftp"
                  : protocols.includes("ftp")
                    ? "ftp"
                    : protocols.includes("ftps")
                      ? "ftps"
                      : protocols.includes("smb")
                        ? "smb"
                        : "rdp";
              const isMenuOpen = menuOpenId === profile.id;
              return (
                <Card
                  key={profile.id}
                  className="group cursor-pointer rounded-xl border-white/10 bg-zinc-950/70 transition hover:border-cyan-400/40"
                  onClick={() => {
                    if (primaryProtocol === "ssh" && hasSsh) {
                      void openSsh(profile);
                      return;
                    }
                    if (
                      (primaryProtocol === "sftp" ||
                        primaryProtocol === "ftp" ||
                        primaryProtocol === "ftps" ||
                        primaryProtocol === "smb") &&
                      hasFileWorkspace
                    ) {
                      void openSftpWorkspace(profile);
                      return;
                    }
                    if (primaryProtocol === "rdp" && hasRdp) {
                      void openRdp(profile);
                      return;
                    }
                    if (hasSsh) {
                      void openSsh(profile);
                    } else if (hasFileWorkspace) {
                      void openSftpWorkspace(profile);
                    } else if (hasRdp) {
                      void openRdp(profile);
                    }
                  }}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-start justify-between gap-2 text-sm">
                      <span className="inline-flex min-w-0 items-center gap-2">
                        {(
                          primaryProtocol === "sftp" ||
                          primaryProtocol === "ftp" ||
                          primaryProtocol === "ftps" ||
                          primaryProtocol === "smb"
                        ) && !hasSsh ? (
                          <FolderOpen className="h-4 w-4 shrink-0 text-cyan-300" />
                        ) : primaryProtocol === "rdp" && !hasSsh && !hasFileWorkspace ? (
                          <Monitor className="h-4 w-4 shrink-0 text-cyan-300" />
                        ) : (
                          <TerminalSquare className="h-4 w-4 shrink-0 text-cyan-300" />
                        )}
                        <span className="truncate">{profile.name}</span>
                      </span>
                      <div className="relative shrink-0">
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
                          <div className="absolute right-0 top-8 z-[240] min-w-[170px] rounded-md border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                              onClick={(event) => {
                                event.stopPropagation();
                                openHostDrawer(profile, editProtocol);
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
                    <p className="truncate text-xs text-zinc-400">
                      {profile.username}@{profile.host}:{profile.port}
                    </p>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="mb-3 flex items-center gap-1">
                      <Badge variant="outline">{protocolLabel(profile, t)}</Badge>
                      <Badge variant="secondary">{sessions.length} session(s)</Badge>
                    </div>
                    <p className="text-xs text-zinc-500">{t.home.connections.cardHint}</p>
                    <div className="mt-3">
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">{t.home.connections.quickActions}</p>
                      <div className="flex gap-2">
                        {hasSsh ? (
                          <button
                            type="button"
                            className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openSsh(profile);
                            }}
                          >
                            {t.home.connections.openSsh}
                          </button>
                        ) : null}
                        {hasFileWorkspace ? (
                          <button
                            type="button"
                            className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openSftpWorkspace(profile);
                            }}
                          >
                            {t.home.connections.openSftp}
                          </button>
                        ) : null}
                        {hasRdp ? (
                          <button
                            type="button"
                            className="rounded border border-white/20 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openRdp(profile);
                            }}
                          >
                            {t.home.connections.openRdp}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
