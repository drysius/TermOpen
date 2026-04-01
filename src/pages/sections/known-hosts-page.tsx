import { FileCheck2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";

export function KnownHostsPage() {
  const t = useT();
  const knownHosts = useAppStore((state) => state.knownHosts);
  const settings = useAppStore((state) => state.settings);
  const busy = useAppStore((state) => state.busy);
  const refreshKnownHosts = useAppStore((state) => state.refreshKnownHosts);
  const ensureKnownHosts = useAppStore((state) => state.ensureKnownHosts);
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);

  useEffect(() => {
    void refreshKnownHosts(settings.known_hosts_path || null);
  }, [refreshKnownHosts, settings.known_hosts_path]);

  return (
    <div className="h-full overflow-auto px-3 py-2">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{t.knownHosts.title}</h2>
          <p className="text-xs text-zinc-500">{t.knownHosts.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refreshKnownHosts(settings.known_hosts_path || null)}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {t.knownHosts.refresh}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void ensureKnownHosts(settings.known_hosts_path || null)}
            disabled={busy}
          >
            <FileCheck2 className="mr-1 h-4 w-4" />
            {t.knownHosts.createFile}
          </Button>
        </div>
      </div>

      <div className="mb-2 rounded border border-white/10 bg-zinc-950/60 p-2">
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">{t.knownHosts.pathLabel}</label>
        <Input value={settings.known_hosts_path || t.knownHosts.pathDefault} readOnly />
      </div>

      <div className="overflow-hidden rounded border border-white/10">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-zinc-950">
            <tr className="border-b border-white/10 text-zinc-400">
              <th className="px-2 py-2 text-left">Host</th>
              <th className="px-2 py-2 text-left">{t.knownHosts.headerType}</th>
              <th className="px-2 py-2 text-left">Fingerprint</th>
              <th className="w-[60px] px-2 py-2 text-right">{t.knownHosts.headerActions}</th>
            </tr>
          </thead>
          <tbody>
            {knownHosts.map((entry) => (
              <tr key={`${entry.host}:${entry.port}:${entry.fingerprint}`} className="border-b border-white/5">
                <td className="px-2 py-2 text-zinc-200">
                  {entry.host}:{entry.port}
                </td>
                <td className="px-2 py-2 text-zinc-400">{entry.key_type}</td>
                <td className="truncate px-2 py-2 text-zinc-400">{entry.fingerprint}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded border border-white/10 text-zinc-300 hover:bg-zinc-900"
                    onClick={() => void removeKnownHost(entry.line_raw, settings.known_hosts_path || null)}
                    title={t.knownHosts.removeTooltip}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {knownHosts.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-8 text-center text-zinc-500">
                  {t.knownHosts.empty}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
