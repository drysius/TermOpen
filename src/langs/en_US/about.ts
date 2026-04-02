import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "About TermOpen",
  description:
    "Terminal panel focused on reliable connection management and sensitive-data safety.",
  projectSection: "Project",
  projectVisionSection: "How TermOpen works",
  projectVisionP1:
    "TermOpen is a terminal panel for SSH and SFTP workflows, similar to other tools in this category, with emphasis on organization and trust.",
  projectVisionP2:
    "A core idea is letting users keep connection data in their own Google Drive, without relying on third-party storage backends for sensitive connection/keychain information.",
  projectVisionP3:
    "The Google auth server is used to protect developer-side Google Project private credentials and enable access token issuance. TermOpen then uploads vault files as cloud save and restores them across supported platforms, without a dedicated data-storage server.",
  repoLabel: "Official repository: ",
  versionLabel: "App version: ",
  updatesInfo: "Updates: check releases and commits on GitHub.",
  stackSection: "Stack & Libraries",
  newPackagesSection: "Recent packages",
  newPackagesDescription: "Includes new integrations for native Tauri HTTP and Deep Link.",
  licensesSection: "Licenses",
  licensesDescription: "SMB (`smb-rs`) is MIT. FTP/FTPS (`suppaftp`) is dual-licensed MIT OR Apache-2.0.",
};
