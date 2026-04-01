import type { AppDictionary } from "../types";

export const conflicts: AppDictionary["conflicts"] = {
  title: "Conflitos de Sincronizacao",
  description:
    "Foram detectadas diferencas entre cliente e servidor. Escolha qual lado manter para cada item.",
  applying: "Aplicando...",
  applyButton: "Aplicar Resolucao",
  keepClient: "Manter Cliente",
  keepServer: "Manter Servidor",
  local: "Local",
  server: "Servidor",
  absent: "ausente",
};
