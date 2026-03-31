# TermOpen Agent App Guide

## Objetivo do App
- O TermOpen e um desktop app para operacao SSH/SFTP com vault criptografado.
- O vault guarda conexoes, keychain local, configuracoes e metadados de sync.
- O app combina:
  - terminal SSH interativo,
  - explorador SFTP/local com transferencia,
  - editor interno (Monaco + preview de midia),
  - sincronizacao criptografada com Google Drive via servidor de auth.

## Mapa de Arquitetura por Fluxo

### 1) Vault e Configuracoes
- Backend:
  - `src-tauri/src/vault.rs`: leitura, persistencia e regras de saneamento.
  - `src-tauri/src/models.rs`: tipos de dominio (inclui `AppSettings`).
- Frontend:
  - `src/functions/vault-actions.ts`: bootstrap, lock/unlock, carga de workspace.
  - `src/pages/vault-gate-page.tsx`: UX de inicializacao/desbloqueio.
  - `src/pages/sections/settings-page.tsx`: formulario de settings.

### 2) Conexoes e SSH
- Backend:
  - `src-tauri/src/ssh.rs`: handshake SSH, autenticacao, PTY, known_hosts.
  - `src-tauri/src/lib.rs`: comandos Tauri (`ssh_*`, `known_hosts_*`).
- Frontend:
  - `src/functions/session-actions.ts`: ciclo de sessao, listeners e reconnect.
  - `src/pages/tabs/sftp-workspace-tab-page.tsx`: blocos de terminal.

### 3) SFTP e Transferencias
- Backend:
  - `src-tauri/src/ssh.rs`: list/read/write SFTP em chunks.
  - `src-tauri/src/lib.rs`: `sftp_transfer` com progresso por evento.
- Frontend:
  - `src/functions/sftp-editor-actions.ts`: abrir/copiar/salvar via store.
  - `src/pages/tabs/sftp-workspace-tab-page.tsx`: explorador e drag-and-drop.

### 4) Editor Interno
- Frontend:
  - `src/pages/tabs/editor-tab-page.tsx`: editor por aba.
  - `src/pages/tabs/sftp-workspace-tab-page.tsx`: editor em bloco.
  - `src/functions/editor-file-utils.ts`: deteccao de tipo de arquivo e linguagem.
  - `src/functions/sftp-editor-actions.ts`: orquestracao para leitura/salvamento.
- Backend:
  - `src-tauri/src/lib.rs`: comandos de preview binario/base64 para midia.

### 5) Sync Google Drive e Auth
- Backend:
  - `src-tauri/src/sync.rs`: login OAuth, push/pull e conflitos.
  - `src-tauri/src/lib.rs`: comandos `sync_*` e lista de auth servers.
  - `server/src/index.js`: broker OAuth.
- Deeplink:
  - `src-tauri/src/deeplink/*`: registro e captura de `termopen://auth`.

### 6) Janela Custom (Titlebar)
- Frontend:
  - `src/components/layout/app-header.tsx`: header com drag region e controles.
  - `src/App.tsx`: alterna modo normal e modo bloqueado (header simplificado).
- Backend:
  - `src-tauri/src/lib.rs`: comandos `window_minimize`, `window_toggle_maximize`, `window_close`.

## Leitura Minima por Tarefa (evitar leitura desnecessaria)

### Ajustar comportamento de settings
1. `src/types/termopen.ts`
2. `src-tauri/src/models.rs`
3. `src-tauri/src/vault.rs`
4. `src/pages/sections/settings-page.tsx`

### Ajustar SFTP/transferencia
1. `src-tauri/src/ssh.rs`
2. `src-tauri/src/lib.rs` (comandos `sftp_*`)
3. `src/pages/tabs/sftp-workspace-tab-page.tsx` (progresso/eventos)

### Ajustar editor e preview
1. `src/functions/editor-file-utils.ts`
2. `src/functions/sftp-editor-actions.ts`
3. `src/pages/tabs/editor-tab-page.tsx`
4. `src/pages/tabs/sftp-workspace-tab-page.tsx`

### Ajustar lock screen e header
1. `src/App.tsx`
2. `src/components/layout/app-header.tsx`
3. `src/pages/vault-gate-page.tsx`

### Ajustar auth/deeplink
1. `src-tauri/src/sync.rs`
2. `src-tauri/src/deeplink/mod.rs`
3. `src-tauri/src/deeplink/windows.rs`
4. `server/src/index.js`

## Pontos de Entrada Oficiais para Diagnostico
- Startup app: `src/App.tsx` + `src/functions/vault-actions.ts`.
- Comandos Tauri expostos: `src-tauri/src/lib.rs` (`invoke_handler`).
- Erros de SSH/SFTP: `src-tauri/src/ssh.rs`.
- Erros de sync/auth: `src-tauri/src/sync.rs` e `server/src/index.js`.
- Estado global frontend: `src/store/app-store.ts` e `src/store/app-store.types.ts`.

## Relacao com Outros AGENT Docs
- `docs/AGENT_ARCHITECTURE.md`:
  - foco em organizacao de frontend/store e regras de evolucao da UI.
- `docs/AGENT_DEEPLINK.md`:
  - foco em protocolo `termopen://auth` e fluxo OAuth via deeplink.
- Este `docs/AGENT_APP.md`:
  - visao geral do produto + leitura minima por contexto.
