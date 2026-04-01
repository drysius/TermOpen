import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "About TermOpen",
  description:
    "Desktop SSH/SFTP manager with block-based workspace, encrypted vault and profile sync.",
  projectSection: "Project",
  repoLabel: "Official repository: ",
  versionLabel: "App version: ",
  updatesInfo: "Updates: check releases and commits on GitHub.",
  stackSection: "Stack & Libraries",
  syncSection: "Google Sync",
  syncDescription: "Sync uses OAuth Device Flow with `drive.file` scope.",
  syncConfig:
    "Configure in environment: `TERMOPEN_GOOGLE_CLIENT_ID` and, if needed, `TERMOPEN_GOOGLE_CLIENT_SECRET`.",
};
