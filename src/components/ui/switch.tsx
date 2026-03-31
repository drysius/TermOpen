import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

interface SwitchProps extends Omit<ComponentPropsWithoutRef<"button">, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({ checked, onCheckedChange, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full border transition-colors",
        checked ? "border-purple-400/70 bg-purple-600/30" : "border-white/20 bg-zinc-900",
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-zinc-100 transition-transform",
          checked ? "translate-x-5" : "translate-x-1",
        )}
      />
    </button>
  );
}
