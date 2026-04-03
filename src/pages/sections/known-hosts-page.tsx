import { AlertTriangle, CheckCircle, Trash2 } from "lucide-react";
import { useEffect } from "react";

import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";

export function KnownHostsPage() {
  const t = useT();
  const knownHosts = useAppStore((state) => state.knownHosts);
  const settings = useAppStore((state) => state.settings);
  const refreshKnownHosts = useAppStore((state) => state.refreshKnownHosts);
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);

  useEffect(() => {
    void refreshKnownHosts(settings.known_hosts_path || null);
  }, [refreshKnownHosts, settings.known_hosts_path]);

  return (
    <div className="flex-1 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t.sidebar.knownHosts}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t.knownHosts.subtitle}</p>
        </div>
        <div />
      </div>

      <div className="rounded-xl border border-border/60 overflow-hidden">
        <div className="grid grid-cols-[1fr_170px_220px_80px] gap-4 px-4 py-2.5 bg-secondary/30 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          <span>{t.knownHosts.headerHost}</span>
          <span>{t.knownHosts.headerAlgorithm}</span>
          <span>{t.knownHosts.headerFingerprint}</span>
          <span>{t.knownHosts.headerStatus}</span>
        </div>
        {knownHosts.map((host) => (
          <div
            key={`${host.host}:${host.port}:${host.fingerprint}`}
            className="grid grid-cols-[1fr_170px_220px_80px] gap-4 px-4 py-3 border-t border-border/30 hover:bg-surface-elevated transition-colors items-center animate-fade-in"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-mono text-foreground truncate">
                {host.host}:{host.port}
              </span>
              <button
                type="button"
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                onClick={() => void removeKnownHost(host.line_raw, settings.known_hosts_path || null)}
                title={t.knownHosts.removeTooltip}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="text-xs text-muted-foreground">{host.key_type}</span>
            <span className="text-xs font-mono text-muted-foreground truncate">{host.fingerprint}</span>
            <span>
              {host.fingerprint ? (
                <CheckCircle className="h-4 w-4 text-success" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-warning" />
              )}
            </span>
          </div>
        ))}
        {knownHosts.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t.knownHosts.empty}</div>
        ) : null}
      </div>
    </div>
  );
}
