import type { AppDictionary } from "../types";

export const home: AppDictionary["home"] = {
  hosts: {
    title: "Hosts",
    newHost: "New Host",
    emptyTitle: "No SSH hosts registered",
    emptyDescription: "Create a host to open terminals and start your workspace.",
    addButton: "Add SSH Host",
    clickToOpen: "Click to open SSH terminal.",
    edit: "Edit",
    remove: "Remove",
  },
  sftp: {
    title: "SFTP",
    newSftp: "New SFTP",
    emptyTitle: "No SFTP hosts registered",
    emptyDescription: "Add an SFTP profile to browse and move remote files.",
    addButton: "Add SFTP Host",
    clickToOpen: "Click to open SFTP workspace.",
    edit: "Edit",
    remove: "Remove",
  },
};
