import type { AppDictionary } from "../types";

export const workspace: AppDictionary["workspace"] = {
  modeFree: "Free",
  modeGrid: "Grid",
  addBlock: "New Block",
  newBlockTitle: "New Block",
  newBlockDescription: "Choose which block to open in this workspace.",
  blockSftp: "SFTP Block",
  blockTerminal: "Terminal Block",
  transfer: "transfer(s)",
  transferFolder: "Folder transfer is still in rollout. Move files for now.",
  transferSuccess: "Transferred to {destination}",
  closeTitle: "Close workspace",
  closeMessage: 'Do you really want to close "{title}"? This will end associated sessions.',
  closing: "Closing...",
  closeConfirm: "Close Workspace",
};
