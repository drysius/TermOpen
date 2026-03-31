/**
 * TermOpen Auth Worker — Google OAuth broker
 *
 */

let GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
let GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ─── Helpers ────────────────────────────────────────────────────────

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'http://localhost:1420').split(',').map(s => s.trim());
  const isAllowed = allowed.includes(origin) || allowed.includes('*');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

// ─── POST /auth/refresh-token — renova access_token usando refresh_token ─

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
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: body.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error) {
    return jsonResponse({ error: data.error, description: data.error_description }, 401, origin, env);
  }

  return jsonResponse({
    access_token: data.access_token,
    expires_in: data.expires_in,
  }, 200, origin, env);
}

// ─── Auth routes ────────────────────────────────────────────────────

async function handleGoogleAuth(request, env) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/google/callback`;
  const localCallback = url.searchParams.get('local_callback') || '';

  // Guardar local_callback no state para usar no callback
  const state = localCallback
    ? encodeURIComponent(localCallback)
    : crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(renderCallbackHTML({ error: error || 'no_code' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const redirectUri = `${url.origin}/auth/google/callback`;

  // Trocar code por tokens (aqui o client_secret é usado — e nunca sai do worker)
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) {
    return new Response(renderCallbackHTML({ error: tokens.error_description || tokens.error }), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Buscar perfil do usuário
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json();

  // Se tem local_callback (vindo do state), redirecionar pro localhost do app
  const state = url.searchParams.get('state') || '';
  const localCallback = decodeURIComponent(state);

  if (localCallback.startsWith('http://localhost')) {
    const redirectParams = new URLSearchParams({
      refresh_token: tokens.refresh_token || '',
      email: user.email || '',
      name: user.name || '',
    });
    return Response.redirect(`${localCallback}?${redirectParams}`, 302);
  }

  // Fallback: retorna HTML com postMessage
  return new Response(renderCallbackHTML({
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

// ─── Callback HTML ──────────────────────────────────────────────────

function renderCallbackHTML({ tokens, user, error }) {
  if (error) {
    return `<!DOCTYPE html><html><body>
      <h2>Erro na autenticacao</h2><p>${error}</p>
      <script>
        if (window.opener) window.opener.postMessage({ type: 'auth-error', error: '${error}' }, '*');
        setTimeout(() => window.close(), 3000);
      </script>
    </body></html>`;
  }

  const payload = JSON.stringify({ type: 'auth-success', tokens, user });

  return `<!DOCTYPE html><html><body>
    <p>Autenticado com sucesso! Fechando...</p>
    <script>
      const data = ${payload};
      if (window.opener) {
        window.opener.postMessage(data, '*');
      }
      // Deep link fallback para Tauri
      try {
        const params = new URLSearchParams({
          refresh_token: data.tokens.refresh_token || '',
          email: data.user.email || '',
          name: data.user.name || '',
        });
        window.location.href = 'termopen://auth?' + params.toString();
      } catch(e) {}
      setTimeout(() => window.close(), 2000);
    </script>
  </body></html>`;
}

// ─── Router ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Injetar credentials do env
    GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
    GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    switch (url.pathname) {
      case '/auth/google':
        return handleGoogleAuth(request, env);

      case '/auth/google/callback':
        return handleGoogleCallback(request, env);

      case '/auth/refresh-token':
        if (request.method !== 'POST') break;
        return handleRefreshToken(request, env, origin);

      case '/':
        return jsonResponse({ service: 'termopen-auth', status: 'ok' }, 200, origin, env);
    }

    return jsonResponse({ error: 'not_found' }, 404, origin, env);
  },
};
