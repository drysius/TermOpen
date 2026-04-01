import type { AppDictionary } from "../types";

export const toasts: AppDictionary["toasts"] = {
  connectionSaved: "Conexao salva.",
  connectionRemoved: "Conexao removida.",
  keychainSaved: "Keychain salva.",
  keychainRemoved: "Entrada removida.",
  settingsSaved: "Configuracoes salvas.",
  enterNewPassword: "Informe a nova senha.",
  passwordMismatch: "A confirmacao da senha nova nao confere.",
  passwordUpdated: "Senha mestre atualizada.",
  sessionDisconnected: "Sessao {sessionId} desconectada.",
  sessionReconnecting: "Sessao desconectada. Tentando reconectar em {seconds}s...",
  sessionReconnected: "Sessao reconectada automaticamente.",
  unknownHostConfirm:
    "Host desconhecido: {host}:{port}\n{keyType} {fingerprint}\n\nDeseja confiar neste host e conectar?",
  connectionCancelledHost: "Conexao cancelada pelo usuario (host desconhecido).",
  passwordPrompt: "{message}\n\nDigite a senha para tentar novamente:",
  connectionCancelledPassword: "Conexao cancelada: senha nao informada.",
  savePasswordConfirm: "Deseja salvar a senha neste perfil?",
  connectionFailed: "Nao foi possivel conectar a sessao SSH.",
  selectSourceFile: "Selecione um arquivo de origem.",
  fileCopied: "Arquivo copiado para {targetFile}",
  textOnlyEditor: "Somente arquivos texto podem ser salvos no editor interno.",
  fileSaved: "Arquivo salvo.",
  mediaCantExport: "Preview de midia/binario nao exporta para editor externo por texto.",
  fileTooLarge: "Arquivo muito grande para preview ({size} > {limit}).",
};
