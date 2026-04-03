import { Copy, FolderOpen, HardDrive, Monitor, Pencil, Terminal, Trash2 } from "lucide-react";
import { useState } from "react";

import { AppConfirmDialog } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/langs";
import type { ConnectionProfile, ConnectionProtocol } from "@/types/termopen";

interface ConnectionDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionProfile | null;
  onEdit: (profile: ConnectionProfile) => void;
  onCopy: (profile: ConnectionProfile) => void;
  onDelete: (profileId: string) => void;
  onAccess: (profile: ConnectionProfile) => void;
  onOpenSsh: (profile: ConnectionProfile) => void;
  onOpenFiles: (profile: ConnectionProfile) => void;
  onOpenRdp: (profile: ConnectionProfile) => void;
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
  sftp: Monitor,
  ftp: Monitor,
  ftps: Monitor,
  smb: HardDrive,
  rdp: Monitor,
};

function normalizeProtocols(profile: ConnectionProfile): ConnectionProtocol[] {
  if (profile.protocols.length > 0) {
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

function primaryProtocol(profile: ConnectionProfile): ConnectionProtocol {
  const normalized = normalizeProtocols(profile);
  if (normalized.includes("rdp")) {
    return "rdp";
  }
  if (normalized.includes("sftp")) {
    return "sftp";
  }
  if (normalized.includes("ftp")) {
    return "ftp";
  }
  if (normalized.includes("ftps")) {
    return "ftps";
  }
  if (normalized.includes("smb")) {
    return "smb";
  }
  return "ssh";
}

function supportsFileWorkspace(profile: ConnectionProfile): boolean {
  return normalizeProtocols(profile).some(
    (protocol) => protocol === "sftp" || protocol === "ftp" || protocol === "ftps" || protocol === "smb",
  );
}

export function ConnectionDetailDialog({
  open,
  onOpenChange,
  connection,
  onEdit,
  onCopy,
  onDelete,
  onAccess,
  onOpenSsh,
  onOpenFiles,
  onOpenRdp,
}: ConnectionDetailDialogProps) {
  const t = useT();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  if (!connection) {
    return null;
  }

  const protocols = normalizeProtocols(connection);
  const protocol = primaryProtocol(connection);
  const Icon = protocolIcons[protocol];
  const hasSsh = protocols.includes("ssh");
  const hasFiles = supportsFileWorkspace(connection);
  const hasRdp = protocols.includes("rdp");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[460px] bg-card border-border/60 gap-0 p-0 overflow-hidden">
          <div className="p-6 space-y-5">
            <div className="flex items-start gap-4">
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${protocolColors[protocol]}`}>
                <Icon className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <DialogHeader>
                  <DialogTitle className="text-base truncate">{connection.name}</DialogTitle>
                  <DialogDescription className="font-mono text-xs truncate">
                    {connection.host}:{connection.port}
                  </DialogDescription>
                </DialogHeader>
              </div>
            </div>

            <div className="rounded-lg border border-border/40 overflow-hidden">
              {[
                { label: t.hostDrawer.protocols.label, value: protocols.map((item) => item.toUpperCase()).join(", ") },
                { label: t.hostDrawer.host.label, value: connection.host },
                { label: t.hostDrawer.port.label, value: String(connection.port) },
                { label: t.hostDrawer.username.label, value: connection.username },
                { label: t.hostDrawer.remotePath.label, value: connection.remote_path || "-" },
              ].map((row, index) => (
                <div
                  key={row.label}
                  className={`flex items-center justify-between px-3 py-2.5 text-sm ${index > 0 ? "border-t border-border/20" : ""}`}
                >
                  <span className="text-muted-foreground text-xs">{row.label}</span>
                  <span className="text-foreground text-xs font-mono text-right max-w-[220px] truncate">{row.value}</span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 h-9"
                disabled={!hasSsh}
                onClick={() => onOpenSsh(connection)}
              >
                <Terminal className="h-3.5 w-3.5" />
                {t.home.connections.openSsh}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 h-9"
                disabled={!hasFiles}
                onClick={() => onOpenFiles(connection)}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t.home.connections.openSftp}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 h-9 col-span-2"
                disabled={!hasRdp}
                onClick={() => onOpenRdp(connection)}
              >
                <Monitor className="h-3.5 w-3.5" />
                {t.home.connections.openRdp}
              </Button>
            </div>
          </div>

          <div className="border-t border-border/30" />
          <DialogFooter className="px-6 py-4 flex-row justify-between">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => onCopy(connection)}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => onEdit(connection)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button size="sm" onClick={() => onAccess(connection)}>
              {t.home.connections.accessAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AppConfirmDialog
        open={deleteConfirmOpen}
        title={t.home.connections.deleteConfirmTitle}
        message={t.home.connections.deleteConfirmMessage.replace("{name}", connection.name)}
        confirmLabel={t.home.connections.deleteConfirmAction}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          onDelete(connection.id);
        }}
      />
    </>
  );
}
