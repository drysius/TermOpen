import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { ConnectionCard } from "@/components/connection-card";
import { ConnectionDetailDialog } from "@/components/connection-detail-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/langs";
import { formatProfileSourceId } from "@/pages/tabs/workspace/natives/runtime";
import { useAppStore } from "@/store/app-store";
import type { ConnectionProfile, ConnectionProtocol } from "@/types/termopen";

function normalizeProtocols(profile: ConnectionProfile): string[] {
  if (profile.protocols?.length) {
    return profile.protocols;
  }
  if (profile.kind === "rdp") {
    return ["rdp"];
  }
  if (profile.kind === "sftp") {
    return ["sftp"];
  }
  return ["ssh"];
}

function primaryProtocol(profile: ConnectionProfile): ConnectionProfile["protocols"][number] {
  const protocols = normalizeProtocols(profile);
  if (protocols.includes("rdp")) {
    return "rdp";
  }
  if (protocols.includes("sftp")) {
    return "sftp";
  }
  if (protocols.includes("ftp")) {
    return "ftp";
  }
  if (protocols.includes("ftps")) {
    return "ftps";
  }
  if (protocols.includes("smb")) {
    return "smb";
  }
  return "ssh";
}

function resolveFileProtocol(profile: ConnectionProfile): "sftp" | "ftp" | "ftps" | "smb" | null {
  const protocols = normalizeProtocols(profile);
  if (protocols.includes("sftp")) {
    return "sftp";
  }
  if (protocols.includes("ftp")) {
    return "ftp";
  }
  if (protocols.includes("ftps")) {
    return "ftps";
  }
  if (protocols.includes("smb")) {
    return "smb";
  }
  return null;
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
  const openTab = useAppStore((state) => state.openTab);

  const [search, setSearch] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<ConnectionProtocol | "all">("all");
  const [selectedConn, setSelectedConn] = useState<ConnectionProfile | null>(null);

  const activeProfileIds = useMemo(() => new Set(sessions.map((session) => session.profile_id)), [sessions]);

  const filteredConnections = useMemo(() => {
    const query = search.trim().toLowerCase();
    return connections.filter((connection) => {
      const protocols = normalizeProtocols(connection).join(" ");
      const matchesQuery =
        !query ||
        connection.name.toLowerCase().includes(query) ||
        connection.host.toLowerCase().includes(query) ||
        connection.username.toLowerCase().includes(query) ||
        protocols.includes(query);
      const matchesProtocol =
        protocolFilter === "all" || normalizeProtocols(connection).includes(protocolFilter);

      return matchesQuery && matchesProtocol;
    });
  }, [connections, protocolFilter, search]);

  const stats = useMemo(() => {
    const protocols = filteredConnections.flatMap((connection) => normalizeProtocols(connection));
    return [
      { label: t.home.connections.statsTotal, value: String(filteredConnections.length), color: "text-foreground" },
      { label: t.home.connections.statsSsh, value: String(protocols.filter((protocol) => protocol === "ssh").length), color: "text-primary" },
      { label: t.home.connections.statsSftp, value: String(protocols.filter((protocol) => protocol === "sftp").length), color: "text-info" },
      { label: t.home.connections.statsProtocols, value: String(new Set(protocols).size), color: "text-warning" },
    ];
  }, [filteredConnections, t.home.connections.statsProtocols, t.home.connections.statsSftp, t.home.connections.statsSsh, t.home.connections.statsTotal]);

  return (
    <div className="flex-1 p-6 space-y-6">
      <ConnectionDetailDialog
        open={!!selectedConn}
        onOpenChange={(open) => !open && setSelectedConn(null)}
        connection={selectedConn}
        onEdit={(profile) => {
          openHostDrawer(profile, primaryProtocol(profile));
        }}
        onCopy={(profile) => {
          openHostDrawer(
            {
              ...profile,
              id: "",
              name: `${profile.name} (cópia)`,
            },
            primaryProtocol(profile),
          );
          setSelectedConn(null);
        }}
        onDelete={(profileId) => {
          void deleteHost(profileId);
          setSelectedConn(null);
        }}
        onAccess={(profile) => {
          const protocols = normalizeProtocols(profile);
          const hasSsh = protocols.includes("ssh");
          const fileProtocol = resolveFileProtocol(profile);

          if (protocols.includes("rdp")) {
            void openRdp(profile);
            setSelectedConn(null);
            return;
          }

          if (hasSsh) {
            openTab({
              id: `workspace:${Date.now()}:${Math.random().toString(16).slice(2, 7)}`,
              type: "workspace",
              title: `Workspace - ${profile.name}`,
              closable: true,
              profileId: profile.id,
              initialBlock: "terminal",
              initialSourceId: formatProfileSourceId(profile.id, "sftp"),
              initialOpenFiles: fileProtocol === "sftp",
            });
            setSelectedConn(null);
            return;
          }

          if (fileProtocol) {
            openTab({
              id: `workspace:${Date.now()}:${Math.random().toString(16).slice(2, 7)}`,
              type: "workspace",
              title: `Workspace - ${profile.name}`,
              closable: true,
              profileId: profile.id,
              initialBlock: "sftp",
              initialSourceId: formatProfileSourceId(profile.id, fileProtocol),
            });
            setSelectedConn(null);
          }
        }}
        onOpenSsh={(profile) => {
          void openSsh(profile);
          setSelectedConn(null);
        }}
        onOpenFiles={(profile) => {
          void openSftpWorkspace(profile);
          setSelectedConn(null);
        }}
        onOpenRdp={(profile) => {
          void openRdp(profile);
          setSelectedConn(null);
        }}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t.home.connections.title}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t.home.connections.subtitle}
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => openHostDrawer(undefined, "ssh")}>
          <Plus className="h-4 w-4" />
          {t.home.connections.newConnection}
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t.home.connections.searchPlaceholder}
            className="h-9 w-full rounded-lg border border-border bg-secondary/50 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <Select
          value={protocolFilter}
          onValueChange={(value) => setProtocolFilter(value as ConnectionProtocol | "all")}
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.home.connections.filterProtocolAll}</SelectItem>
            <SelectItem value="ssh">{t.home.connections.protocolSsh}</SelectItem>
            <SelectItem value="sftp">{t.home.connections.protocolSftp}</SelectItem>
            <SelectItem value="ftp">{t.home.connections.protocolFtp}</SelectItem>
            <SelectItem value="ftps">{t.home.connections.protocolFtps}</SelectItem>
            <SelectItem value="smb">{t.home.connections.protocolSmb}</SelectItem>
            <SelectItem value="rdp">{t.home.connections.protocolRdp}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border border-border/40 bg-card p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{stat.label}</p>
            <p className={`text-2xl font-semibold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filteredConnections.map((connection) => {
          const protocol = primaryProtocol(connection);
          return (
            <div key={connection.id} onClick={() => setSelectedConn(connection)}>
              <ConnectionCard
                name={connection.name}
                host={`${connection.host}:${connection.port}`}
                protocol={protocol}
                user={connection.username}
                lastUsed={activeProfileIds.has(connection.id) ? t.home.connections.statusActive : t.home.connections.statusIdle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
