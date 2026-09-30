export type RoomRole = 'host' | 'guest';
export type RoomStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'error';
export type MessageKind = 'chat' | 'ai' | 'system';

// Owner made the room. Admins help run it. Members work. Viewers can only watch.
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface RoomSettings {
  membersCanCreateChannels: boolean;
  membersCanDeleteFiles: boolean;
  newPeopleStartAsViewers: boolean;
}

// Someone who was removed from the room. Owner and admins can let them back in.
export interface BanEntry {
  id: string;
  name: string;
  at: string;
}

// Who did something. A snapshot, so it still reads right after that person leaves.
export interface Actor {
  id: string;
  name: string;
  color: string;
}

// Something an actor did, and when. Reusable for anything in the room that needs
// a creator or a last-touched marker (channels now; files, tasks, assets later).
export interface Activity {
  by: Actor;
  at: string;
}

export interface Channel {
  id: string;
  name: string;
  created: Activity;
  last: Activity | null;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  kind: MessageKind;
  text: string;
  createdAt: string;
}

export interface RoomMember {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  joinedAt: string;
  where: string;
  role: Role;
  agent: boolean;
}

// Live pointer position, normalized 0..1 across the window. x < 0 means hidden.
export interface CursorUpdate {
  id: string;
  x: number;
  y: number;
}

export interface OpenFile {
  path: string;
  editedBy: string;
}

export type GitState = 'off' | 'opening' | 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface GitStatus {
  state: GitState;
  message: string;
  url: string;
  branch: string;
  base: string;
  propose: string;
}

export interface FileVersion {
  sha: string;
  at: string;
  author: string;
  subject: string;
}

export interface TrashItem {
  path: string;
  by: string;
  at: string;
}

export interface RoomSnapshot {
  role: RoomRole | null;
  status: RoomStatus;
  statusMessage: string;
  roomId: string;
  roomName: string;
  roomCode: string;
  myId: string;
  inviteLink: string;
  channels: Channel[];
  messages: ChatMessage[];
  members: RoomMember[];
  files: string[];
  file: OpenFile | null;
  git: GitStatus;
  notice: string;
  previewRev: number;
  history: { path: string; versions: FileVersion[] } | null;
  trash: TrashItem[];
  myRole: Role;
  can: string[];
  settings: RoomSettings;
  bans: BanEntry[];
  noticeSeq: number;
}

// Last room this browser was in, kept so it can be reopened.
export interface SavedRoom {
  roomId: string;
  inviteKey: string;
  roomName: string;
  name: string;
  clientId: string;
}
