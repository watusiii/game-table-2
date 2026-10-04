import { FileSession } from './collab';
import type {
  Activity,
  BanEntry,
  Channel,
  ChatMessage,
  CursorUpdate,
  FileVersion,
  GitState,
  MessageKind,
  RoomMember,
  RoomSnapshot,
  Role,
  RoomSettings,
  SlashCommand,
  SavedRoom,
  TrashItem,
} from './types';

const NAME_STORAGE = 'game-table-2:display-name:v1';
const COLOR_STORAGE = 'game-table-2:color:v1';
const CLIENT_STORAGE = 'game-table-2:client-id:v1';
const SAVED_ROOM_STORAGE = 'game-table-2:saved-room:v1';
const COLOR_PATTERN = /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/;
const FALLBACK_COLOR = 'hsl(0 0% 60%)';
const MAX_MESSAGES = 1_000;
const MAX_CHAT_CHARS = 2_000;
const MAX_AI_CHARS = 8_000;
const CURSOR_MIN_INTERVAL_MS = 40;
const RECONNECT_DELAY_MS = 1_500;

// Where the room server lives. Override with VITE_SERVER_URL when deploying.
const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';

type Listener = (snapshot: RoomSnapshot) => void;
type CursorListener = (cursor: CursorUpdate) => void;

interface Identity {
  name: string;
  color: string;
}

interface Session {
  roomId: string;
  inviteKey: string;
}

/* ---------- Small helpers ---------- */

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// One identity per browser, so opening a new tab does not make someone a brand-new person.
// (To test as a second person, use a private window or another browser.)
function browserClientId(): string {
  try {
    const stored = localStorage.getItem(CLIENT_STORAGE);
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored;
    const id = randomHex(16);
    localStorage.setItem(CLIENT_STORAGE, id);
    return id;
  } catch {
    return randomHex(16);
  }
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 28) || 'Player';
}

function cleanRoomName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 56) || 'Untitled room';
}

function cleanChannelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function randomColor(): string {
  return 'hsl(' + Math.floor(Math.random() * 360) + ' 65% 62%)';
}

export function cleanColor(value: unknown): string {
  return typeof value === 'string' && COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeInviteLink(roomId: string, inviteKey: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = new URLSearchParams({ room: roomId, key: inviteKey }).toString();
  return url.toString();
}

function inviteFromLocation(): { roomId: string; inviteKey: string } | null {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  const roomId = params.get('room')?.trim() ?? '';
  const inviteKey = params.get('key')?.trim() ?? '';
  if (!roomId || roomId.length > 64 || inviteKey.length > 128) return null;
  return { roomId, inviteKey };
}

// Accepts "owner/name" or a github.com link and returns the clone address, or null if it is not a GitHub repo.
export function parseRepoInput(value: string): string | null {
  const text = value.trim();
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text);
  if (!match || [match[1], match[2]].some((part) => part === '.' || part === '..')) return null;
  return 'https://github.com/' + match[1] + '/' + match[2] + '.git';
}

function readSavedRoom(): SavedRoom | null {
  try {
    const raw = localStorage.getItem(SAVED_ROOM_STORAGE);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.roomId !== 'string' ||
      typeof value.inviteKey !== 'string' ||
      typeof value.roomName !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.clientId !== 'string'
    ) return null;
    return {
      roomId: value.roomId,
      inviteKey: value.inviteKey,
      roomName: value.roomName,
      name: value.name,
      clientId: value.clientId,
    };
  } catch {
    return null;
  }
}

function writeSavedRoom(saved: SavedRoom | null): void {
  try {
    if (saved) localStorage.setItem(SAVED_ROOM_STORAGE, JSON.stringify(saved));
    else localStorage.removeItem(SAVED_ROOM_STORAGE);
  } catch {
    // Resuming is a convenience; the room still works without storage.
  }
}

function parseRole(value: unknown): Role {
  return value === 'owner' || value === 'admin' || value === 'viewer' ? value : 'member';
}

function parseSettings(value: unknown): RoomSettings {
  return {
    membersCanCreateChannels: isRecord(value) && value.membersCanCreateChannels === true,
    membersCanDeleteFiles: isRecord(value) && value.membersCanDeleteFiles === true,
    newPeopleStartAsViewers: isRecord(value) && value.newPeopleStartAsViewers === true,
    discordGuildId: isRecord(value) && typeof value.discordGuildId === 'string' ? value.discordGuildId : '',
  };
}

function parseCan(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.name === 'string' && typeof item.args === 'string' && typeof item.help === 'string'
      ? [{ name: item.name, args: item.args, help: item.help }]
      : [],
  );
}

function emptySnapshot(): RoomSnapshot {
  return {
    role: null,
    status: 'idle',
    statusMessage: '',
    roomId: '',
    roomName: '',
    roomCode: '',
    myId: '',
    inviteLink: '',
    channels: [],
    messages: [],
    members: [],
    files: [],
    file: null,
    git: { state: 'off', message: '', url: '', branch: '', base: '', propose: '' },
    notice: '',
    previewRev: 0,
    history: null,
    trash: [],
    myRole: 'member',
    can: [],
    commands: [],
    settings: { membersCanCreateChannels: false, membersCanDeleteFiles: false, newPeopleStartAsViewers: false, discordGuildId: '' },
    bans: [],
    noticeSeq: 0,
  };
}

/* ---------- The client ---------- */

export class RoomClient {
  private snapshot: RoomSnapshot = emptySnapshot();
  private listeners = new Set<Listener>();
  private cursorListeners = new Set<CursorListener>();
  private socket: WebSocket | null = null;
  private clientId = browserClientId();
  private identity: Identity = { name: 'Player', color: FALLBACK_COLOR };
  private session: Session | null = null;
  private established = false;
  private reconnectTimer: number | undefined;
  private lastCursorSentAt = 0;
  private openPath = '';
  private fileSession: FileSession | null = null;
  private location = '';

  static savedName(): string {
    try {
      return localStorage.getItem(NAME_STORAGE) ?? '';
    } catch {
      return '';
    }
  }

  static saveName(value: string): void {
    try {
      localStorage.setItem(NAME_STORAGE, cleanName(value));
    } catch {
      // The name is a convenience; the room still works when storage is disabled.
    }
  }

  static savedColor(): string {
    try {
      const stored = localStorage.getItem(COLOR_STORAGE);
      if (stored && COLOR_PATTERN.test(stored)) return stored;
      const color = randomColor();
      localStorage.setItem(COLOR_STORAGE, color);
      return color;
    } catch {
      return randomColor();
    }
  }

  // Pick your own color. Saved for next time, and everyone in the room sees it change.
  static saveColor(color: string): void {
    try {
      if (COLOR_PATTERN.test(color)) localStorage.setItem(COLOR_STORAGE, color);
    } catch {
      // A convenience only.
    }
  }

  setColor(color: string): void {
    if (!COLOR_PATTERN.test(color)) return;
    RoomClient.saveColor(color);
    this.identity = { ...this.identity, color };
    this.send({ type: 'profile:color', color });
  }

  static savedRoom(): SavedRoom | null {
    return readSavedRoom();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  onCursor(listener: CursorListener): () => void {
    this.cursorListeners.add(listener);
    return () => this.cursorListeners.delete(listener);
  }

  createRoom(roomNameInput: string, nameInput: string, repoInput = ''): void {
    const repoUrl = parseRepoInput(repoInput) ?? '';
    const roomName = cleanRoomName(roomNameInput);
    this.begin(nameInput);
    this.patch({ ...emptySnapshot(), role: 'host', status: 'connecting', statusMessage: 'Connecting to the room server…', roomName });
    this.open({
      type: 'create',
      clientId: this.clientId,
      roomName: roomNameInput.trim().slice(0, 56),
      repoUrl,
      name: this.identity.name,
      color: this.identity.color,
    });
  }

  joinRoom(roomId: string, inviteKey: string, nameInput: string): void {
    // No key is fine when signed in with Discord: the room can let in its Discord server instead.
    if (!roomId.trim()) {
      this.patch({ status: 'error', statusMessage: 'That invite link is missing its room details.' });
      return;
    }
    this.begin(nameInput);
    this.session = { roomId: roomId.trim(), inviteKey: inviteKey.trim() };
    this.patch({ ...emptySnapshot(), role: 'guest', status: 'connecting', statusMessage: 'Connecting to the room server…' });
    this.open(this.joinPacket());
  }

  resumeRoom(): void {
    const saved = readSavedRoom();
    if (!saved) return;
    this.clientId = saved.clientId;
    try {
      localStorage.setItem(CLIENT_STORAGE, saved.clientId);
    } catch {
      // Identity just won't survive a refresh of this tab.
    }
    this.begin(saved.name);
    this.session = { roomId: saved.roomId, inviteKey: saved.inviteKey };
    this.patch({
      ...emptySnapshot(),
      role: 'guest',
      status: 'connecting',
      statusMessage: 'Reopening ' + saved.roomName + '…',
      roomName: saved.roomName,
    });
    this.open(this.joinPacket());
  }

  sendMessage(textInput: string, channelId: string, kind: 'chat' | 'ai' = 'chat'): boolean {
    const text = textInput.trim();
    const limit = kind === 'ai' ? MAX_AI_CHARS : MAX_CHAT_CHARS;
    if (!text || text.length > limit || this.snapshot.status !== 'online') return false;
    if (!this.snapshot.channels.some((channel) => channel.id === channelId)) return false;
    return this.send({ type: 'chat', channelId, text, kind });
  }

  createChannel(nameInput: string): boolean {
    const name = cleanChannelName(nameInput);
    if (!name || this.snapshot.status !== 'online') return false;
    return this.send({ type: 'channel:create', name });
  }

  openFile(path: string): void {
    this.openPath = path;
    this.disposeFile();
    this.patch({ notice: '', file: null, history: null });
    this.send({ type: 'file:open', path });
  }

  // Looking at a picture or other non-text file: nothing to edit, so close the live document.
  openMedia(): void {
    this.openPath = '';
    this.disposeFile();
    this.patch({ notice: '', file: null, history: null });
  }

  // Where a file in the repo can be loaded from, for pictures, sound and the like.
  fileUrl(path: string): string {
    if (!this.session) return '';
    return (
      '/preview/' + encodeURIComponent(this.session.roomId) + '/' + encodeURIComponent(this.session.inviteKey) + '/' +
      path.split('/').map(encodeURIComponent).join('/')
    );
  }

  // The live document for the open file. The editor attaches its textarea to this.
  getFileSession(): FileSession | null {
    return this.fileSession;
  }

  // Tell the room where you are (a channel or a file) so others can see it.
  setLocation(where: string): void {
    this.location = where;
    this.send({ type: 'here', where });
  }

  createFile(path: string): boolean {
    this.patch({ notice: '' });
    return this.send({ type: 'file:create', path });
  }

  // Makes index.html with a tiny playable game in it, for the preview to run.
  createStarter(): boolean {
    this.patch({ notice: '' });
    return this.send({ type: 'file:create', path: 'index.html', template: 'starter' });
  }

  // Owner only: work from this GitHub repo ("owner/name" or a github.com link).
  connectRepo(input: string): boolean {
    const url = parseRepoInput(input);
    if (!url) {
      this.patch({ notice: 'Use a GitHub repo like owner/name, or a https://github.com/owner/name link.' });
      return false;
    }
    this.patch({ notice: '' });
    return this.send({ type: 'repo:connect', url });
  }

  disconnectRepo(): void {
    this.send({ type: 'repo:disconnect' });
  }

  deleteFile(path: string): void {
    this.patch({ notice: '' });
    this.send({ type: 'file:delete', path });
  }

  // Bring a deleted file back from the trash.
  undelete(path: string): void {
    this.patch({ notice: '' });
    this.send({ type: 'file:undelete', path });
  }

  // Saved versions of a file, and restoring an older one.
  requestHistory(path: string): void {
    this.send({ type: 'file:history', path });
  }

  closeHistory(): void {
    this.patch({ history: null });
  }

  restoreVersion(path: string, sha: string): void {
    this.patch({ notice: '' });
    this.send({ type: 'file:restore', path, sha });
  }

  // Running the room (owner and admins).
  setRole(id: string, role: string): void {
    this.send({ type: 'role:set', id, role });
  }

  kick(id: string): void {
    this.send({ type: 'member:kick', id });
  }

  deleteChannel(channelId: string): void {
    this.send({ type: 'channel:delete', channelId });
  }

  // Owner only: old invite links stop working. People already in the room stay.
  resetInvite(): void {
    this.send({ type: 'invite:reset' });
  }

  setDiscordServer(id: string): void {
    this.send({ type: 'settings:update', discordGuildId: id.trim() });
  }

  setSetting(name: Exclude<keyof RoomSettings, 'discordGuildId'>, value: boolean): void {
    this.send({ type: 'settings:update', [name]: value });
  }

  // Let someone who was removed back in.
  unban(id: string): void {
    this.send({ type: 'member:unban', id });
  }

  // Bring back every deleted file at once (owner and admins).
  undeleteAll(): void {
    this.patch({ notice: '' });
    this.send({ type: 'file:undelete-all' });
  }

  // Where the running game is served from. Empty until the room is joined.
  previewUrl(): string {
    if (!this.session) return '';
    return (
      '/preview/' + encodeURIComponent(this.session.roomId) + '/' + encodeURIComponent(this.session.inviteKey) + '/index.html'
    );
  }

  // x and y are 0..1 across the window. Pass -1, -1 to hide your cursor.
  sendCursor(x: number, y: number): void {
    if (this.snapshot.status !== 'online') return;
    const hidden = x < 0 || y < 0;
    const now = Date.now();
    if (!hidden && now - this.lastCursorSentAt < CURSOR_MIN_INTERVAL_MS) return;
    this.lastCursorSentAt = now;
    this.send({ type: 'cursor', x: hidden ? -1 : clampUnit(x), y: hidden ? -1 : clampUnit(y) });
  }

  // The owner closing the room deletes it for everyone. Anyone else just leaves.
  closeRoom(): void {
    if (this.snapshot.role === 'host' && this.established) this.send({ type: 'close' });
    this.forgetRoom();
    this.stop();
    this.patch(emptySnapshot());
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    window.history.replaceState({}, '', url);
  }

  destroyForUnload(): void {
    this.stop();
  }

  /* ---------- Connection ---------- */

  private begin(nameInput: string): void {
    this.stop();
    this.established = false;
    this.session = null;
    this.openPath = '';
    this.location = '';
    this.identity = { name: cleanName(nameInput), color: RoomClient.savedColor() };
  }

  private joinPacket(): object {
    return {
      type: 'join',
      clientId: this.clientId,
      roomId: this.session?.roomId ?? '',
      inviteKey: this.session?.inviteKey ?? '',
      name: this.identity.name,
      color: this.identity.color,
    };
  }

  private open(first: object): void {
    this.closeSocket();
    const socket = new WebSocket(SERVER_URL);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket === socket) socket.send(JSON.stringify(first));
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.handleClose();
    });
    socket.addEventListener('error', () => {
      // The close event follows and reports the problem.
    });
  }

  private handleClose(): void {
    this.socket = null;
    if (this.established && this.session) {
      this.patch({ status: 'connecting', statusMessage: 'Connection lost. Reconnecting…' });
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.session) this.open(this.joinPacket());
      }, RECONNECT_DELAY_MS);
      return;
    }
    if (this.snapshot.role) {
      this.patch({
        status: 'error',
        statusMessage: 'Could not reach the room server at ' + SERVER_URL + '. Is it running? (npm run dev starts it.)',
      });
    }
  }

  private send(packet: object): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(packet));
    return true;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
  }

  private stop(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.closeSocket();
    this.session = null;
    this.established = false;
    this.disposeFile();
  }

  private disposeFile(): void {
    this.fileSession?.dispose();
    this.fileSession = null;
  }

  private forgetRoom(): void {
    writeSavedRoom(null);
  }

  /* ---------- Incoming ---------- */

  private handleMessage(raw: unknown): void {
    let value: unknown;
    try {
      value = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') return;

    if (value.type === 'snapshot') {
      if (
        typeof value.roomId !== 'string' ||
        typeof value.inviteKey !== 'string' ||
        typeof value.youId !== 'string' ||
        typeof value.ownerId !== 'string' ||
        typeof value.roomName !== 'string' ||
        typeof value.roomCode !== 'string' ||
        !Array.isArray(value.channels) ||
        !Array.isArray(value.messages) ||
        !Array.isArray(value.members)
      ) return;
      const roomId = value.roomId;
      const inviteKey = value.inviteKey;
      const roomName = value.roomName;
      this.established = true;
      this.session = { roomId, inviteKey };
      writeSavedRoom({ roomId, inviteKey, roomName, name: this.identity.name, clientId: this.clientId });
      this.patch({
        role: value.ownerId === value.youId ? 'host' : 'guest',
        status: 'online',
        statusMessage: '',
        roomId,
        roomName,
        roomCode: value.roomCode,
        myId: value.youId,
        inviteLink: makeInviteLink(roomId, inviteKey),
        channels: value.channels as Channel[],
        messages: value.messages as ChatMessage[],
        members: value.members as RoomMember[],
        myRole: parseRole(value.role),
        can: parseCan(value.can),
        commands: parseCommands(value.commands),
        settings: parseSettings(value.settings),
      });
      // After a reconnect, ask for the open file again so nothing is missed.
      if (this.openPath) this.send({ type: 'file:open', path: this.openPath });
      if (this.location) this.send({ type: 'here', where: this.location });
      return;
    }

    if (value.type === 'chat' && isRecord(value.message)) {
      if (typeof value.message.id !== 'string' || typeof value.message.channelId !== 'string') return;
      const messages = [...this.snapshot.messages, value.message as unknown as ChatMessage].slice(-MAX_MESSAGES);
      this.patch({ messages });
      return;
    }

    if (value.type === 'channels' && Array.isArray(value.channels)) {
      this.patch({ channels: value.channels as Channel[] });
      return;
    }

    if (value.type === 'channel:last' && typeof value.channelId === 'string' && (value.last === null || isRecord(value.last))) {
      const channelId = value.channelId;
      const last = value.last as Activity | null;
      this.patch({
        channels: this.snapshot.channels.map((channel) => (channel.id === channelId ? { ...channel, last } : channel)),
      });
      return;
    }

    if (value.type === 'bans' && Array.isArray(value.bans)) {
      const bans: BanEntry[] = [];
      for (const item of value.bans) {
        if (isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.at === 'string') {
          bans.push({ id: item.id, name: item.name, at: item.at });
        }
      }
      this.patch({ bans });
      return;
    }

    if (value.type === 'perms') {
      this.patch({ myRole: parseRole(value.role), can: parseCan(value.can), commands: parseCommands(value.commands), settings: parseSettings(value.settings) });
      return;
    }

    if (value.type === 'channel:removed' && typeof value.channelId === 'string') {
      const channelId = value.channelId;
      this.patch({ messages: this.snapshot.messages.filter((message) => message.channelId !== channelId) });
      return;
    }

    // The owner made a new invite link. Keep it, so reconnecting and the preview keep working.
    if (value.type === 'invite' && typeof value.inviteKey === 'string' && this.session) {
      const { roomId } = this.session;
      const inviteKey = value.inviteKey;
      this.session = { roomId, inviteKey };
      writeSavedRoom({ roomId, inviteKey, roomName: this.snapshot.roomName, name: this.identity.name, clientId: this.clientId });
      this.patch({
        inviteLink: makeInviteLink(roomId, inviteKey),
        roomCode: typeof value.code === 'string' ? value.code : this.snapshot.roomCode,
      });
      return;
    }

    if (value.type === 'members' && Array.isArray(value.members)) {
      this.patch({ members: value.members as RoomMember[] });
      return;
    }

    if (
      value.type === 'cursor' &&
      typeof value.id === 'string' &&
      typeof value.x === 'number' &&
      typeof value.y === 'number' &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y)
    ) {
      const hidden = value.x < 0 || value.y < 0;
      const cursor: CursorUpdate = {
        id: value.id,
        x: hidden ? -1 : clampUnit(value.x),
        y: hidden ? -1 : clampUnit(value.y),
      };
      this.cursorListeners.forEach((listener) => listener(cursor));
      return;
    }

    if (value.type === 'files' && Array.isArray(value.files)) {
      const files = value.files.filter((name): name is string => typeof name === 'string');
      // If the file we had open was deleted (or the repo disconnected), close it.
      if (this.openPath && !files.includes(this.openPath)) {
        this.openPath = '';
        this.disposeFile();
        this.patch({ files, file: null });
      } else {
        this.patch({ files });
      }
      return;
    }

    if (value.type === 'file:state' && typeof value.path === 'string' && typeof value.update === 'string') {
      const path = value.path;
      if (path !== this.openPath) return;
      const resync = this.fileSession !== null && this.fileSession.path === path;
      if (!this.fileSession || this.fileSession.path !== path) {
        this.disposeFile();
        this.fileSession = new FileSession(
          path,
          { id: this.snapshot.myId, name: this.identity.name, color: this.identity.color },
          (update) => {
            this.send({ type: 'file:update', path, update });
          },
          (presence) => {
            this.send(presence ? { type: 'file:cursor', path, ...presence } : { type: 'file:cursor', path, clear: true });
          },
        );
      }
      this.fileSession.applyRemote(value.update);
      if (resync) this.fileSession.pushAll();
      this.patch({ file: { path, editedBy: this.snapshot.file?.editedBy ?? '' } });
      return;
    }

    if (
      value.type === 'file:update' &&
      typeof value.path === 'string' &&
      typeof value.update === 'string' &&
      typeof value.by === 'string'
    ) {
      if (this.fileSession && this.fileSession.path === value.path) {
        this.fileSession.applyRemote(value.update);
        this.patch({ file: { path: value.path, editedBy: value.by } });
      }
      return;
    }

    if (value.type === 'file:cursor' && typeof value.path === 'string' && typeof value.id === 'string') {
      if (this.fileSession && this.fileSession.path === value.path) {
        if (value.clear === true) {
          this.fileSession.setRemote(value.id, null);
        } else if (isRecord(value.start) && isRecord(value.end)) {
          this.fileSession.setRemote(value.id, { start: value.start, end: value.end, back: value.back === true });
        }
      }
      return;
    }

    if (value.type === 'git' && typeof value.state === 'string' && typeof value.message === 'string') {
      const url = typeof value.url === 'string' && value.url.startsWith('https://') ? value.url : '';
      const propose =
        typeof value.propose === 'string' && value.propose.startsWith('https://github.com/') ? value.propose : '';
      this.patch({
        git: {
          state: value.state as GitState,
          message: value.message,
          url,
          branch: typeof value.branch === 'string' ? value.branch : '',
          base: typeof value.base === 'string' ? value.base : '',
          propose,
        },
      });
      return;
    }

    if (value.type === 'history' && typeof value.path === 'string' && Array.isArray(value.versions)) {
      const versions: FileVersion[] = [];
      for (const item of value.versions) {
        if (
          isRecord(item) &&
          typeof item.sha === 'string' &&
          typeof item.at === 'string' &&
          typeof item.author === 'string' &&
          typeof item.subject === 'string'
        ) {
          versions.push({ sha: item.sha, at: item.at, author: item.author, subject: item.subject });
        }
      }
      this.patch({ history: { path: value.path, versions } });
      return;
    }

    if (value.type === 'trash' && Array.isArray(value.items)) {
      const items: TrashItem[] = [];
      for (const item of value.items) {
        if (isRecord(item) && typeof item.path === 'string' && typeof item.by === 'string' && typeof item.at === 'string') {
          items.push({ path: item.path, by: item.by, at: item.at });
        }
      }
      this.patch({ trash: items });
      return;
    }

    if (value.type === 'preview' && typeof value.rev === 'number' && Number.isFinite(value.rev)) {
      this.patch({ previewRev: value.rev });
      return;
    }

    if (value.type === 'notice' && typeof value.message === 'string') {
      this.patch({ notice: value.message, noticeSeq: this.snapshot.noticeSeq + 1 });
      return;
    }

    if (value.type === 'error' && typeof value.message === 'string') {
      if (value.code === 'not-found' || value.code === 'banned') this.forgetRoom();
      this.stop();
      this.patch({ status: 'error', statusMessage: value.message });
      return;
    }

    if (value.type === 'closed') {
      this.forgetRoom();
      this.stop();
      this.patch({ ...emptySnapshot(), status: 'error', statusMessage: 'The room was closed by its owner.' });
    }
  }

  private patch(update: Partial<RoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}

export type { MessageKind };
export { inviteFromLocation };

// Whether this server has Discord sign-in, and who (if anyone) is signed in.
export async function discordStatus(): Promise<{ enabled: boolean; name: string }> {
  try {
    const response = await fetch('/auth/me', { credentials: 'same-origin' });
    const data: unknown = await response.json();
    if (!isRecord(data)) return { enabled: false, name: '' };
    const user = isRecord(data.user) && typeof data.user.name === 'string' ? data.user.name : '';
    return { enabled: data.enabled === true, name: user };
  } catch {
    return { enabled: false, name: '' };
  }
}
