export interface WorkspaceBlockNotFoundContext {
  blockId: string;
  action: string;
}

export interface WorkspaceBlockFailureContext {
  blockId: string;
  action: string;
  error: unknown;
}

export interface WorkspaceBlockDropdownContext {
  blockId: string;
  action: string;
  value: string;
}

export interface WorkspaceBlockStatusContext {
  blockId: string;
  action: string;
  status: string;
}

export interface WorkspaceBlockModule<TProps> {
  name: string;
  description: string;
  render: (props: TProps) => ReactNode;
  onNotFound?: (context: WorkspaceBlockNotFoundContext) => string;
  onFailureLoad?: (context: WorkspaceBlockFailureContext) => string;
  onDropDownSelect?: (context: WorkspaceBlockDropdownContext) => string | void;
  onStatusChange?: (context: WorkspaceBlockStatusContext) => string | void;
}
import type { ReactNode } from "react";
