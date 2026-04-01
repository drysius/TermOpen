import type { AppDictionary } from "../types";

export const toasts: AppDictionary["toasts"] = {
  connectionSaved: "Connection saved.",
  connectionRemoved: "Connection removed.",
  keychainSaved: "Keychain saved.",
  keychainRemoved: "Entry removed.",
  settingsSaved: "Settings saved.",
  enterNewPassword: "Enter the new password.",
  passwordMismatch: "New password confirmation does not match.",
  passwordUpdated: "Master password updated.",
  sessionDisconnected: "Session {sessionId} disconnected.",
  sessionReconnecting: "Session disconnected. Reconnecting in {seconds}s...",
  sessionReconnected: "Session reconnected automatically.",
  unknownHostConfirm:
    "Unknown host: {host}:{port}\n{keyType} {fingerprint}\n\nDo you want to trust this host and connect?",
  connectionCancelledHost: "Connection cancelled by user (unknown host).",
  passwordPrompt: "{message}\n\nEnter the password to try again:",
  connectionCancelledPassword: "Connection cancelled: password not provided.",
  savePasswordConfirm: "Save the password in this profile?",
  connectionFailed: "Could not connect to SSH session.",
  selectSourceFile: "Select a source file.",
  fileCopied: "File copied to {targetFile}",
  textOnlyEditor: "Only text files can be saved in the internal editor.",
  fileSaved: "File saved.",
  mediaCantExport: "Media/binary preview cannot be exported to external editor as text.",
  fileTooLarge: "File too large for preview ({size} > {limit}).",
  knownHostRemoved: "Known host removed.",
};
