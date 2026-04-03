import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "Sobre o ConnectHub",
  description: "Gerenciador de conexões remotas seguro e moderno.",
  protocolsLabel: "Protocolos",
  frameworkLabel: "Framework",
  licenseLabel: "Licença",
  githubButton: "GitHub",
  docsButton: "Ver site",
  dependenciesButton: "Ver Dependências",
  dependenciesTitle: "Dependências do projeto",
  dependenciesDescription: "Pacotes do frontend e backend (Rust) usados no ConnectHub.",
  dependenciesIntro: "Este projeto não seria possível sem os pacotes abaixo.",
  frontendPackagesTitle: "Pacotes do frontend",
  backendPackagesTitle: "Pacotes do backend (Rust)",
  projectSection: "Projeto",
  projectVisionSection: "Como o ConnectHub funciona",
  projectVisionP1:
    "O ConnectHub é um painel desktop para conexões remotas com foco em produtividade e confiabilidade.",
  projectVisionP2:
    "Os dados de conexão e keychain permanecem no vault local criptografado, com opção de sincronização no Google Drive.",
  projectVisionP3:
    "A sincronização utiliza autenticação OAuth e mantém compatibilidade de perfis, sessões e workspaces entre plataformas.",
  repoLabel: "Repositório oficial:",
  versionLabel: "Versão do app",
  updatesInfo: "Atualizações: verifique releases e commits no GitHub.",
  stackSection: "Stack e bibliotecas",
  newPackagesSection: "Pacotes recentes",
  newPackagesDescription: "Inclui integrações modernas de UI, HTTP e Deep Link no Tauri.",
  licensesSection: "Licenças",
  licensesDescription: "SMB (`smb-rs`) usa licença MIT. FTP/FTPS (`suppaftp`) usa licenciamento MIT OR Apache-2.0.",
};
