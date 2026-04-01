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
  header: {
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    login: "Sign in",
    syncNow: "Sync now",
    loginServerTitle: "Select login server",
    loginServerDescription: "Choose which authentication server should be used before continuing.",
    loginServerLoading: "Loading servers...",
    loginServerEmpty: "No servers available for login.",
    loginServerRecommended: "Recommended",
    loginServerOffline: "offline",
    loginServerUnknownMs: "no ms",
    loginServerAction: "Sign in",
    loginServerRefresh: "Refresh list",
    hello: "Hello",
    guest: "user",
    syncing: "Syncing...",
    stageUploading: "Uploading files",
    stageDownloading: "Downloading files",
    stageCleaningRemote: "Cleaning remote",
    stageComplete: "Completed",
  },
};
