import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { AppDrawer } from "@/components/ui/app-drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { KeychainEntry, KeychainEntryType } from "@/types/openptl";

interface KeychainFormValues {
  id: string;
  name: string;
  entry_type: KeychainEntryType;
  password: string;
  passphrase: string;
  private_key: string;
  public_key: string;
}

export function KeychainFormDrawer() {
  const t = useT();
  const open = useAppStore((state) => state.keychainDrawerOpen);
  const initialEntry = useAppStore((state) => state.keychainDraft);
  const busy = useAppStore((state) => state.busy);
  const closeKeychainDrawer = useAppStore((state) => state.closeKeychainDrawer);
  const saveKeychain = useAppStore((state) => state.saveKeychain);

  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement | null>(null);

  const { register, handleSubmit, reset, watch, setValue } = useForm<KeychainFormValues>({
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
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
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

  const onSubmit = (values: KeychainFormValues) => {
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
    <AppDrawer
      open={open}
      onClose={closeKeychainDrawer}
      title={initialEntry.id ? t.keychain.drawer.titleEdit : t.keychain.drawer.titleNew}
      description={t.keychain.drawer.description}
      widthClassName="w-[560px]"
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="space-y-3">
          <Input placeholder={t.keychain.drawer.namePlaceholder} {...register("name", { required: true })} />

          <div ref={typeMenuRef} className="relative">
            <p className="mb-1 text-xs font-medium text-zinc-300">{t.keychain.drawer.typeLabel}</p>
            <button
              type="button"
              className="flex h-10 w-full items-center justify-between rounded border border-white/15 bg-zinc-950 px-3 text-left text-sm text-zinc-100"
              onClick={() => setTypeMenuOpen((current) => !current)}
            >
              <span>{selectedType.label}</span>
              <ChevronDown className="h-4 w-4 text-zinc-400" />
            </button>
            <p className="mt-1 text-xs text-zinc-500">{selectedType.description}</p>
            {typeMenuOpen ? (
              <div className="absolute z-[240] mt-1 w-full rounded border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                {typeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="w-full rounded px-2 py-2 text-left hover:bg-zinc-900"
                    onClick={() => {
                      setValue("entry_type", option.value);
                      setTypeMenuOpen(false);
                    }}
                  >
                    <p className="text-xs font-medium text-zinc-100">{option.label}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">{option.description}</p>
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
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-white/10 pt-4">
          <Button type="button" variant="outline" onClick={closeKeychainDrawer}>
            {t.keychain.drawer.cancel}
          </Button>
          <Button type="submit" disabled={busy || !watchedName}>
            {t.keychain.drawer.save}
          </Button>
        </div>
      </form>
    </AppDrawer>
  );
}


