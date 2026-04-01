import type { AppDictionary } from "../types";

export const knownHosts: AppDictionary["knownHosts"] = {
  title: "Known Hosts",
  description: "Trusted entries used for host key verification.",
  refresh: "Refresh",
  createFile: "Create file",
  pathLabel: "Path used",
  pathDefault: "(system default)",
  headerType: "Type",
  headerActions: "Actions",
  removeTooltip: "Remove",
  empty: "No known entries.",
};
