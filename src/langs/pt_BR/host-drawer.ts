import type { AppDictionary } from "../types";

export const hostDrawer: AppDictionary["hostDrawer"] = {
  titleEdit: "Editar Conexao",
  titleNew: "Nova Conexao",
  description: "Defina identificacao, protocolos e credenciais da conexao.",
  name: {
    label: "Nome",
    description: "Nome exibido nos cards e tabs do workspace.",
    placeholder: "Ex: Producao - API",
  },
  host: {
    label: "Host/IP",
    description: "Endereco DNS ou IP da maquina remota.",
    placeholder: "Ex: 123.123.123.123",
  },
  port: {
    label: "Porta",
    description: "Porta do servidor SSH/SFTP (normalmente 22).",
    placeholder: "22",
  },
  username: {
    label: "Usuario",
    description: "Usuario usado para autenticar no servidor.",
    placeholder: "root",
  },
  remotePath: {
    label: "Path Remoto Inicial",
    description: "Diretorio inicial ao abrir bloco SFTP.",
    placeholder: "/var/www/app",
  },
  protocols: {
    label: "Protocolos",
    description: "Selecione quais recursos esse host podera abrir no app.",
    placeholder: "Selecione",
    sshDescription: "Abre blocos de terminal remoto no workspace.",
    sftpDescription: "Abre explorador de arquivos remoto e transferencias.",
    ftpDescription: "Abre explorador e transferencias remotas via FTP.",
    ftpsDescription: "Abre explorador e transferencias remotas via FTPS (TLS).",
    smbDescription: "Abre compartilhamentos SMB para navegar e transferir arquivos.",
    rdpDescription: "Abre acesso remoto de desktop (RDP) no workspace.",
  },
  password: {
    label: "Senha",
    description: "Opcional. Usada quando nao houver chave privada.",
    placeholder: "Senha (opcional)",
  },
  keychainField: {
    label: "Keychain",
    description: "Selecione uma entrada para preencher senha/chaves automaticamente.",
    none: "Sem keychain",
  },
  privateKey: {
    label: "Chave Privada",
    description: "Opcional. Voce pode colar a chave ou selecionar arquivo local (conteudo salvo no vault).",
    selectFile: "Selecionar arquivo",
    noFile: "Nenhum arquivo selecionado",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
  },
  cancel: "Cancelar",
  save: "Salvar",
};
