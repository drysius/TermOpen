import type { AppDictionary } from "../types";

export const conflicts: AppDictionary["conflicts"] = {
  title: "Conflitos de Sincronização",
  description:
    "Foram detectadas diferenças entre cliente e servidor. Escolha qual lado manter para cada item.",
  applying: "Aplicando...",
  applyButton: "Aplicar Resolução",
  keepClient: "Manter Cliente",
  keepServer: "Manter Servidor",
  local: "Local",
  server: "Servidor",
  absent: "ausente",
};
