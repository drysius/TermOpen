import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "Sobre o TermOpen",
  description:
    "Gerenciador desktop de SSH/SFTP com workspace em blocos, vault criptografado e sincronizacao de perfil.",
  projectSection: "Projeto",
  repoLabel: "Repositorio oficial: ",
  versionLabel: "Versao do app: ",
  updatesInfo: "Atualizacoes: verifique releases e commits no GitHub.",
  stackSection: "Stack e Bibliotecas",
  newPackagesSection: "Pacotes recentes",
  newPackagesDescription: "Inclui novas integracoes para HTTP e Deep Link nativos no Tauri.",
  syncSection: "Google Sync",
  syncDescription: "O sync usa OAuth Device Flow com escopo `drive.file`.",
  syncConfig:
    "Configure no ambiente: `TERMOPEN_GOOGLE_CLIENT_ID` e, se necessario, `TERMOPEN_GOOGLE_CLIENT_SECRET`.",
};
