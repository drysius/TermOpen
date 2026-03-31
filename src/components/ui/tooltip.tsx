import * as React from "react";

interface IconTooltipProps {
  label: string;
  children: React.ReactNode;
}

export function IconTooltip({ label, children }: IconTooltipProps) {
  return (
    <div className="group relative flex items-center justify-center">
      {children}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] hidden whitespace-nowrap rounded-md border border-white/15 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-lg group-hover:block">
        {label}
      </span>
    </div>
  );
}
