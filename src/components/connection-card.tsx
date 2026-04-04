import { HardDrive, Monitor, Server, User } from "lucide-react";

import type { ConnectionProtocol } from "@/types/openptl";

interface ConnectionCardProps {
  name: string;
  host: string;
  protocol: ConnectionProtocol;
  user: string;
  lastUsed: string;
}

const protocolColors: Record<ConnectionProtocol, string> = {
  ssh: "bg-primary/15 text-primary",
  sftp: "bg-info/15 text-info",
  ftp: "bg-success/15 text-success",
  ftps: "bg-success/15 text-success",
  smb: "bg-warning/15 text-warning",
  rdp: "bg-destructive/15 text-destructive",
};

const protocolIcons: Record<ConnectionProtocol, typeof Monitor> = {
  ssh: Monitor,
  sftp: Server,
  ftp: Server,
  ftps: Server,
  smb: HardDrive,
  rdp: Monitor,
};

export function ConnectionCard({ name, host, protocol, user, lastUsed }: ConnectionCardProps) {
  const Icon = protocolIcons[protocol];
  const badgeColor = protocolColors[protocol];

  return (
    <div className="group relative rounded-xl border border-border/60 bg-card p-4 transition-all duration-200 hover:border-border hover:bg-accent/30 cursor-pointer animate-fade-in">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${badgeColor}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground truncate">{name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{host}</p>
          </div>
        </div>
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${badgeColor}`}>
          {protocol.toUpperCase()}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <User className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="text-[11px] text-muted-foreground truncate">{user}</span>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">{lastUsed}</span>
      </div>
    </div>
  );
}

