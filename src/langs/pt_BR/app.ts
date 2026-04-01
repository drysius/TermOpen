import type { AppDictionary } from "../types";

export const app: AppDictionary["app"] = {
  name: "TermOpen",
  boot: {
    starting: "Iniciando TermOpen...",
    checkingUpdates: "Verificando atualizacoes...",
    loadingData: "Carregando dados locais...",
  },
  sync: {
    autoRunning: "Sincronizacao automatica em andamento...",
    autoFailed: "Falha na sincronizacao automatica.",
  },
  header: {
    statusConnected: "Conectado",
    statusDisconnected: "Desconectado",
    login: "Fazer login",
    syncNow: "Sincronizar agora",
    hello: "Ola",
    guest: "usuario",
    syncing: "Sincronizando...",
    stageUploading: "Enviando arquivos",
    stageDownloading: "Baixando arquivos",
    stageCleaningRemote: "Limpando remoto",
    stageComplete: "Concluido",
  },
};
