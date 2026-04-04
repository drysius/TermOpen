import type { AppDictionary } from "../types";

export const toasts: AppDictionary["toasts"] = {
  connectionSaved: "Conexão salva.",
  connectionRemoved: "Conexão removida.",
  keychainSaved: "Keychain salva.",
  keychainRemoved: "Entrada removida.",
  settingsSaved: "Configurações salvas.",
  enterNewPassword: "Informe a nova senha.",
  passwordMismatch: "A confirmação da senha nova não confere.",
  passwordUpdated: "Senha mestre atualizada.",
  sessionDisconnected: "Sessão {sessionId} desconectada.",
  sessionReconnecting: "Sessão desconectada. Tentando reconectar em {seconds}s...",
  sessionReconnected: "Sessão reconectada automaticamente.",
  unknownHostConfirm:
    "Host desconhecido: {host}:{port}\n{keyType} {fingerprint}\n\nDeseja confiar neste host e conectar?",
  connectionCancelledHost: "Conexão cancelada pelo usuário (host desconhecido).",
  passwordPrompt: "{message}\n\nDigite a senha para tentar novamente:",
  connectionCancelledPassword: "Conexão cancelada: senha não informada.",
  savePasswordConfirm: "Deseja salvar a senha neste perfil?",
  connectionFailed: "Não foi possível conectar a sessão SSH.",
  selectSourceFile: "Selecione um arquivo de origem.",
  fileCopied: "Arquivo copiado para {targetFile}",
  textOnlyEditor: "Somente arquivos texto podem ser salvos no editor interno.",
  fileSaved: "Arquivo salvo.",
  mediaCantExport: "Preview de mídia/binário não exporta para editor externo por texto.",
  fileTooLarge: "Arquivo muito grande para preview ({size} > {limit}).",
  knownHostRemoved: "Known host removido.",
};
