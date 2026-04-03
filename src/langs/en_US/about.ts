import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "About ConnectHub",
  description: "A modern and secure remote connection manager.",
  protocolsLabel: "Protocols",
  frameworkLabel: "Framework",
  licenseLabel: "License",
  githubButton: "GitHub",
  docsButton: "View site",
  dependenciesButton: "View Dependencies",
  dependenciesTitle: "Project dependencies",
  dependenciesDescription: "Backend (Rust) and frontend packages used in ConnectHub.",
  dependenciesIntro: "This project would not be possible without the packages below.",
  frontendPackagesTitle: "Frontend packages",
  backendPackagesTitle: "Backend packages (Rust)",
  projectSection: "Project",
  projectVisionSection: "How ConnectHub works",
  projectVisionP1:
    "ConnectHub is a desktop panel for remote connections with a strong focus on productivity and reliability.",
  projectVisionP2:
    "Connection and keychain data remain in an encrypted local vault, with optional Google Drive synchronization.",
  projectVisionP3:
    "Sync uses OAuth authentication and preserves profile, session and workspace compatibility across platforms.",
  repoLabel: "Official repository:",
  versionLabel: "App version",
  updatesInfo: "Updates: check releases and commits on GitHub.",
  stackSection: "Stack and libraries",
  newPackagesSection: "Recent packages",
  newPackagesDescription: "Includes modern UI, HTTP and native Deep Link integrations in Tauri.",
  licensesSection: "Licenses",
  licensesDescription: "SMB (`smb-rs`) is MIT. FTP/FTPS (`suppaftp`) is dual-licensed MIT OR Apache-2.0.",
};
