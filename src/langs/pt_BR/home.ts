import type { AppDictionary } from "../types";

export const home: AppDictionary["home"] = {
  hosts: {
    title: "Hosts",
    newHost: "Novo Host",
    emptyTitle: "Nenhum host SSH cadastrado",
    emptyDescription: "Crie um host para abrir terminais e comecar seu workspace.",
    addButton: "Adicionar Host SSH",
    clickToOpen: "Clique para abrir terminal SSH.",
    edit: "Editar",
    remove: "Remover",
  },
  sftp: {
    title: "SFTP",
    newSftp: "Novo SFTP",
    emptyTitle: "Nenhum host SFTP cadastrado",
    emptyDescription: "Adicione um perfil SFTP para navegar e mover arquivos remotos.",
    addButton: "Adicionar Host SFTP",
    clickToOpen: "Clique para abrir workspace SFTP.",
    edit: "Editar",
    remove: "Remover",
  },
};
