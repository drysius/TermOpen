import * as React from "react";

import { cn } from "@/lib/utils";

interface DrawerProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string;
}

export function AppDrawer({
  open,
  title,
  description,
  onClose,
  children,
  widthClassName = "w-[380px]",
}: DrawerProps) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-40 transition-colors duration-200",
        open ? "pointer-events-auto bg-black/35" : "pointer-events-none bg-transparent",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        className={cn(
          "pointer-events-auto absolute bottom-0 right-0 top-0 border-l border-border/60 bg-card/95 shadow-2xl transition-transform duration-200",
          widthClassName,
          open ? "translate-x-0" : "translate-x-full",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="border-b border-border/60 px-4 py-4">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </header>
        <div className="h-[calc(100%-64px)] overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

