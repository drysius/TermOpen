import type { AppDictionary } from "../types";

export const app: AppDictionary["app"] = {
  name: "TermOpen",
  boot: {
    starting: "Starting TermOpen...",
    checkingUpdates: "Checking for updates...",
    loadingData: "Loading local data...",
  },
  sync: {
    autoRunning: "Automatic sync in progress...",
    autoFailed: "Automatic sync failed.",
  },
};
