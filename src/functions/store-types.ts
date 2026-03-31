import type { AppStore } from "@/store/app-store.types";

export type StoreSet = (
  partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>),
) => void;

export type StoreGet = () => AppStore;

