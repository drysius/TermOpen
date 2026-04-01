export type SidebarSection = "home" | "keychain" | "known_hosts" | "settings" | "about";

export type WorkTabType = "workspace" | "editor";

export interface WorkTab {
  id: string;
  type: WorkTabType;
  title: string;
  closable: boolean;
  sessionId?: string;
  profileId?: string;
  path?: string;
  initialBlock?: "terminal" | "sftp";
  initialSourceId?: string;
}

export interface WorkspaceSnapshot {
  blocks: unknown[];
  logs: unknown[];
  workspaceMode: "free";
}

export type PaneSource =
  | {
      kind: "local";
      label: string;
    }
  | {
      kind: "session";
      sessionId: string;
      label: string;
    };
