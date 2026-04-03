import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function OptionDropdown<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; description: string }>;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((item) => item.value === value) ?? options[0];

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="flex h-10 w-full items-center justify-between rounded-lg border border-border/50 bg-secondary/60 px-3 text-left text-sm text-foreground transition hover:border-primary/50"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition ${open ? "rotate-180" : ""}`} />
      </button>
      {selected?.description ? <p className="mt-1 text-xs text-muted-foreground">{selected.description}</p> : null}
      {open ? (
        <div className="absolute z-[260] mt-1 w-full rounded-lg border border-border/40 bg-background/95 p-1 shadow-2xl">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`w-full rounded px-2 py-2 text-left transition ${
                option.value === value ? "bg-primary/15 text-primary" : "text-foreground/90 hover:bg-secondary/70"
              }`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <p className="text-xs font-medium">{option.label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

