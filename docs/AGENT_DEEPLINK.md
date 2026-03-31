# TermOpen Agent Deeplink Guide

## Objetivo
- Documentar como o deeplink `termopen://auth` funciona no app.
- Explicar como o `server/*` notifica o app apos login OAuth com sucesso.
- Registrar os pontos de extensao para futuras mudancas.

## Arquivos principais
- `src-tauri/src/deeplink/mod.rs`
- `src-tauri/src/deeplink/windows.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/sync.rs`
- `server/src/index.js`

## Fluxo completo (Windows)
1. App inicia e chama `deeplink::prepare("com.drysius.termopen.deeplink")`.
2. Se outra instancia ja estiver rodando:
   - A nova instancia envia o argumento (`termopen://...`) para a primaria via local socket.
   - A nova instancia encerra cedo (`run()` retorna antes de subir Tauri).
3. Na instancia primaria, `deeplink::register("termopen", handler)`:
   - Registra protocolo em `HKCU\\Software\\Classes\\termopen`.
   - Mantem listener local para receber argumentos de novas instancias.
4. Usuario clica em "login Google" no app:
   - `sync_google_login` abre `${WORKER_BASE_URL}/auth/google`.
   - No Windows, o app espera callback em fila interna de deeplink (timeout de 300s).
5. Worker conclui OAuth e abre:
   - `termopen://auth?refresh_token=...&email=...&name=...`
6. `handle_deeplink_input` recebe URL e chama `handle_auth_callback_deeplink`.
7. `sync.rs` valida e enfileira os dados (`refresh_token`, `email`, `name`).
8. `google_login` consome a fila, salva no keyring e retorna `SyncState::ok`.

## Fluxo fallback (nao-Windows)
- O login continua no modelo antigo: callback HTTP local (`http://localhost:<porta>/callback`).
- Isso evita regressao em plataformas sem registro de protocolo neste modulo.

## Regras de parsing do deeplink
- Aceita apenas URLs com prefixo `termopen://`.
- Endpoint obrigatorio: `auth`.
- Parametro obrigatorio: `refresh_token`.
- Parametros opcionais: `email`, `name`.
- Se vier `error`, o fluxo retorna falha de login.

## Como o registro de protocolo funciona
- Chave base: `HKCU\\Software\\Classes\\termopen`
- Valores gravados:
  - `URL Protocol` (vazio)
  - `DefaultIcon` apontando para o executavel
  - `shell\\open\\command` com `"CaminhoDoExe" "%1"`
- Resultado: ao abrir `termopen://...`, o Windows invoca o TermOpen com a URL como argumento.

## Pontos de manutencao
- Alterar timeout de login: `AUTH_DEEPLINK_TIMEOUT` em `sync.rs`.
- Alterar schema deeplink: parser em `parse_auth_callback_from_deeplink`.
- Alterar nome do protocolo: `deeplink::register("termopen", ...)` em `lib.rs` e links do `server/src/index.js`.
- Alterar identificador da fila entre instancias: `deeplink::prepare(...)` em `lib.rs`.

## Riscos conhecidos
- Se navegador bloquear abertura de protocolo custom, o callback pode expirar.
- Se `refresh_token` vier vazio, o login e marcado como erro.
- Registro de protocolo acontece em `HKCU` (usuario atual), nao em nivel de maquina.
