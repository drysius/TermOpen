import type { ReactNode } from "react";

export function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,340px)] md:items-center">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="md:justify-self-end md:min-w-[240px] md:max-w-[340px] md:w-full">{control}</div>
    </div>
  );
}

