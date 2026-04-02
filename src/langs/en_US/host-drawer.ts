import type { AppDictionary } from "../types";

export const hostDrawer: AppDictionary["hostDrawer"] = {
  titleEdit: "Edit Connection",
  titleNew: "New Connection",
  description: "Set identification, protocols and credentials for the connection.",
  name: {
    label: "Name",
    description: "Name displayed on cards and workspace tabs.",
    placeholder: "e.g.: Production - API",
  },
  host: {
    label: "Host/IP",
    description: "DNS address or IP of the remote machine.",
    placeholder: "e.g.: 123.123.123.123",
  },
  port: {
    label: "Port",
    description: "SSH/SFTP server port (usually 22).",
    placeholder: "22",
  },
  username: {
    label: "Username",
    description: "Username used to authenticate on the server.",
    placeholder: "root",
  },
  remotePath: {
    label: "Initial Remote Path",
    description: "Initial directory when opening an SFTP block.",
    placeholder: "/var/www/app",
  },
  protocols: {
    label: "Protocols",
    description: "Select which features this host can open in the app.",
    placeholder: "Select",
    sshDescription: "Opens remote terminal blocks in the workspace.",
    sftpDescription: "Opens remote file explorer and transfers.",
    ftpDescription: "Opens plain FTP remote file explorer and transfers.",
    ftpsDescription: "Opens FTP over TLS (FTPS) explorer and transfers.",
    smbDescription: "Opens SMB shares for remote file browsing and transfers.",
    rdpDescription: "Opens remote desktop access (RDP) in the workspace.",
  },
  password: {
    label: "Password",
    description: "Optional. Used when no private key is available.",
    placeholder: "Password (optional)",
  },
  keychainField: {
    label: "Keychain",
    description: "Select an entry to auto-fill password/keys.",
    none: "No keychain",
  },
  privateKey: {
    label: "Private Key",
    description: "Optional. You can paste the key or select a local file (content saved in vault).",
    selectFile: "Select file",
    noFile: "No file selected",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
  },
  cancel: "Cancel",
  save: "Save",
};
