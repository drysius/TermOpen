import type { AppDictionary } from "../types";

export const keychain: AppDictionary["keychain"] = {
  title: "Keychain",
  newKey: "New Key",
  edit: "Edit",
  remove: "Remove",
  privateKey: "Private Key",
  publicKey: "Public Key",
  passphrase: "Passphrase",
  drawer: {
    titleEdit: "Edit Keychain",
    titleNew: "New Keychain",
    description: "Private and public keys are optional",
    namePlaceholder: "Name",
    passphrasePlaceholder: "Passphrase (optional)",
    privateKeyPlaceholder: "Private key (optional)",
    publicKeyPlaceholder: "Public key (optional)",
    cancel: "Cancel",
    save: "Save",
  },
};
