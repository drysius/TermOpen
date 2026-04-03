import type { AppDictionary } from "../types";

export const knownHosts: AppDictionary["knownHosts"] = {
  title: "Known Hosts",
  subtitle: "Verified and trusted hosts.",
  description: "Trusted entries used for host key verification.",
  refresh: "Refresh",
  createFile: "Create file",
  pathLabel: "Path used",
  pathDefault: "(system default)",
  headerHost: "Host",
  headerAlgorithm: "Algorithm",
  headerFingerprint: "Fingerprint",
  headerStatus: "Status",
  headerType: "Type",
  headerActions: "Actions",
  removeTooltip: "Remove host",
  empty: "No known hosts.",
};
