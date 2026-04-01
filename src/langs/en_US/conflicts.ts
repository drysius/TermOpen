import type { AppDictionary } from "../types";

export const conflicts: AppDictionary["conflicts"] = {
  title: "Sync Conflicts",
  description:
    "Differences were detected between client and server. Choose which side to keep for each item.",
  applying: "Applying...",
  applyButton: "Apply Resolution",
  keepClient: "Keep Client",
  keepServer: "Keep Server",
  local: "Local",
  server: "Server",
  absent: "absent",
};
