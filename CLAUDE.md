# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
# Install dependencies (use bun, not npm)
bun install

# Run dev (frontend + Tauri backend together)
bun run tauri dev

# Type-check frontend only
bunx tsc --noEmit

# Check Rust backend only
cd src-tauri && cargo check

# Build for production
bun run build && cd src-tauri && cargo build --release
```

The dev server runs at `http://localhost:1420`. The Tauri window starts at 380x600 (vault gate) and resizes after unlock. Hot reload works for frontend changes; Rust changes require restart.

## Architecture

**Tauri 2 desktop app** with React 19 frontend and Rust backend. The app manages SSH/SFTP connections with an encrypted local vault.

### Backend (src-tauri/src/)

- **vault.rs** — Encrypted storage using Argon2id key derivation + XChaCha20-Poly1305. Binary layout: each connection/keychain entry is a separate `.bin` file, with a `manifest.bin` index and `profile.bin` for settings. **Important**: bincode v2 is used for serialization — do NOT use `#[serde(skip_serializing_if)]` on any model that gets persisted, as bincode is positional.
- **ssh.rs** — SSH2 session management with PTY shell, SFTP operations (chunked read/write), and known hosts handling.
- **sync.rs** — Google Drive vault sync via Cloudflare Worker (OAuth broker). On Windows, uses deep link (`termopen://auth`) callback; on other platforms, uses local HTTP server.
- **lib.rs** — Tauri command handlers. All commands are `async` and use `Mutex<T>` for shared state (`AppState` with vault, ssh, sync managers).
- **deeplink/** — Windows-specific deep link registration and protocol handler.
- **models.rs** — All shared data models. Changes here affect both persistence (bincode) and frontend (JSON via Tauri IPC).

### Frontend (src/)

- **Store pattern**: Zustand store composed from action modules in `src/functions/`. Each module exports `createXActions(set, get)`. Pages/components consume state via `useAppStore(selector)` — never pass handlers as props.
- **src/functions/** — Domain logic: `vault-actions.ts`, `connection-actions.ts`, `session-actions.ts`, `sftp-editor-actions.ts`.
- **src/pages/sections/** — Sidebar pages (home, settings, keychain, known-hosts, about).
- **src/pages/tabs/** — Workspace tab content (sftp-workspace, editor).
- **src/pages/vault-gate-page.tsx** — Login/init/recovery screen (shown when vault is locked).
- **src/components/workspace/** — Block controller using react-rnd for moveable/resizable blocks.

### i18n (src/langs/)

- Hook: `useT()` returns typed `AppDictionary`. Store: `useI18n()` for `locale`/`setLocale`.
- Dictionaries split by section: `pt_BR/app.ts`, `pt_BR/vault.ts`, `en_US/settings.ts`, etc.
- Type contract in `src/langs/types.ts` — all translations must satisfy `AppDictionary`.
- Locale auto-detected from browser, persisted in localStorage.

### Auth Server (server/)

Cloudflare Worker that brokers Google OAuth. Keeps `client_secret` server-side. The app sends refresh tokens to `POST /auth/refresh-token` to get new access tokens. Auth server list is fetched from GitHub raw (`auth-servers.json` at repo root) with compiled fallback.

## Key Conventions

- **No browser dialogs** (`window.alert`, `window.confirm`, `window.prompt`). Use inline UI panels or the `Dialog` component.
- **New business logic** goes in `src/functions/`, exposed as actions in `AppActions`, composed in `app-store.ts`.
- **App.tsx** should stay as a shell for layout, routing, and global effects only.
- Toast notifications via `sonner` (`toast.success()`, `toast.error()`).
- Terminal uses xterm.js with `ssh_write` for input and `terminal:output:{sessionId}` events for output.
- SFTP transfers use `sftp_transfer` command with `transfer:progress:{id}` progress events.
- SSH resize: `ssh_resize` command when terminal block changes size.

## Language

- UI text must use `useT()` hook — no hardcoded strings in components.
- Commit messages and code comments in English.
- Two supported locales: `pt_BR` (Portuguese) and `en_US` (English).
