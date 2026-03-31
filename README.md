# TermOpen

TermOpen is a desktop SSH/SFTP workspace built with **Tauri + React**.

## Implemented foundation

- Encrypted vault with:
  - master password mode (`Argon2id` + `XChaCha20-Poly1305`)
  - no-password mode (random key stored in OS keychain)
- Connection manager for SSH/SFTP profiles stored inside the encrypted vault
- Multi-session SSH manager (session IDs, command execution, terminal events)
- SFTP operations:
  - list directory
  - read file
  - write file
- Internal editor with Monaco and external editor launch (VS Code priority)
- Google Drive encrypted backup sync (device flow OAuth2 + appDataFolder)
- Transparent, decoration-less Tauri window with custom React titlebar
- Tailwind + shadcn-style UI shell

## Environment variables

Set these variables to enable Google Drive sync:

- `TERMOPEN_GOOGLE_CLIENT_ID`
- `TERMOPEN_GOOGLE_CLIENT_SECRET` (optional, depending on OAuth client configuration)

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Notes

- OAuth is implemented through Google Device Authorization flow.
- Sync uploads only the encrypted vault file (`termopen-vault.enc.json`) to Google Drive `appDataFolder`.
- On remote/local divergence, `sync_pull` returns conflict once and requires a second pull to confirm cloud overwrite.
