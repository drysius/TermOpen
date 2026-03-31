import * as React from "react";

import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Dialog({ open, title, description, onClose, children, footer }: DialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-white/10 bg-zinc-950/95 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-white/10 px-5 py-4">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          {description ? <p className="mt-1 text-sm text-zinc-400">{description}</p> : null}
        </div>
        <div className="max-h-[65vh] overflow-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-white/10 px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  confirmLabel?: string;
}

export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  busy,
  confirmLabel = "Confirmar",
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-white",
              busy ? "bg-purple-700/50" : "bg-purple-700 hover:bg-purple-600",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-300">{message}</p>
    </Dialog>
  );
}
