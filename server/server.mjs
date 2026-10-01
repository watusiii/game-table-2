// Room server. Holds every room (channels, messages, who is online, and which GitHub repo
// the room works from) and relays changes to everyone connected.
// Rooms are saved to server/data/rooms.json. Each room's repo is cloned under server/data/repos/.
import { WebSocketServer } from 'ws';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo } from './repo.mjs';

const PORT = Number(process.env.PORT) || 8787;
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SERVER_DIR, 'data');
const DATA_FILE = join(DATA_DIR, 'rooms.json');
const REPOS_DIR = join(DATA_DIR, 'repos');

const MAX_ONLINE = 16;
const MAX_MESSAGES = 1_000;
const MAX_CHANNELS = 50;
const MAX_CHAT_CHARS = 2_000;
const MAX_AI_CHARS = 8_000;
const CURSOR_MIN_INTERVAL_MS = 20;
const PREVIEW_DELAY_MS = 1_200;
const CLIENT_PATTERN = /^[a-f0-9]{32}$/;
const COLOR_PATTERN = /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/;
const FALLBACK_COLOR = 'hsl(0 0% 60%)';

/* ---------- State ---------- */

// id -> { id, inviteKey, name, code, ownerId, createdAt, repoUrl, channels, messages, people }
// people: memberId -> { name, color, joinedAt }
const rooms = new Map();
// roomId -> Map(memberId -> socket). Runtime only, never saved.
const online = new Map();

// Each room can work from one GitHub repo. These are runtime only.
const repos = new Map(); // roomId -> repo
const gitStates = new Map(); // roomId -> { state, message }
const previewRevs = new Map(); // roomId -> number
const previewTimers = new Map(); // roomId -> timer

// Rooms made before rooms had their own repo start out with the one from server/config.json, if any.
function readConfig() {
  try {
    return JSON.parse(readFileSync(join(SERVER_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}
const legacyRepoUrl = parseGitHubRepo(process.env.GAME_TABLE_REPO || readConfig().repoUrl || '');

/* ---------- Helpers ---------- */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function cleanChannelName(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
    : '';
}

function cleanColor(value) {
  return typeof value === 'string' && COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;
}

// Accepts "owner/name" or a github.com link and returns the clone address, or '' if it is not a GitHub repo.
function parseGitHubRepo(input) {
  if (typeof input !== 'string') return '';
  const text = input.trim();
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return '';
  return 'https://github.com/' + match[1] + '/' + match[2] + '.git';
}

const webUrlOf = (repoUrl) => repoUrl.replace(/\.git$/, '');
const repoNameOf = (repoUrl) => (repoUrl ? repoUrl.replace(/\.git$/, '').split('/').pop() : '');

// Each room saves to a branch of its own, so the shared main branch only changes when a proposal is accepted.
function branchNameFor(room) {
  const slug = room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'room';
  return 'table/' + slug + '-' + room.id.slice(0, 6);
}

// Clients prove who they are with a secret id. Everyone else only ever sees this hash.
function publicId(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(ws, packet) {
  if (ws.readyState === 1) ws.send(JSON.stringify(packet));
}

function sendError(ws, message, code = 'error') {
  send(ws, { type: 'error', message, code });
}

function notice(ws, message) {
  send(ws, { type: 'notice', message });
}

function broadcast(room, packet, exceptId) {
  const connections = online.get(room.id);
  if (!connections) return;
  connections.forEach((ws, id) => {
    if (id !== exceptId) send(ws, packet);
  });
}

// Two people arriving with the same (or nearly the same) color get nudged apart, so you can tell them apart.
function distinctColor(room, color, selfId) {
  const match = /^hsl\((\d{1,3}) (\d{1,3})% (\d{1,3})%\)$/.exec(color);
  if (!match) return color;
  const taken = Object.entries(room.people)
    .filter(([id, person]) => id !== selfId && person.color)
    .map(([, person]) => /^hsl\((\d{1,3})/.exec(person.color)?.[1])
    .filter((hue) => hue !== undefined)
    .map(Number);
  const close = (hue) => taken.some((other) => Math.min(Math.abs(other - hue), 360 - Math.abs(other - hue)) < 24);
  let hue = Number(match[1]) % 360;
  if (!close(hue)) return color;
  // Try hues spread around the wheel and take the first one nobody is near.
  for (let step = 1; step <= 15; step++) {
    const candidate = (hue + step * 24) % 360;
    if (!close(candidate)) return 'hsl(' + candidate + ' ' + match[2] + '% ' + match[3] + '%)';
  }
  return color;
}

function actorOf(room, id) {
  const person = room.people[id];
  return { id, name: person?.name ?? 'Someone', color: person?.color ?? FALLBACK_COLOR };
}

/* ---------- Roles and permissions ---------- */

// Owner made the room. Admins help run it. Members work. Viewers can only watch.
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const PERMISSIONS = {
  owner: [
    'chat', 'channels:create', 'channels:manage', 'files:edit', 'files:create', 'files:delete', 'files:restore',
    'files:restore-all', 'members:manage', 'members:kick', 'invite:reset', 'settings', 'repo',
  ],
  admin: [
    'chat', 'channels:create', 'channels:manage', 'files:edit', 'files:create', 'files:delete', 'files:restore',
    'files:restore-all', 'members:manage', 'members:kick',
  ],
  member: ['chat', 'files:edit', 'files:create', 'files:restore'],
  viewer: [],
};

function roleOf(room, id) {
  if (id === room.ownerId) return 'owner';
  const role = room.roles[id];
  return role !== 'owner' && ROLES.includes(role) ? role : 'member';
}

// AI helpers get less than the person they work for: they can read, chat, and edit files,
// but never delete, run the room, or change settings.
const AGENT_BLOCKED = [
  'files:delete', 'channels:create', 'channels:manage', 'members:manage', 'members:kick',
  'invite:reset', 'settings', 'repo', 'files:restore-all',
];

function permissionsOf(room, id) {
  const role = roleOf(room, id);
  const list = [...PERMISSIONS[role]];
  if (role === 'member' && room.settings.membersCanCreateChannels) list.push('channels:create');
  if (role === 'member' && room.settings.membersCanDeleteFiles) list.push('files:delete');
  return room.people[id]?.agent ? list.filter((action) => !AGENT_BLOCKED.includes(action)) : list;
}

function can(room, id, action) {
  return permissionsOf(room, id).includes(action);
}

function isBanned(room, id, ip) {
  return room.bans.some((ban) => ban.id === id || (ip && ban.ip && ban.ip === ip));
}

// Behind the tunnel, Cloudflare puts the visitor's real address in this header. Without a tunnel
// everyone looks like this computer, so there is nothing to block by.
function ipOf(req) {
  const value = req.headers['cf-connecting-ip'];
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

function bansFor(room) {
  return room.bans.map((ban) => ({ id: ban.id, name: ban.name, at: ban.at }));
}

// Only people who can remove others get to see who has been removed.
function sendBans(ws, room, id) {
  if (can(room, id, 'members:kick')) send(ws, { type: 'bans', bans: bansFor(room) });
}

function broadcastBans(room) {
  online.get(room.id)?.forEach((socket, id) => sendBans(socket, room, id));
}

function sendPerms(ws, room, id) {
  send(ws, { type: 'perms', role: roleOf(room, id), can: permissionsOf(room, id), settings: room.settings });
}

// Roles or settings changed: tell everyone what they can now do, and refresh the member list.
function broadcastPerms(room) {
  online.get(room.id)?.forEach((socket, id) => sendPerms(socket, room, id));
  broadcastBans(room);
  broadcast(room, { type: 'members', members: membersOf(room) });
}

/* ---------- Flood control ---------- */

// How many times one person may do something in a window. Keyed by person, not connection,
// so reconnecting does not reset it.
const LIMITS = {
  chat: [6, 10_000],
  channel: [3, 60_000],
  fileOps: [12, 60_000],
  deletes: [5, 60_000],
  bulk: [3, 60_000],
  roles: [20, 60_000],
  color: [40, 10_000],
};
const hits = new Map();

// If lots of files are deleted quickly (by anyone), deleting pauses for members for a while.
const DELETE_BURST = 8;
const deleteBursts = new Map(); // roomId -> recent delete times
const deletePausedUntil = new Map(); // roomId -> time

function trackDeleteBurst(room) {
  const now = Date.now();
  const recent = (deleteBursts.get(room.id) ?? []).filter((time) => now - time < 60_000);
  recent.push(now);
  if (recent.length >= DELETE_BURST) {
    deletePausedUntil.set(room.id, now + 5 * 60_000);
    deleteBursts.set(room.id, []);
    return true;
  }
  deleteBursts.set(room.id, recent);
  return false;
}

function withinLimit(room, id, key) {
  const [max, windowMs] = LIMITS[key];
  const slot = room.id + ':' + id + ':' + key;
  const now = Date.now();
  const recent = (hits.get(slot) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= max) {
    hits.set(slot, recent);
    return false;
  }
  recent.push(now);
  hits.set(slot, recent);
  return true;
}

// Checks a person is allowed to do something, and is not doing it too fast. Tells them if not.
function permit(ws, room, id, action, limit) {
  if (!can(room, id, action)) {
    notice(ws, "You don't have permission to do that in this room.");
    return false;
  }
  if (limit && !withinLimit(room, id, limit)) {
    notice(ws, 'Slow down a little. You are doing that too fast.');
    return false;
  }
  return true;
}

// A deleted channel is removed from the room, but a copy is kept here in case it was a mistake.
function archiveChannel(room, channel, messages) {
  try {
    const folder = join(DATA_DIR, 'deleted-channels');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, room.id + '-' + channel.id + '.json'), JSON.stringify({ channel, messages }));
  } catch (error) {
    console.error('Could not archive channel ' + channel.id + ':', error.message);
  }
}

/* ---------- Saving ---------- */

// Rooms saved before channels tracked their creator and last speaker, or before rooms had a repo, get that filled in.
function migrateRoom(room) {
  const owner = room.people[room.ownerId];
  const ownerActor = { id: room.ownerId, name: owner?.name ?? 'Room', color: owner?.color ?? FALLBACK_COLOR };
  room.channels.forEach((channel) => {
    if (!channel.created) channel.created = { by: ownerActor, at: channel.createdAt ?? room.createdAt };
    if (channel.last === undefined) {
      const lastMessage = [...room.messages]
        .reverse()
        .find((message) => message.channelId === channel.id && message.kind !== 'system');
      channel.last =
        lastMessage && room.people[lastMessage.authorId]
          ? { by: actorOf(room, lastMessage.authorId), at: lastMessage.createdAt }
          : null;
    }
    delete channel.createdAt;
  });
  if (room.repoUrl === undefined) room.repoUrl = legacyRepoUrl;
  if (room.repoUrl && !room.branch) room.branch = branchNameFor(room);
  if (!room.branch) room.branch = '';
  if (!isRecord(room.roles)) room.roles = {};
  // Older rooms kept a plain list of removed ids; keep those and add the rest.
  if (!Array.isArray(room.bans)) {
    room.bans = (Array.isArray(room.banned) ? room.banned : []).map((id) => ({
      id,
      ip: '',
      name: room.people[id]?.name ?? 'Unknown',
      at: new Date().toISOString(),
    }));
  }
  delete room.banned;
  if (!isRecord(room.settings)) room.settings = {};
  if (typeof room.settings.membersCanCreateChannels !== 'boolean') room.settings.membersCanCreateChannels = false;
  if (typeof room.settings.membersCanDeleteFiles !== 'boolean') room.settings.membersCanDeleteFiles = false;
  if (typeof room.settings.newPeopleStartAsViewers !== 'boolean') room.settings.newPeopleStartAsViewers = false;
}

function loadRooms() {
  try {
    const saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(saved)) {
      saved.forEach((room) => {
        migrateRoom(room);
        rooms.set(room.id, room);
      });
    }
    console.log('Loaded ' + rooms.size + ' saved room(s).');
  } catch {
    // First run, or nothing saved yet.
  }
}

// Written to a temporary file first and then swapped in, so a crash mid-save cannot corrupt the saved rooms.
function writeRooms() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE + '.tmp', JSON.stringify([...rooms.values()]));
    renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (error) {
    console.error('Could not save rooms:', error.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeRooms();
  }, 500);
}

// A closed room is deleted from the server, but a copy is kept here in case it was a mistake.
function archiveRoom(room) {
  try {
    const folder = join(DATA_DIR, 'closed');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, room.id + '.json'), JSON.stringify(room));
  } catch (error) {
    console.error('Could not archive room ' + room.id + ':', error.message);
  }
}

/* ---------- Each room's GitHub repo ---------- */

function gitOf(room) {
  const known = gitStates.get(room.id);
  if (known) return known;
  return room.repoUrl
    ? { state: 'opening', message: 'Opening repo\u2026' }
    : { state: 'off', message: 'No repo connected.' };
}

// What the browser needs to know about a room's repo: its state, where it lives, and which branch it works on.
function gitPacket(room, repo) {
  const web = room.repoUrl ? webUrlOf(room.repoUrl) : '';
  const info = repo ? repo.info() : { branch: '', base: '' };
  const propose =
    web && info.branch && info.base && info.branch !== info.base
      ? web + '/compare/' + encodeURIComponent(info.base) + '...' + info.branch.split('/').map(encodeURIComponent).join('/') + '?expand=1'
      : '';
  return { type: 'git', ...gitOf(room), url: web, branch: info.branch, base: info.base, propose };
}

// The repo for a room, started on first use. Null if the room has none.
function repoFor(room) {
  if (!room.repoUrl) return null;
  const existing = repos.get(room.id);
  if (existing) return existing;
  const repo = createRepo({
    url: room.repoUrl,
    branch: room.branch,
    dir: join(REPOS_DIR, room.id),
    onStatus(state, message) {
      // Only tell people, and the terminal, when something actually changed.
      const previous = gitStates.get(room.id);
      if (previous && previous.state === state && previous.message === message) return;
      gitStates.set(room.id, { state, message });
      if (state !== 'pending') console.log('[github ' + room.id + '] ' + state + ': ' + message);
      broadcast(room, gitPacket(room, repo));
    },
    onUpdate(path, update, by) {
      broadcast(room, { type: 'file:update', path, update, by });
      notifyPreview(room);
    },
    onFiles() {
      broadcast(room, { type: 'files', files: repo.list() });
      notifyPreview(room);
    },
    onTrash() {
      broadcast(room, { type: 'trash', items: repo.trashList() });
    },
  });
  repos.set(room.id, repo);
  void repo.init();
  return repo;
}

function disposeRepo(room) {
  repos.get(room.id)?.dispose();
  repos.delete(room.id);
  gitStates.delete(room.id);
  clearTimeout(previewTimers.get(room.id));
  previewTimers.delete(room.id);
}

// Tells everyone in the room the files changed, so an open game preview can reload.
// Waits for a short pause in typing so it does not restart the game on every keystroke.
function notifyPreview(room) {
  clearTimeout(previewTimers.get(room.id));
  previewTimers.set(
    room.id,
    setTimeout(() => {
      previewTimers.delete(room.id);
      const rev = (previewRevs.get(room.id) ?? 0) + 1;
      previewRevs.set(room.id, rev);
      broadcast(room, { type: 'preview', rev });
    }, PREVIEW_DELAY_MS),
  );
}

/* ---------- Game preview over HTTP ---------- */

// GET /preview/<room>/<invite key>/<file>. Read-only, and only for people who hold the invite.
function respond(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    // Even if opened directly in a tab, the page runs sandboxed, cut off from the room and the app.
    'Content-Security-Policy': 'sandbox allow-scripts allow-pointer-lock',
  });
  res.end(body);
}

function handleHttp(req, res) {
  const match = /^\/preview\/([\w-]{1,64})\/([\w-]{1,128})\/([^?#]*)/.exec(req.url ?? '');
  if (req.method !== 'GET' || !match) {
    respond(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  const room = rooms.get(match[1]);
  if (!room || !safeEqual(match[2], room.inviteKey)) {
    respond(res, 403, 'text/plain; charset=utf-8', 'Not allowed');
    return;
  }
  let path;
  try {
    path = decodeURIComponent(match[3]);
  } catch {
    respond(res, 400, 'text/plain; charset=utf-8', 'Bad path');
    return;
  }
  if (path === '' || path.endsWith('/')) path += 'index.html';
  const file = repoFor(room)?.readPreview(path);
  if (!file) {
    respond(res, 404, 'text/plain; charset=utf-8', 'Nothing at ' + path + ' in the repo yet.');
    return;
  }
  respond(res, 200, file.type, file.body);
}

/* ---------- Rooms and messages ---------- */

function membersOf(room) {
  const connections = online.get(room.id);
  if (!connections) return [];
  return [...connections.entries()].map(([id, socket]) => ({
    id,
    name: room.people[id].name,
    color: room.people[id].color,
    isHost: id === room.ownerId,
    joinedAt: room.people[id].joinedAt,
    where: socket.where ?? '',
    role: roleOf(room, id),
    agent: Boolean(room.people[id].agent),
  }));
}

function addMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  broadcast(room, { type: 'chat', message });
  // Real messages (not join/leave notices) update who spoke last in the channel.
  const channel = room.channels.find((candidate) => candidate.id === message.channelId);
  if (channel && message.kind !== 'system' && room.people[message.authorId]) {
    channel.last = { by: actorOf(room, message.authorId), at: message.createdAt };
    broadcast(room, { type: 'channel:last', channelId: channel.id, last: channel.last });
  }
  scheduleSave();
}

function addSystemMessage(room, text) {
  addMessage(room, {
    id: randomUUID(),
    channelId: room.channels[0].id,
    authorId: 'system',
    authorName: 'ROOM',
    authorColor: '',
    kind: 'system',
    text,
    createdAt: new Date().toISOString(),
  });
}

function makeRoom(owner, name, repoUrl) {
  const now = new Date().toISOString();
  const inviteKey = randomBytes(18).toString('hex');
  const general = { id: randomUUID(), name: 'general', created: { by: owner, at: now }, last: null };
  return {
    id: randomBytes(5).toString('hex'),
    inviteKey,
    name,
    code: inviteKey.slice(0, 6).toUpperCase(),
    ownerId: owner.id,
    createdAt: now,
    repoUrl,
    roles: {},
    bans: [],
    settings: { membersCanCreateChannels: false, membersCanDeleteFiles: false, newPeopleStartAsViewers: false },
    channels: [general],
    messages: [
      {
        id: randomUUID(),
        channelId: general.id,
        authorId: 'system',
        authorName: 'ROOM',
        authorColor: '',
        kind: 'system',
        text: 'The room is open. Share the invite to bring people in.',
        createdAt: now,
      },
    ],
    people: {},
  };
}

/* ---------- Joining and leaving ---------- */

function attach(ws, room, id, name, color, announce, agent = false) {
  // An AI helper is always shown as one, so it can never pass for a person.
  if (agent) name = ('AI \u00b7 ' + name.replace(/^AI\b[\s\u00b7:-]*/i, '')).slice(0, 28);
  ws.agent = agent;
  if (isBanned(room, id, ws.ip)) {
    sendError(ws, 'You were removed from this room.', 'banned');
    return;
  }
  let connections = online.get(room.id);
  if (!connections) {
    connections = new Map();
    online.set(room.id, connections);
  }
  const previous = connections.get(id);
  if (!previous && connections.size >= MAX_ONLINE) {
    sendError(ws, 'This room is full.', 'full');
    return;
  }

  const isNew = !room.people[id];
  const existing = room.people[id];
  // Returning people keep the color they chose; new arrivals are nudged away from colors already in use.
  if (isNew) color = distinctColor(room, color, id);
  room.people[id] = {
    name,
    color: isNew ? color : existing.colorChosen ? existing.color : distinctColor(room, color, id),
    colorChosen: existing?.colorChosen ?? false,
    roleSet: existing?.roleSet ?? false,
    joinedAt: existing?.joinedAt ?? new Date().toISOString(),
    ip: ws.ip ?? '',
    agent,
  };
  // Optionally, new people start as viewers until the owner or an admin lets them in.
  // AI helpers get this every time they join until someone has explicitly set their role.
  if (
    room.settings.newPeopleStartAsViewers &&
    id !== room.ownerId &&
    !room.people[id].roleSet &&
    (isNew || agent) &&
    !room.roles[id]
  ) {
    room.roles[id] = 'viewer';
  }
  if (previous && previous !== ws) {
    previous.ctx = null;
    sendError(previous, 'This room was opened somewhere else (another tab or window), so this one stopped.', 'replaced');
    previous.close();
  }
  connections.set(id, ws);
  ws.ctx = { roomId: room.id, id };

  send(ws, {
    type: 'snapshot',
    roomId: room.id,
    inviteKey: room.inviteKey,
    roomName: room.name,
    roomCode: room.code,
    ownerId: room.ownerId,
    youId: id,
    role: roleOf(room, id),
    can: permissionsOf(room, id),
    settings: room.settings,
    channels: room.channels,
    messages: room.messages,
    members: membersOf(room),
  });
  const repo = repoFor(room);
  send(ws, gitPacket(room, repo));
  send(ws, { type: 'files', files: repo ? repo.list() : [] });
  send(ws, { type: 'trash', items: repo ? repo.trashList() : [] });
  send(ws, { type: 'preview', rev: previewRevs.get(room.id) ?? 0 });
  sendBans(ws, room, id);
  if (!previous && announce && !agent) addSystemMessage(room, name + ' joined the room.');
  broadcast(room, { type: 'members', members: membersOf(room) });
  scheduleSave();
}

function detach(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const room = rooms.get(ctx.roomId);
  const connections = online.get(ctx.roomId);
  if (!room || !connections || connections.get(ctx.id) !== ws) return;
  connections.delete(ctx.id);
  if (connections.size === 0) online.delete(ctx.roomId);
  if (!room.people[ctx.id]?.agent) addSystemMessage(room, (room.people[ctx.id]?.name ?? 'Someone') + ' left the room.');
  broadcast(room, { type: 'members', members: membersOf(room) });
}

/* ---------- Messages from clients ---------- */

function handle(ws, msg) {
  if (msg.type === 'create' || msg.type === 'join') {
    if (ws.ctx) return;
    if (typeof msg.clientId !== 'string' || !CLIENT_PATTERN.test(msg.clientId)) {
      sendError(ws, 'Invalid client.');
      return;
    }
    const id = publicId(msg.clientId);
    const name = cleanText(msg.name, 28) || 'Player';
    const color = cleanColor(msg.color);
    const agent = msg.agent === true;

    if (msg.type === 'create') {
      if (agent) {
        sendError(ws, 'AI helpers cannot create rooms.');
        return;
      }
      const repoUrl = parseGitHubRepo(msg.repoUrl);
      const roomName = cleanText(msg.roomName, 56) || repoNameOf(repoUrl) || 'Untitled room';
      const room = makeRoom({ id, name, color }, roomName, repoUrl);
      room.branch = repoUrl ? branchNameFor(room) : '';
      rooms.set(room.id, room);
      attach(ws, room, id, name, color, false);
      return;
    }

    const room = typeof msg.roomId === 'string' ? rooms.get(msg.roomId) : undefined;
    if (!room) {
      sendError(ws, 'That room no longer exists.', 'not-found');
      return;
    }
    if (typeof msg.inviteKey !== 'string' || !safeEqual(msg.inviteKey, room.inviteKey)) {
      sendError(ws, 'That invite link is not valid for this room.', 'bad-key');
      return;
    }
    attach(ws, room, id, name, color, true, agent);
    return;
  }

  const ctx = ws.ctx;
  if (!ctx) return;
  const room = rooms.get(ctx.roomId);
  if (!room) return;

  if (msg.type === 'chat') {
    if (!permit(ws, room, ctx.id, 'chat', 'chat')) return;
    if (typeof msg.text !== 'string' || typeof msg.channelId !== 'string') return;
    const kind = msg.kind === 'ai' || room.people[ctx.id].agent ? 'ai' : 'chat';
    const text = msg.text.trim();
    if (!text || text.length > (kind === 'ai' ? MAX_AI_CHARS : MAX_CHAT_CHARS)) return;
    if (!room.channels.some((channel) => channel.id === msg.channelId)) return;
    const person = room.people[ctx.id];
    addMessage(room, {
      id: randomUUID(),
      channelId: msg.channelId,
      authorId: ctx.id,
      authorName: kind === 'ai' && !person.agent ? 'AI \u00b7 ' + person.name : person.name,
      authorColor: person.color,
      kind,
      text,
      createdAt: new Date().toISOString(),
    });
    return;
  }

  if (msg.type === 'channel:create') {
    if (!permit(ws, room, ctx.id, 'channels:create', 'channel')) return;
    const name = cleanChannelName(msg.name);
    if (!name || room.channels.length >= MAX_CHANNELS) return;
    if (room.channels.some((channel) => channel.name === name)) return;
    room.channels.push({
      id: randomUUID(),
      name,
      created: { by: actorOf(room, ctx.id), at: new Date().toISOString() },
      last: null,
    });
    broadcast(room, { type: 'channels', channels: room.channels });
    scheduleSave();
    return;
  }

  if (msg.type === 'channel:delete') {
    if (!permit(ws, room, ctx.id, 'channels:manage', 'roles')) return;
    const index = room.channels.findIndex((channel) => channel.id === msg.channelId);
    if (index < 1) {
      notice(ws, index === 0 ? 'The first channel cannot be deleted.' : 'That channel no longer exists.');
      return;
    }
    const [channel] = room.channels.splice(index, 1);
    const removed = room.messages.filter((message) => message.channelId === channel.id);
    room.messages = room.messages.filter((message) => message.channelId !== channel.id);
    archiveChannel(room, channel, removed);
    broadcast(room, { type: 'channel:removed', channelId: channel.id });
    broadcast(room, { type: 'channels', channels: room.channels });
    addSystemMessage(room, actorOf(room, ctx.id).name + ' deleted #' + channel.name + '.');
    scheduleSave();
    return;
  }

  // Owner and admins run the room: they set roles, remove people, and reset the invite.
  if (msg.type === 'role:set') {
    if (!permit(ws, room, ctx.id, 'members:manage', 'roles')) return;
    const target = typeof msg.id === 'string' ? msg.id : '';
    if (!room.people[target] || target === room.ownerId || target === ctx.id || !['admin', 'member', 'viewer'].includes(msg.role)) {
      notice(ws, "You can't change that person's role.");
      return;
    }
    if (msg.role === 'admin' && room.people[target].agent) {
      notice(ws, 'AI helpers cannot be admins.');
      return;
    }
    // Admins can only manage people below them.
    if (roleOf(room, ctx.id) === 'admin' && (roleOf(room, target) === 'admin' || msg.role === 'admin')) {
      notice(ws, 'Only the owner can change admins.');
      return;
    }
    room.people[target].roleSet = true;
    if (msg.role === 'member') delete room.roles[target];
    else room.roles[target] = msg.role;
    addSystemMessage(room, actorOf(room, ctx.id).name + ' set ' + room.people[target].name + ' to ' + msg.role + '.');
    broadcastPerms(room);
    scheduleSave();
    return;
  }

  if (msg.type === 'member:kick') {
    if (!permit(ws, room, ctx.id, 'members:kick', 'roles')) return;
    const target = typeof msg.id === 'string' ? msg.id : '';
    const theirs = roleOf(room, target);
    if (!room.people[target] || target === ctx.id || theirs === 'owner' || (roleOf(room, ctx.id) === 'admin' && theirs === 'admin')) {
      notice(ws, "You can't remove that person.");
      return;
    }
    const socket = online.get(room.id)?.get(target);
    if (!room.bans.some((ban) => ban.id === target)) {
      room.bans.push({
        id: target,
        ip: room.people[target].ip || socket?.ip || '',
        name: room.people[target].name,
        at: new Date().toISOString(),
      });
    }
    delete room.roles[target];
    if (socket) {
      sendError(socket, 'You were removed from this room.', 'banned');
      socket.close();
    }
    addSystemMessage(room, room.people[target].name + ' was removed by ' + actorOf(room, ctx.id).name + '.');
    notice(ws, 'Removed. Their browser and connection are blocked. If they get back in some other way, use NEW INVITE LINK.');
    broadcastBans(room);
    scheduleSave();
    return;
  }

  if (msg.type === 'member:unban') {
    if (!permit(ws, room, ctx.id, 'members:kick', 'roles')) return;
    room.bans = room.bans.filter((ban) => ban.id !== msg.id);
    broadcastBans(room);
    scheduleSave();
    return;
  }

  if (msg.type === 'invite:reset') {
    if (!permit(ws, room, ctx.id, 'invite:reset')) return;
    room.inviteKey = randomBytes(18).toString('hex');
    room.code = room.inviteKey.slice(0, 6).toUpperCase();
    broadcast(room, { type: 'invite', inviteKey: room.inviteKey, code: room.code });
    addSystemMessage(room, actorOf(room, ctx.id).name + ' made a new invite link. Old links no longer work.');
    scheduleSave();
    return;
  }

  if (msg.type === 'settings:update') {
    if (!permit(ws, room, ctx.id, 'settings')) return;
    if (typeof msg.membersCanCreateChannels === 'boolean') room.settings.membersCanCreateChannels = msg.membersCanCreateChannels;
    if (typeof msg.membersCanDeleteFiles === 'boolean') room.settings.membersCanDeleteFiles = msg.membersCanDeleteFiles;
    if (typeof msg.newPeopleStartAsViewers === 'boolean') room.settings.newPeopleStartAsViewers = msg.newPeopleStartAsViewers;
    broadcastPerms(room);
    scheduleSave();
    return;
  }

  if (msg.type === 'cursor') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    const hidden = msg.x < 0 || msg.y < 0;
    const now = Date.now();
    if (!hidden && now - ws.lastCursorAt < CURSOR_MIN_INTERVAL_MS) return;
    ws.lastCursorAt = now;
    const clamp = (value) => Math.min(1, Math.max(0, value));
    broadcast(
      room,
      { type: 'cursor', id: ctx.id, x: hidden ? -1 : clamp(msg.x), y: hidden ? -1 : clamp(msg.y) },
      ctx.id,
    );
    return;
  }

  // Anyone can pick their own color.
  if (msg.type === 'profile:color') {
    if (typeof msg.color !== 'string' || !COLOR_PATTERN.test(msg.color)) return;
    if (!withinLimit(room, ctx.id, 'color')) return;
    room.people[ctx.id].color = msg.color;
    room.people[ctx.id].colorChosen = true;
    broadcast(room, { type: 'members', members: membersOf(room) });
    scheduleSave();
    return;
  }

  if (msg.type === 'here') {
    ws.where = cleanText(msg.where, 80);
    broadcast(room, { type: 'members', members: membersOf(room) });
    return;
  }

  // Connecting a repo makes this server clone it and save to it under the owner's GitHub login,
  // so only the room owner may do it.
  if (msg.type === 'repo:connect') {
    if (!can(room, ctx.id, 'repo')) {
      notice(ws, 'Only the room owner can connect a repo.');
      return;
    }
    if (room.repoUrl) {
      notice(ws, 'Disconnect the current repo first.');
      return;
    }
    const url = parseGitHubRepo(msg.url);
    if (!url) {
      notice(ws, 'Use a GitHub repo like owner/name, or a https://github.com/owner/name link.');
      return;
    }
    room.repoUrl = url;
    room.branch = room.branch || branchNameFor(room);
    gitStates.delete(room.id);
    scheduleSave();
    repoFor(room);
    addSystemMessage(room, actorOf(room, ctx.id).name + ' connected ' + webUrlOf(url) + '.');
    return;
  }

  if (msg.type === 'repo:disconnect') {
    if (!can(room, ctx.id, 'repo') || !room.repoUrl) return;
    disposeRepo(room);
    room.repoUrl = '';
    scheduleSave();
    broadcast(room, { type: 'git', state: 'off', message: 'No repo connected.', url: '', branch: '', base: '', propose: '' });
    broadcast(room, { type: 'files', files: [] });
    addSystemMessage(room, actorOf(room, ctx.id).name + ' disconnected the repo.');
    return;
  }

  const repo = repoFor(room);

  if (msg.type === 'file:open') {
    const file = repo && typeof msg.path === 'string' ? repo.open(msg.path) : null;
    if (file) send(ws, { type: 'file:state', ...file });
    else notice(ws, 'Could not open that file.');
    return;
  }

  if (msg.type === 'file:update') {
    if (!can(room, ctx.id, 'files:edit')) return;
    if (!repo || typeof msg.path !== 'string' || typeof msg.update !== 'string') return;
    const author = room.people[ctx.id].name;
    if (repo.applyUpdate(msg.path, msg.update, author)) {
      broadcast(room, { type: 'file:update', path: msg.path, update: msg.update, by: author }, ctx.id);
      notifyPreview(room);
    }
    return;
  }

  if (msg.type === 'file:cursor') {
    if (typeof msg.path !== 'string' || JSON.stringify(msg).length > 1500) return;
    const clear = msg.clear === true;
    if (!clear && (!isRecord(msg.start) || !isRecord(msg.end))) return;
    broadcast(
      room,
      { type: 'file:cursor', path: msg.path, id: ctx.id, clear, start: msg.start, end: msg.end, back: msg.back === true },
      ctx.id,
    );
    return;
  }

  if (msg.type === 'file:create') {
    if (!permit(ws, room, ctx.id, 'files:create', 'fileOps')) return;
    const author = room.people[ctx.id].name;
    if (!repo) {
      notice(ws, 'Connect a GitHub repo first.');
      return;
    }
    const created =
      typeof msg.path === 'string' && repo.create(msg.path.trim(), author, msg.template === 'starter');
    console.log('[files] create ' + JSON.stringify(msg.path) + ' by ' + author + ': ' + (created ? 'ok' : 'refused'));
    if (created) return;
    notice(
      ws,
      'Could not create that file. Use a name like notes.md (letters, numbers, - _ . /) and an extension like .md, .txt, .js.',
    );
    return;
  }

  if (msg.type === 'file:delete') {
    if (!permit(ws, room, ctx.id, 'files:delete', 'deletes')) return;
    if (!repo || typeof msg.path !== 'string') return;
    if (roleOf(room, ctx.id) === 'member' && Date.now() < (deletePausedUntil.get(room.id) ?? 0)) {
      notice(ws, 'Deleting is paused for a few minutes because lots of files were deleted quickly. Ask the owner or an admin.');
      return;
    }
    const author = room.people[ctx.id].name;
    const removed = repo.remove(msg.path, author);
    if (removed && trackDeleteBurst(room)) {
      addSystemMessage(room, 'Lots of files were deleted quickly, so deleting is paused for 5 minutes for members. The owner or an admin can use RESTORE ALL.');
    }
    console.log('[files] delete ' + JSON.stringify(msg.path) + ' by ' + author + ': ' + (removed ? 'ok' : 'refused'));
    if (!removed) notice(ws, 'Could not delete that file.');
    else addSystemMessage(room, author + ' deleted ' + msg.path + '. It can be restored from Recently deleted.');
    return;
  }

  // Version history: list the saved versions of a file, and bring an older one back.
  if (msg.type === 'file:history') {
    if (!repo || typeof msg.path !== 'string') return;
    const path = msg.path;
    repo
      .history(path)
      .then((versions) => send(ws, { type: 'history', path, versions }))
      .catch(() => notice(ws, 'Could not load the history.'));
    return;
  }

  if (msg.type === 'file:restore') {
    if (!permit(ws, room, ctx.id, 'files:restore', 'fileOps')) return;
    if (!repo || typeof msg.path !== 'string' || typeof msg.sha !== 'string') return;
    const author = room.people[ctx.id].name;
    const path = msg.path;
    repo
      .restoreVersion(path, msg.sha, author)
      .then((ok) => {
        if (ok) addSystemMessage(room, author + ' restored an earlier version of ' + path + '.');
        else notice(ws, 'Could not restore that version.');
      })
      .catch(() => notice(ws, 'Could not restore that version.'));
    return;
  }

  if (msg.type === 'file:undelete') {
    if (!permit(ws, room, ctx.id, 'files:restore', 'fileOps')) return;
    if (!repo || typeof msg.path !== 'string') return;
    const author = room.people[ctx.id].name;
    if (repo.restoreDeleted(msg.path, author)) addSystemMessage(room, author + ' restored ' + msg.path + '.');
    else notice(ws, 'Could not restore that file. A file with the same name may already exist.');
    return;
  }

  if (msg.type === 'file:undelete-all') {
    if (!permit(ws, room, ctx.id, 'files:restore-all', 'bulk')) return;
    if (!repo) return;
    const author = room.people[ctx.id].name;
    const count = repo.restoreAllDeleted(author);
    deletePausedUntil.delete(room.id);
    if (count) addSystemMessage(room, author + ' restored ' + count + ' deleted file' + (count === 1 ? '' : 's') + '.');
    else notice(ws, 'Nothing to restore.');
    return;
  }

  if (msg.type === 'close') {
    if (ctx.id !== room.ownerId) return;
    const connections = online.get(room.id);
    archiveRoom(room);
    disposeRepo(room);
    rooms.delete(room.id);
    online.delete(room.id);
    connections?.forEach((socket) => {
      socket.ctx = null;
      send(socket, { type: 'closed' });
      socket.close();
    });
    scheduleSave();
  }
}

/* ---------- Server ---------- */

loadRooms();

const httpServer = createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  ws.ctx = null;
  ws.ip = ipOf(req);
  ws.where = '';
  ws.lastCursorAt = 0;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (isRecord(msg) && typeof msg.type === 'string') handle(ws, msg);
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// Drop connections that went silent, so nobody shows as online forever.
const keepAlive = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(keepAlive));

// Forget old flood-control records so they do not pile up.
setInterval(() => {
  const now = Date.now();
  hits.forEach((times, slot) => {
    if (!times.length || now - times[times.length - 1] > 120_000) hits.delete(slot);
  });
}, 60_000).unref();

wss.on('listening', () => console.log('Room server listening on http://localhost:' + PORT + ' (rooms on ws, game preview on /preview)'));
wss.on('error', (error) => {
  console.error('Room server error: ' + error.message);
  process.exitCode = 1;
});
httpServer.listen(PORT);

// Stopping the server (Ctrl+C) finishes saving first, so no typing is lost.
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping. Saving open work first\u2026');
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeRooms();
  const giveUp = new Promise((done) => setTimeout(done, 20_000));
  await Promise.race([Promise.allSettled([...repos.values()].map((repo) => repo.shutdown())), giveUp]);
  console.log('Saved.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
