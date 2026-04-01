import { useEffect } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/langs";
import { useAppStore } from "@/store/app-store";
import type { KeychainEntry } from "@/types/termopen";

interface KeychainFormValues {
  id: string;
  name: string;
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

  const { register, handleSubmit, reset, watch } = useForm<KeychainFormValues>({
    defaultValues: {
      id: initialEntry.id ?? "",
      name: initialEntry.name ?? "",
      passphrase: initialEntry.passphrase ?? "",
      private_key: initialEntry.private_key ?? "",
      public_key: initialEntry.public_key ?? "",
    },
  });

  const watchedName = watch("name");

  useEffect(() => {
    reset({
      id: initialEntry.id ?? "",
      name: initialEntry.name ?? "",
      passphrase: initialEntry.passphrase ?? "",
      private_key: initialEntry.private_key ?? "",
      public_key: initialEntry.public_key ?? "",
    });
  }, [initialEntry, open, reset]);

  const onSubmit = (values: KeychainFormValues) => {
    const entry: KeychainEntry = {
      ...initialEntry,
      id: values.id,
      name: values.name.trim(),
      passphrase: values.passphrase.trim() ? values.passphrase : null,
      private_key: values.private_key.trim() ? values.private_key : null,
      public_key: values.public_key.trim() ? values.public_key : null,
    };
    void saveKeychain(entry);
  };

  return (
    <Drawer
      open={open}
      onClose={closeKeychainDrawer}
      title={initialEntry.id ? t.keychain.drawer.titleEdit : t.keychain.drawer.titleNew}
      description={t.keychain.drawer.description}
      widthClassName="w-[560px]"
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="space-y-2">
          <Input placeholder={t.keychain.drawer.namePlaceholder} {...register("name", { required: true })} />
          <Input type="password" placeholder={t.keychain.drawer.passphrasePlaceholder} {...register("passphrase")} />
          <Textarea className="min-h-[160px]" placeholder={t.keychain.drawer.privateKeyPlaceholder} {...register("private_key")} />
          <Textarea className="min-h-[120px]" placeholder={t.keychain.drawer.publicKeyPlaceholder} {...register("public_key")} />
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
    </Drawer>
  );
}
