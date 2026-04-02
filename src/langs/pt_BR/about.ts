import type { AppDictionary } from "../types";

export const about: AppDictionary["about"] = {
  title: "Sobre o TermOpen",
  description:
    "Painel de terminal focado em gerenciamento confiavel de conexoes e dados sensiveis.",
  projectSection: "Projeto",
  projectVisionSection: "Como o TermOpen funciona",
  projectVisionP1:
    "O TermOpen e um painel de terminal que permite usar protocolos SSH e SFTP, como outros aplicativos do tipo, com foco em organizacao e confianca.",
  projectVisionP2:
    "Uma das ideias centrais e permitir que voce guarde informacoes de conexoes no seu proprio Google Drive, sem depender de servidores externos para armazenar dados sensiveis de conexao e keychain.",
  projectVisionP3:
    "O servidor usado no auth do Google Drive existe para proteger as chaves privadas do projeto Google dos desenvolvedores e viabilizar a obtencao do access token. Com isso, o TermOpen consegue enviar os arquivos do vault como cloud save e recuperar seus dados em qualquer plataforma suportada, sem backend de armazenamento dedicado.",
  repoLabel: "Repositorio oficial: ",
  versionLabel: "Versao do app: ",
  updatesInfo: "Atualizacoes: verifique releases e commits no GitHub.",
  stackSection: "Stack e Bibliotecas",
  newPackagesSection: "Pacotes recentes",
  newPackagesDescription: "Inclui novas integracoes para HTTP e Deep Link nativos no Tauri.",
  licensesSection: "Licencas",
  licensesDescription: "SMB (`smb-rs`) usa licenca MIT. FTP/FTPS (`suppaftp`) usa licenciamento duplo MIT OR Apache-2.0.",
};
