import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/langs";
import { api } from "@/lib/tauri";
import { useAppStore } from "@/store/app-store";
import type { DebugLogEntry } from "@/types/openptl";

function levelClass(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === "error") {
    return "text-red-300";
  }
  if (normalized === "warn" || normalized === "warning") {
    return "text-amber-300";
  }
  if (normalized === "debug") {
    return "text-purple-300";
  }
  return "text-cyan-300";
}

export function DebugLogsPage() {
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadLogs = useCallback(async () => {
    if (!settings.debug_logs_enabled) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const values = await api.debugLogsList();
      setEntries(values);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [settings.debug_logs_enabled]);

  useEffect(() => {
    void loadLogs();
    if (!settings.debug_logs_enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loadLogs, settings.debug_logs_enabled]);

  useEffect(() => {
    if (!followTail) {
      return;
    }
    const host = listRef.current;
    if (!host) {
      return;
    }
    host.scrollTop = host.scrollHeight;
  }, [entries, followTail]);

  const orderedEntries = useMemo(() => entries.slice(), [entries]);

  async function handleClear() {
    try {
      await api.debugLogsClear();
      setEntries([]);
    } catch {
      setEntries([]);
    }
  }

  return (
    <div className="h-full overflow-auto px-3 py-2">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{t.debugLogs.title}</h2>
          <p className="text-xs text-zinc-500">{t.debugLogs.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={followTail} onChange={(event) => setFollowTail(event.target.checked)} />
            {t.debugLogs.followTail}
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void loadLogs()}
            disabled={loading}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {t.debugLogs.refresh}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleClear()}
            disabled={!settings.debug_logs_enabled || entries.length === 0}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {t.debugLogs.clear}
          </Button>
        </div>
      </div>

      {!settings.debug_logs_enabled ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p className="font-medium">{t.debugLogs.disabledTitle}</p>
          <p className="mt-1 text-xs text-amber-100/80">{t.debugLogs.disabledDescription}</p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="min-h-[300px] space-y-1 overflow-auto rounded border border-white/10 bg-zinc-950/70 p-2 font-mono text-[11px]"
        >
          {orderedEntries.length === 0 ? (
            <p className="py-6 text-center text-zinc-500">{t.debugLogs.empty}</p>
          ) : (
            orderedEntries.map((entry) => (
              <div key={entry.id} className="rounded border border-white/10 bg-zinc-900/60 px-2 py-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">{new Date(entry.timestamp_ms).toLocaleString()}</span>
                  <span className={levelClass(entry.level)}>[{entry.level}]</span>
                  <span className="text-zinc-400">{entry.source}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-100">{entry.message}</span>
                </div>
                {entry.context ? <p className="mt-0.5 break-all text-zinc-400">{entry.context}</p> : null}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
