# TermOpen Agent Guide

## Objetivo desta organizacao
- Evitar `App.tsx` inchado.
- Evitar prop drilling entre layout/pages/drawers.
- Manter regras de negocio reutilizaveis em funcoes dedicadas.

## Estrutura adotada
- `src/functions/*`
  - Contem as funcoes de dominio/acao (vault, conexoes, sessao SSH, SFTP/editor).
  - Cada modulo exporta um `create*Actions(set, get)` para montar actions do Zustand.
- `src/components/workspace/workspace-block-controller.tsx`
  - Controlador base de blocos moviveis/redimensionaveis.
  - Reutilizado para blocos de terminal e SFTP.
- `src/store/app-store.types.ts`
  - Contrato unico de estado global (`AppState`) e actions (`AppActions`).
- `src/store/app-store.ts`
  - Compoe estado inicial + actions vindas de `src/functions/*`.
- `src/pages/*` e `src/components/drawers/*`
  - Consumem estado e actions diretamente pelo `useAppStore(...)`.
  - Formularios usam `react-hook-form`.
- `src/pages/tabs/sftp-workspace-tab-page.tsx`
  - Workspace unificado em blocos (SFTP, Terminal e Editor interno).
  - Blocos com `z-index` dinamico (clique traz para frente), resize/mover, fullscreen e modo `free/grid`.
  - Transferencias entre blocos SFTP via drag-and-drop usando `sftp_transfer` e evento de progresso.

## Regra para futuras mudancas
1. Logica de negocio nova: criar/editar em `src/functions/*`.
2. Expor como action no `AppActions` e compor no `app-store.ts`.
3. Páginas/drawers devem chamar actions da store, sem receber handlers por props.
4. `App.tsx` deve ficar como shell de layout, roteamento e efeitos de UI global.

## Notas importantes do backend SSH
- A sessao SSH usa canal shell com PTY (`xterm`) para evitar erro `not a tty`.
- Existe comando `ssh_resize` para ajustar cols/rows quando o bloco terminal muda tamanho.
- `ssh_write` aceita input raw (incluindo `Ctrl+C`) e tambem pode ser usado para polling de saida com payload vazio.
- Transferencia entre fontes SFTP/local usa comando `sftp_transfer` com evento de progresso `transfer:progress:{id}`.
