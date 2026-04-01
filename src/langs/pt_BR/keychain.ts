import type { AppDictionary } from "../types";

export const keychain: AppDictionary["keychain"] = {
  title: "Keychain",
  newKey: "Nova Chave",
  edit: "Editar",
  remove: "Remover",
  privateKey: "Chave Privada",
  publicKey: "Chave Publica",
  passphrase: "Passphrase",
  drawer: {
    titleEdit: "Editar Keychain",
    titleNew: "Nova Keychain",
    description: "Chave privada e publica opcionais",
    namePlaceholder: "Nome",
    passphrasePlaceholder: "Passphrase (opcional)",
    privateKeyPlaceholder: "Chave privada (opcional)",
    publicKeyPlaceholder: "Chave publica (opcional)",
    cancel: "Cancelar",
    save: "Salvar",
  },
};
