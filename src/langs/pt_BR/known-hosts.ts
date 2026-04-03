import type { AppDictionary } from "../types";

export const knownHosts: AppDictionary["knownHosts"] = {
  title: "Known Hosts",
  subtitle: "Hosts verificados e confiáveis.",
  description: "Entradas confiáveis usadas na verificação de host key.",
  refresh: "Atualizar",
  createFile: "Criar arquivo",
  pathLabel: "Caminho usado",
  pathDefault: "(padrão do sistema)",
  headerHost: "Host",
  headerAlgorithm: "Algoritmo",
  headerFingerprint: "Fingerprint",
  headerStatus: "Status",
  headerType: "Tipo",
  headerActions: "Ações",
  removeTooltip: "Remover host",
  empty: "Nenhum host conhecido.",
};
