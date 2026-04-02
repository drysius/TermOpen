# AGENTS

## Product Summary
TermOpen is a desktop SSH/SFTP workspace (Tauri + React) with:
- encrypted vault state,
- SSH terminal blocks (xterm),
- SFTP explorer/editor blocks,
- profile sync with Google Drive,
- custom desktop shell (header/sidebar/tabs/workspaces).

## Core Runtime Map
Frontend (React/TS):
- `src/App.tsx`: shell, routing, tabs/workspaces mount, startup/lifecycle dialogs.
- `src/store/*`: Zustand app store (actions + state).
- `src/pages/tabs/sftp-workspace-tab-page.tsx`: block workspace orchestration (terminal/sftp/editor/logs).
- `src/components/layout/*`: header/sidebar/work tabs.
- `src/components/drawers/*`: host/keychain forms.

Backend (Rust/Tauri):
- `src-tauri/src/lib.rs`: tauri commands and app setup.
- `src-tauri/src/ssh.rs`: SSH/SFTP session handling + local terminal process.
- `src-tauri/src/sync.rs`: OAuth/sync/conflict and recovery flow.
- `src-tauri/src/vault.rs`: encrypted persistence and profile payload.
- `src-tauri/src/models.rs`: shared persisted/public models.

## Base Logic
1) Vault bootstrap/unlock
- app starts, vault status is loaded,
- if unlocked, workspace/session state is hydrated.

2) Session model
- remote SSH sessions and local terminal sessions are managed in backend,
- frontend subscribes to terminal events and maps sessions into workspace blocks.

3) Workspace model
- one workspace tab contains many blocks,
- block state includes layout + mode + connection state + block-specific data,
- terminal block writes/reads over `ssh_write` + event stream,
- sftp block lists/manipulates files through `sftp_*` or `local_*` commands.

4) Sync model
- sync manager uses oauth tokens from keyring,
- push/pull/startup conflict resolution update local encrypted bin files,
- startup may require explicit conflict decisions before full hydrate.

## Engineering Rules
- Prefer Zustand with persist middleware for local UI/session state that must survive F5.
- Avoid direct browser dialogs (`window.alert`, `window.confirm`, `window.prompt`).
- Block interactions must be inline in block UI (centered boxes/inputs), not global modal.
- Global modals are allowed only for app-level actions (forms/warnings/global decisions).
- Use translation dictionary for all new/changed user-facing text (TS and Rust surfaces).
- Dropdowns must render above all content and close on outside click/escape.
- Prefer rich dropdowns (label + description). Avoid native `<select>`.

## Workspace UX Rules
- Free mode is primary interaction mode.
- Block drag/resize/snap must preserve deterministic layout state.
- Context menus and transfer dropdowns cannot be clipped/hidden under neighbor blocks.
- SFTP/SSH connection stages must be visible inline: connecting/fingerprint/login/error.
- Timeout/retry status must be explicit and visible in block surface.

## Security and Persistence Notes
- Do not persist ephemeral secrets in UI persisted slices (password drafts/challenges).
- Keep credential material in vault/keychain flows only.
- Known hosts and auth callbacks must validate payload format and source.

## Testing Baseline
- Frontend: `npm run build`.
- Backend: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Validate workspace block interactions manually after each relevant change.

## File Priorities by Task Type
- Terminal/SFTP behavior:
  1. `src/pages/tabs/sftp-workspace-tab-page.tsx`
  2. `src/components/workspace/workspace-block-controller.tsx`
  3. `src-tauri/src/ssh.rs`
  4. `src-tauri/src/lib.rs`

- Sync/profile/auth:
  1. `src-tauri/src/sync.rs`
  2. `src-tauri/src/lib.rs`
  3. `src/pages/sections/settings-page.tsx`
  4. `src/components/layout/app-header.tsx`

- Global UI architecture:
  1. `src/store/*`
  2. `src/App.tsx`
  3. `src/components/layout/*`
  4. `src/langs/*`

## Notes from Legacy Docs (consolidated)
- Deep link auth target protocol is `termopen://auth`.
- PTY-backed SSH channel is required for interactive remote shell.
- Transfer progress events follow `transfer:progress:{id}` naming.
- Workspace close must close associated sessions; if no workspace remains, close all active sessions.

## Input and Transfer Architecture Defaults
- Prefer backend-first input normalization (`src-tauri/src/keyboard.rs` and `src-tauri/src/mouse.rs`) and keep frontend focused on capture/render.
- For pointer input, support full state transitions (`down`/`move`/`up`/`scroll`) and preserve last known pointer position to avoid teleport/snap.
- For wheel input, accumulate and normalize deltas in backend before protocol emission.
- Keep protocol adapters thin: RDP/SSH/SFTP should reuse shared input mapping utilities instead of duplicating key/button maps.
- Prefer path-based transfer operations over byte upload when path information is available (clipboard/drop file paths).
- For same-remote-profile SFTP copy/move, prefer remote-side command copy (`cp`) before fallback to download+upload streaming.
- Transfer UI should show lifecycle states (`queued`, `running`, `completed`, `error`) and progress events from backend.
## Portuguese Translation

## Acentuação e UTF-8

Para textos em português do Brasil, prefira escrita normal com acentos, por exemplo `você`, `configuração`, `ação`, `instalação`.

Regra prática para agentes:

- em mensagens visíveis para usuário, documentação interna e textos de UI em PT-BR, use acentuação correta quando o arquivo já suportar UTF-8
- antes de inspecionar ou editar arquivos com PT-BR via terminal no Windows/PowerShell, prepare o shell para UTF-8

Comando recomendado no PowerShell antes de leituras/edições:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
chcp 65001 > $null
```
