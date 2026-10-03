// "Join with Discord": sign in with a Discord account, so people have a real identity and a room can
// let in everyone from one Discord server without an invite link.
// Setup lives in server/config.json: { "discord": { "clientId", "clientSecret", "publicUrl" } }.
// The Discord access token is used once at sign-in and thrown away. We keep only a session cookie.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(SERVER_DIR, 'data', 'sessions.json');
const COOKIE = 'gt_session';
const SESSION_MS = 7 * 24 * 60 * 60_000; // Server membership is checked at sign-in, so sessions are short.
const STATE_MS = 10 * 60_000;

let settings = null;
try {
  const parsed = JSON.parse(readFileSync(join(SERVER_DIR, 'config.json'), 'utf8')).discord;
  if (parsed && parsed.clientId && parsed.clientSecret && parsed.publicUrl) {
    settings = {
      clientId: String(parsed.clientId),
      clientSecret: String(parsed.clientSecret),
      publicUrl: String(parsed.publicUrl).replace(/\/+$/, ''),
      apiBase: String(parsed.apiBase || 'https://discord.com/api'),
      authorizeUrl: String(parsed.authorizeUrl || 'https://discord.com/oauth2/authorize'),
    };
  }
} catch {
  // No config, or no discord section: sign-in is simply switched off.
}

export const discordEnabled = () => settings !== null;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const states = new Map(); // login state -> { next, expires }
const sessions = new Map(); // sha256(cookie) -> { id, name, guilds, expires }

try {
  const saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  const now = Date.now();
  Object.entries(saved).forEach(([key, value]) => {
    if (value && typeof value.id === 'string' && value.expires > now) sessions.set(key, value);
  });
} catch {
  // No sessions yet.
}

let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
      const temp = SESSIONS_FILE + '.tmp';
      writeFileSync(temp, JSON.stringify(Object.fromEntries(sessions)));
      renameSync(temp, SESSIONS_FILE);
    } catch (error) {
      console.error('Could not save sessions:', error.message);
    }
  }, 500);
}

function cookieOf(req) {
  const match = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie ?? '');
  return match ? match[1] : '';
}

// Who is behind this request, from the sign-in cookie. Null if nobody.
export function discordUser(req) {
  if (!settings) return null;
  // A page on another site must not be able to borrow someone's sign-in, so a browser origin has to be ours.
  const origin = req.headers.origin;
  if (origin && origin !== settings.publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
  const token = cookieOf(req);
  if (!token) return null;
  const session = sessions.get(hash(token));
  if (!session || session.expires < Date.now()) return null;
  return session;
}

const redirect = (res, location, headers = {}) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
};

const sessionCookie = (value, maxAge) =>
  COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (settings?.publicUrl.startsWith('https://') ? '; Secure' : '');

async function discordGet(path, token) {
  const response = await fetch(settings.apiBase + path, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Discord said ' + response.status);
  return response.json();
}

// Handles /auth/*. Returns true if it answered the request.
export async function handleAuth(req, res, respond) {
  const url = new URL(req.url ?? '/', 'http://local');
  if (!url.pathname.startsWith('/auth/')) return false;

  if (url.pathname === '/auth/me') {
    const user = discordUser(req);
    respond(res, 200, 'application/json; charset=utf-8', JSON.stringify({ enabled: Boolean(settings), user: user ? { name: user.name } : null }));
    return true;
  }

  if (url.pathname === '/auth/logout') {
    const token = cookieOf(req);
    if (token) {
      sessions.delete(hash(token));
      saveSessions();
    }
    redirect(res, '/', { 'Set-Cookie': sessionCookie('', 0) });
    return true;
  }

  if (!settings) {
    respond(res, 404, 'text/plain; charset=utf-8', 'Discord sign-in is not set up on this server.');
    return true;
  }

  if (url.pathname === '/auth/discord') {
    const now = Date.now();
    states.forEach((value, key) => {
      if (value.expires < now) states.delete(key);
    });
    if (states.size > 2_000) {
      respond(res, 429, 'text/plain; charset=utf-8', 'Too many sign-ins at once. Try again in a minute.');
      return true;
    }
    // Where to land afterwards: only a plain room id is allowed, never a free-form address.
    const next = /^[\w-]{1,64}$/.test(url.searchParams.get('room') ?? '') ? url.searchParams.get('room') : '';
    const state = randomBytes(16).toString('hex');
    states.set(state, { next, expires: now + STATE_MS });
    const query = new URLSearchParams({
      client_id: settings.clientId,
      response_type: 'code',
      scope: 'identify guilds',
      redirect_uri: settings.publicUrl + '/auth/discord/callback',
      state,
      prompt: 'none',
    });
    redirect(res, settings.authorizeUrl + '?' + query);
    return true;
  }

  if (url.pathname === '/auth/discord/callback') {
    const state = states.get(url.searchParams.get('state') ?? '');
    states.delete(url.searchParams.get('state') ?? '');
    const code = url.searchParams.get('code') ?? '';
    if (!state || state.expires < Date.now() || !code) {
      redirect(res, '/#discord=failed');
      return true;
    }
    try {
      const tokenResponse = await fetch(settings.apiBase + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: settings.publicUrl + '/auth/discord/callback',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) throw new Error('token ' + tokenResponse.status);
      const { access_token: accessToken } = await tokenResponse.json();
      if (typeof accessToken !== 'string') throw new Error('no token');
      const [me, guilds] = await Promise.all([discordGet('/users/@me', accessToken), discordGet('/users/@me/guilds', accessToken)]);
      if (typeof me.id !== 'string' || !/^\d{1,25}$/.test(me.id)) throw new Error('bad user');
      const name = String(me.global_name || me.username || 'Discord user').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28) || 'Discord user';
      const token = randomBytes(32).toString('hex');
      sessions.set(hash(token), {
        id: me.id,
        name,
        guilds: Array.isArray(guilds) ? guilds.map((guild) => String(guild.id)).slice(0, 200) : [],
        expires: Date.now() + SESSION_MS,
      });
      saveSessions();
      redirect(res, state.next ? '/#room=' + state.next : '/', { 'Set-Cookie': sessionCookie(token, SESSION_MS / 1000) });
    } catch (error) {
      console.error('[discord] sign-in failed:', error.message);
      redirect(res, '/#discord=failed');
    }
    return true;
  }

  respond(res, 404, 'text/plain; charset=utf-8', 'Not found');
  return true;
}
