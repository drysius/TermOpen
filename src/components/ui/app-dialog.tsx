import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function AppDialog({ open, title, description, onClose, children, footer }: DialogProps) {
  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-border/60 bg-card/95 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="max-h-[65vh] overflow-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-border/60 px-5 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
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

export function AppConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  busy,
  confirmLabel = "Confirmar",
}: ConfirmDialogProps) {
  return (
    <AppDialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-primary-foreground",
              busy ? "bg-primary/50" : "bg-primary hover:bg-primary/90",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">{message}</p>
    </AppDialog>
  );
}
