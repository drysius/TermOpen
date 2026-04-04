/**
 * OpenPtl Auth Worker — Google OAuth broker
 *
 * Variáveis de ambiente (Cloudflare Dashboard → Settings → Variables):
 *   GOOGLE_CLIENT_ID     — obrigatório
 *   GOOGLE_CLIENT_SECRET — obrigatório
 *   ALLOWED_ORIGINS      — origens separadas por vírgula (ex: http://localhost:1420)
 *
 * Rotas:
 *   GET  /                        → health check
 *   GET  /auth/google             → inicia fluxo OAuth
 *   GET  /auth/google/callback    → recebe code e troca por tokens
 *   POST /auth/refresh-token      → renova access_token com refresh_token
 */

let GOOGLE_CLIENT_ID = '';
let GOOGLE_CLIENT_SECRET = '';

const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const BASE_STYLE = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

      * { margin: 0; padding: 0; box-sizing: border-box; }

      :root {
        --background: hsl(228 12% 8%);
        --foreground: hsl(220 20% 92%);
        --card: hsl(228 12% 11%);
        --primary: hsl(217 92% 62%);
        --primary-15: hsla(217, 92%, 62%, 0.15);
        --primary-20: hsla(217, 92%, 62%, 0.2);
        --primary-30: hsla(217, 92%, 62%, 0.3);
        --muted-foreground: hsl(220 10% 50%);
        --border: hsl(228 10% 18%);
        --border-60: hsla(228, 10%, 18%, 0.6);
        --border-40: hsla(228, 10%, 18%, 0.4);
        --success: hsl(152 60% 48%);
        --success-10: hsla(152, 60%, 48%, 0.1);
        --success-30: hsla(152, 60%, 48%, 0.3);
        --destructive: hsl(0 72% 55%);
        --destructive-10: hsla(0, 72%, 55%, 0.1);
        --destructive-30: hsla(0, 72%, 55%, 0.3);
        --secondary: hsl(228 12% 15%);
        --glow-primary: hsla(217, 92%, 62%, 0.15);
      }

      body {
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        background: var(--background);
        color: var(--foreground);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        -webkit-font-smoothing: antialiased;
      }

      .container {
        width: 100%;
        max-width: 384px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 24px;
      }

      .icon-box {
        width: 80px;
        height: 80px;
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .icon-box.success {
        background: var(--success-10);
        border: 1px solid var(--success-30);
      }

      .icon-box.error {
        background: var(--destructive-10);
        border: 1px solid var(--destructive-30);
      }

      .icon-box svg {
        width: 40px;
        height: 40px;
      }

      .icon-box.success svg { color: var(--success); }
      .icon-box.error svg { color: var(--destructive); }

      .text-center { text-align: center; }

      h1 {
        font-size: 18px;
        font-weight: 600;
        color: var(--foreground);
        line-height: 1.4;
      }

      .subtitle {
        font-size: 12px;
        color: var(--muted-foreground);
        margin-top: 4px;
        line-height: 1.5;
      }

      .user-card {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--border-60);
        background: var(--card);
        padding: 16px;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .user-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--secondary);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        flex-shrink: 0;
      }

      .user-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .user-avatar svg {
        width: 20px;
        height: 20px;
        color: var(--muted-foreground);
      }

      .user-info {
        min-width: 0;
        flex: 1;
      }

      .user-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .user-email {
        font-size: 11px;
        color: var(--muted-foreground);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .info-block {
        width: 100%;
        border-radius: 8px;
        border: 1px solid var(--border-40);
        background: var(--card);
        padding: 12px;
      }

      .info-block p {
        font-size: 10px;
        color: var(--muted-foreground);
        text-align: center;
        line-height: 1.6;
      }

      .error-detail {
        width: 100%;
        border-radius: 8px;
        border: 1px solid var(--destructive-30);
        background: var(--destructive-10);
        padding: 12px;
      }

      .error-detail p {
        font-size: 12px;
        color: var(--destructive);
        font-weight: 500;
        text-align: center;
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--border);
        border-top-color: var(--primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        display: inline-block;
        vertical-align: middle;
        margin-right: 6px;
      }

      .closing-text {
        font-size: 11px;
        color: var(--muted-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes scaleIn {
        from { opacity: 0; transform: scale(0.8); }
        to { opacity: 1; transform: scale(1); }
      }

      .animate-fade-in {
        animation: fadeIn 0.5s ease-out forwards;
      }

      .animate-scale-in {
        animation: scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }

      .delay-1 { animation-delay: 0.1s; opacity: 0; }
      .delay-2 { animation-delay: 0.2s; opacity: 0; }
      .delay-3 { animation-delay: 0.3s; opacity: 0; }
    </style>
  `;

// ─── Helpers ────────────────────────────────────────────────────────

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'http://localhost:1420').split(',').map(s => s.trim());
  const isAllowed = allowed.includes(origin) || allowed.includes('*');
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

/** Evita XSS ao embutir JSON dentro de uma tag <script> */
function safeJsonInScript(data) {
  return JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
}

// ─── POST /auth/refresh-token ────────────────────────────────────────

async function handleRefreshToken(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400, origin, env);
  }

  if (!body.refresh_token) {
    return jsonResponse({ error: 'missing_refresh_token' }, 400, origin, env);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: body.refresh_token,
      grant_type:    'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error) {
    return jsonResponse(
      { error: data.error, description: data.error_description },
      401, origin, env,
    );
  }

  return jsonResponse(
    { access_token: data.access_token, expires_in: data.expires_in },
    200, origin, env,
  );
}

// ─── GET /auth/google ────────────────────────────────────────────────

async function handleGoogleAuth(request, env) {
  const url           = new URL(request.url);
  const redirectUri   = `${url.origin}/auth/google/callback`;
  const localCallback = url.searchParams.get('local_callback') || '';

  // state = "nonce|localCallback" — nonce garante imprevisibilidade
  const nonce = crypto.randomUUID();
  const state = localCallback ? `${nonce}|${localCallback}` : nonce;

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile https://www.googleapis.com/auth/drive.file',
    access_type:   'offline',
    prompt:        'consent',
    state:         encodeURIComponent(state),
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

// ─── GET /auth/google/callback ───────────────────────────────────────

async function handleGoogleCallback(request, env) {
  const url   = new URL(request.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(renderCallbackHTML({ error: error || 'no_code' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${url.origin}/auth/google/callback`,
      grant_type:    'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) {
    return new Response(renderCallbackHTML({ error: tokens.error_description || tokens.error }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    return new Response(renderCallbackHTML({ error: 'userinfo_fetch_failed' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const user = await userRes.json();
  if (user.error) {
    return new Response(renderCallbackHTML({ error: user.error.message || 'userinfo_error' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Extrai local_callback do state (formato: "nonce|http://localhost:...")
  const rawState      = decodeURIComponent(url.searchParams.get('state') || '');
  const pipeIndex     = rawState.indexOf('|');
  const localCallback = pipeIndex !== -1 ? rawState.slice(pipeIndex + 1) : '';

  // Só redireciona para localhost — evita open redirect
  if (localCallback.startsWith('http://localhost')) {
    const redirectParams = new URLSearchParams({
      refresh_token: tokens.refresh_token || '',
      email:         user.email || '',
      name:          user.name  || '',
    });
    return Response.redirect(`${localCallback}?${redirectParams}`, 302);
  }

  return new Response(renderCallbackHTML({
    tokens: {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
    },
    user: {
      id:      user.id,
      email:   user.email,
      name:    user.name,
      picture: user.picture,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

// ─── Callback HTML (OpenPtl Design System) ────────────────────────

function renderCallbackHTML({ tokens, user, error }) {
  const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  const xIcon     = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  const userIcon  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  if (error) {
    const safeError = JSON.stringify(String(error));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenPtl — Erro</title>
  ${BASE_STYLE}
</head>
<body>
  <div class="container">
    <div class="icon-box error animate-scale-in">${xIcon}</div>

    <div class="text-center animate-fade-in delay-1">
      <h1>Erro na autenticação</h1>
      <p class="subtitle">Não foi possível completar o login com o Google.</p>
    </div>

    <div class="error-detail animate-fade-in delay-2">
      <p id="err-msg"></p>
    </div>

    <div class="info-block animate-fade-in delay-3">
      <p>Esta janela será fechada automaticamente em alguns segundos. Tente novamente pelo OpenPtl.</p>
    </div>

    <div class="closing-text animate-fade-in delay-3">
      <span class="spinner"></span>
      Fechando...
    </div>
  </div>

  <script>
    const msg = ${safeError};
    document.getElementById('err-msg').textContent = msg;
    if (window.opener) {
      window.opener.postMessage({ type: 'auth-error', error: msg }, '*');
    }
    setTimeout(() => window.close(), 4000);
  <\/script>
</body>
</html>`;
  }

  const payload    = safeJsonInScript({ type: 'auth-success', tokens, user });
  const avatarHTML = user.picture
    ? `<img src="${user.picture}" alt="${user.name}" />`
    : userIcon;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenPtl — Autenticado</title>
  ${BASE_STYLE}
</head>
<body>
  <div class="container">
    <div class="icon-box success animate-scale-in">${checkIcon}</div>

    <div class="text-center animate-fade-in delay-1">
      <h1>Autenticado com sucesso</h1>
      <p class="subtitle">Sua conta Google foi conectada ao OpenPtl.</p>
    </div>

    <div class="user-card animate-fade-in delay-2">
      <div class="user-avatar">${avatarHTML}</div>
      <div class="user-info">
        <div class="user-name">${user.name || 'Usuário'}</div>
        <div class="user-email">${user.email || ''}</div>
      </div>
    </div>

    <div class="info-block animate-fade-in delay-3">
      <p>Seus tokens foram enviados com segurança para o aplicativo. Esta janela será fechada automaticamente.</p>
    </div>

    <div class="closing-text animate-fade-in delay-3">
      <span class="spinner"></span>
      Fechando...
    </div>
  </div>

  <script>
    const data = ${payload};
    if (window.opener) {
      window.opener.postMessage(data, '*');
    }
    try {
      const params = new URLSearchParams({
        refresh_token: data.tokens.refresh_token || '',
        email:         data.user.email || '',
        name:          data.user.name  || '',
      });
      window.location.href = 'openptl://auth?' + params.toString();
    } catch (e) { /* desktop não disponível */ }
    setTimeout(() => window.close(), 3000);
  <\/script>
</body>
</html>`;
}

// ─── Router (entry point) ────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    GOOGLE_CLIENT_ID     = env.GOOGLE_CLIENT_ID;
    GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    console.info({ message: 'OpenPtl Auth Worker received a request', pathname: url.pathname });

    // Valida variáveis de ambiente obrigatórias
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return jsonResponse(
        { error: 'worker_misconfigured', detail: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set' },
        500, origin, env,
      );
    }

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    switch (url.pathname) {
      case '/':
        return jsonResponse({ service: 'openptl-auth', status: 'ok' }, 200, origin, env);

      case '/auth/google':
        return handleGoogleAuth(request, env);

      case '/auth/google/callback':
        return handleGoogleCallback(request, env);

      case '/auth/refresh-token':
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'method_not_allowed' }, 405, origin, env);
        }
        return handleRefreshToken(request, env, origin);

      default:
        return jsonResponse({ error: 'not_found' }, 404, origin, env);
    }
  },
};