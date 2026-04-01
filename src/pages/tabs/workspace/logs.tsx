import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { WorkspaceLogEntry } from "./types";
import type { WorkspaceBlockModule } from "./block-module";

export interface LogsBlockViewProps {
  entries: WorkspaceLogEntry[];
  onClear: () => void;
}

export function LogsBlockView({ entries, onClear }: LogsBlockViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [followTail, setFollowTail] = useState(true);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex h-9 items-center justify-between border-b border-white/10 px-2">
        <p className="text-xs text-zinc-300">Eventos do workspace ({entries.length})</p>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={followTail} onChange={(event) => setFollowTail(event.target.checked)} />
            Seguir
          </label>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={onClear}
          >
            Limpar
          </button>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px]">
        {entries.length === 0 ? (
          <p className="text-zinc-500">Nenhum log registrado neste workspace.</p>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded border border-white/10 bg-zinc-900/60 px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "uppercase",
                      entry.level === "error"
                        ? "text-red-300"
                        : entry.level === "warn"
                          ? "text-amber-300"
                          : entry.level === "success"
                            ? "text-emerald-300"
                            : "text-cyan-300",
                    )}
                  >
                    [{entry.level}]
                  </span>
                  <span className="truncate text-zinc-100">{entry.message}</span>
                </div>
                {entry.details ? <p className="mt-0.5 break-all text-zinc-400">{entry.details}</p> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const logsWorkspaceModule: WorkspaceBlockModule<LogsBlockViewProps> = {
  name: "logs",
  description: "Bloco de logs e eventos do workspace.",
  render: (props) => <LogsBlockView {...props} />,
  onNotFound: ({ blockId, action }) => `Bloco de logs não encontrado (${action}) [${blockId}]`,
  onFailureLoad: ({ blockId, action }) => `Falha ao carregar logs (${action}) [${blockId}]`,
  onDropDownSelect: ({ blockId, action, value }) => `Logs dropdown (${action}) [${blockId}] => ${value}`,
  onStatusChange: ({ blockId, action, status }) =>
    `Estado de logs atualizado (${action}) [${blockId}] => ${status}`,
};

export default logsWorkspaceModule;


