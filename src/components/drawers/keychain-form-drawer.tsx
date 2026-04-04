import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/app-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { resolveBackendMessage } from "@/functions/backend-message";
import { useT } from "@/langs";
import { keychainSchema, type KeychainSchemaInput, type KeychainSchemaValues } from "@/schemas/keychain";
import { useAppStore } from "@/store/app-store";
import type { KeychainEntry, KeychainEntryType } from "@/types/openptl";

export function KeychainFormDrawer() {
  const t = useT();
  const open = useAppStore((state) => state.keychainDrawerOpen);
  const initialEntry = useAppStore((state) => state.keychainDraft);
  const busy = useAppStore((state) => state.busy);
  const closeKeychainDrawer = useAppStore((state) => state.closeKeychainDrawer);
  const saveKeychain = useAppStore((state) => state.saveKeychain);
  const formId = "keychain-form-dialog";

  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement | null>(null);

  const { register, handleSubmit, reset, watch, setValue, formState } = useForm<
    KeychainSchemaInput,
    unknown,
    KeychainSchemaValues
  >({
    resolver: zodResolver(keychainSchema),
    defaultValues: {
      id: initialEntry.id ?? "",
      name: initialEntry.name ?? "",
      entry_type: initialEntry.entry_type ?? "password",
      password: initialEntry.password ?? "",
      passphrase: initialEntry.passphrase ?? "",
      private_key: initialEntry.private_key ?? "",
      public_key: initialEntry.public_key ?? "",
    },
  });

  const watchedName = watch("name");
  const watchedType = watch("entry_type");

  const typeOptions = useMemo(
    () =>
      [
        {
          value: "password" as const,
          label: t.keychain.typePassword,
          description: t.keychain.drawer.descriptionPassword,
        },
        {
          value: "ssh_key" as const,
          label: t.keychain.typeSshKey,
          description: t.keychain.drawer.descriptionSshKey,
        },
        {
          value: "secret" as const,
          label: t.keychain.typeSecret,
          description: t.keychain.drawer.descriptionSecret,
        },
      ] satisfies Array<{ value: KeychainEntryType; label: string; description: string }>,
    [
      t.keychain.drawer.descriptionPassword,
      t.keychain.drawer.descriptionSecret,
      t.keychain.drawer.descriptionSshKey,
      t.keychain.typePassword,
      t.keychain.typeSecret,
      t.keychain.typeSshKey,
    ],
  );

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!typeMenuRef.current?.contains(event.target as Node)) {
        setTypeMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTypeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    reset({
      id: initialEntry.id ?? "",
      name: initialEntry.name ?? "",
      entry_type: initialEntry.entry_type ?? "password",
      password: initialEntry.password ?? "",
      passphrase: initialEntry.passphrase ?? "",
      private_key: initialEntry.private_key ?? "",
      public_key: initialEntry.public_key ?? "",
    });
    setTypeMenuOpen(false);
  }, [initialEntry, open, reset]);

  const selectedType = typeOptions.find((option) => option.value === watchedType) ?? typeOptions[0];

  const onSubmit = (values: KeychainSchemaValues) => {
    const entry: KeychainEntry = {
      ...initialEntry,
      id: values.id,
      name: values.name.trim(),
      entry_type: values.entry_type,
      password: values.password.trim() ? values.password : null,
      passphrase: values.passphrase.trim() ? values.passphrase : null,
      private_key: values.private_key.trim() ? values.private_key : null,
      public_key: values.public_key.trim() ? values.public_key : null,
    };
    void saveKeychain(entry);
  };

  return (
    <AppDialog
      open={open}
      onClose={closeKeychainDrawer}
      title={initialEntry.id ? t.keychain.drawer.titleEdit : t.keychain.drawer.titleNew}
      description={t.keychain.drawer.description}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={closeKeychainDrawer}>
            {t.keychain.drawer.cancel}
          </Button>
          <Button type="submit" form={formId} disabled={busy || !watchedName}>
            {t.keychain.drawer.save}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit(onSubmit)}>
        <div className="space-y-3">
          <Input placeholder={t.keychain.drawer.namePlaceholder} {...register("name", { required: true })} />
          {formState.errors.name?.message ? (
            <p className="text-xs text-destructive">{resolveBackendMessage(String(formState.errors.name.message))}</p>
          ) : null}

          <div ref={typeMenuRef} className="relative">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{t.keychain.drawer.typeLabel}</p>
            <button
              type="button"
              className="flex h-10 w-full items-center justify-between rounded border border-border/60 bg-background px-3 text-left text-sm text-foreground"
              onClick={() => setTypeMenuOpen((current) => !current)}
            >
              <span>{selectedType.label}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
            <p className="mt-1 text-xs text-muted-foreground">{selectedType.description}</p>
            {typeMenuOpen ? (
              <div className="absolute z-[240] mt-1 w-full rounded border border-border/70 bg-card p-1 shadow-2xl">
                {typeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="w-full rounded px-2 py-2 text-left hover:bg-secondary"
                    onClick={() => {
                      setValue("entry_type", option.value);
                      setTypeMenuOpen(false);
                    }}
                  >
                    <p className="text-xs font-medium text-foreground">{option.label}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {watchedType === "password" || watchedType === "secret" ? (
            <Input type="password" placeholder={t.keychain.drawer.passwordPlaceholder} {...register("password")} />
          ) : null}

          {watchedType === "ssh_key" || watchedType === "secret" ? (
            <>
              <Textarea className="min-h-[160px]" placeholder={t.keychain.drawer.privateKeyPlaceholder} {...register("private_key")} />
              <Textarea className="min-h-[120px]" placeholder={t.keychain.drawer.publicKeyPlaceholder} {...register("public_key")} />
              <Input type="password" placeholder={t.keychain.drawer.passphrasePlaceholder} {...register("passphrase")} />
            </>
          ) : null}

          {formState.errors.root?.message ? (
            <p className="text-xs text-destructive">{resolveBackendMessage(String(formState.errors.root.message))}</p>
          ) : null}
        </div>
      </form>
    </AppDialog>
  );
}


