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
};
