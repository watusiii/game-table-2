import { EditorView } from '@codemirror/view';
import { editableCompartment, showRemoteCarets } from './editor';
import type { DrawnCaret } from './carets';
import type { FileSession } from './collab';
import { kindOf, renderMedia } from './media';
import { cleanColor, discordStatus, inviteFromLocation, parseRepoInput, RoomClient } from './room';
import type { Channel, ChatMessage, FileVersion, GitState, Role, RoomMember, RoomSnapshot, SlashCommand } from './types';

interface RoomUi {
  roomName: HTMLElement;
  roomCode: HTMLElement;
  status: HTMLElement;
  inviteButton: HTMLButtonElement;
  channelList: HTMLElement;
  channelTitle: HTMLElement;
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  membersTitle: HTMLElement;
  memberList: HTMLElement;
  cursors: HTMLElement;
  fileList: HTMLElement;
  chatParts: HTMLElement[];
  filePane: HTMLElement;
  fileTitle: HTMLElement;
  fileNotice: HTMLElement;
  fileContainer: HTMLElement;
  mediaPane: HTMLElement;
  repoLink: HTMLAnchorElement;
  previewButton: HTMLButtonElement;
  previewPane: HTMLElement;
  previewFrame: HTMLIFrameElement;
  previewEmpty: HTMLElement;
  disconnectButton: HTMLButtonElement;
  connectForm: HTMLFormElement;
  connectNote: HTMLElement;
  sideNotice: HTMLElement;
  addFileForm: HTMLFormElement;
  historyButton: HTMLButtonElement;
  historyPanel: HTMLElement;
  trashHeading: HTMLElement;
  trashList: HTMLElement;
  authorsButton: HTMLButtonElement;
  authorLegend: HTMLElement;
  branchLine: HTMLElement;
  proposeLink: HTMLAnchorElement;
  addChannelForm: HTMLFormElement;
  settingsBox: HTMLElement;
  membersCanCreate: HTMLInputElement;
  toast: HTMLElement;
  membersCanDelete: HTMLInputElement;
  newPeopleViewers: HTMLInputElement;
  discordServer: HTMLInputElement;
  discordLink: HTMLButtonElement;
  bansBox: HTMLElement;
  bansList: HTMLElement;
  restoreAllButton: HTMLButtonElement;
}

const room = new RoomClient();
let current: RoomSnapshot = room.getSnapshot();
let ui: RoomUi | null = null;
let activeChannelId = '';
let renderedKey = '';
let showFile = false;
// A picture, sound or other non-text file being looked at (the editor is closed while this is set).
let mediaPath = '';
let renderedMediaKey = '';
let announcedWhere = '';
let showPreview = false;
let autoJoinedFromDiscord = false;
let autoReload = true;
let loadedPreviewRev = -1;
let loadedPreviewUrl = '';
let boundSession: FileSession | null = null;
let renderedHistory: RoomSnapshot['history'] = null;
let showAuthors = true;
let shownNoticeSeq = 0;
let renderedMembersKey = '';
let toastTimer: number | undefined;
const cursorEls = new Map<string, { element: HTMLElement; timer: number }>();

// Whether the server lets you do something. The server checks too; this just keeps the screen honest.
function can(action: string): boolean {
  return current.can.includes(action);
}

function showToast(view: RoomUi, message: string): void {
  view.toast.textContent = message;
  view.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    view.toast.hidden = true;
  }, 4_500);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(text: string, onClick?: () => void): HTMLButtonElement {
  const element = el('button', '', text);
  element.type = 'button';
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

function field(label: string, input: HTMLElement): HTMLLabelElement {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label), input);
  return wrap;
}

function textInput(placeholder: string, value = '', maxLength = 120): HTMLInputElement {
  const input = el('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value;
  input.maxLength = maxLength;
  return input;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function parseInvite(value: string): { roomId: string; inviteKey: string } | null {
  try {
    const url = new URL(value.trim(), window.location.href);
    const params = new URLSearchParams(url.hash.slice(1) || url.search);
    const roomId = params.get('room')?.trim() ?? '';
    const inviteKey = params.get('key')?.trim() ?? '';
    return roomId && inviteKey ? { roomId, inviteKey } : null;
  } catch {
    return null;
  }
}

/* ---------- Gate: create or join ---------- */

function renderGate(root: HTMLDivElement, snapshot: RoomSnapshot): void {
  root.replaceChildren();
  const gate = el('main', 'gate');
  gate.append(el('h1', '', 'GAME TABLE 2'), el('p', 'muted', 'A shared room for making things together.'));

  if (snapshot.status === 'error' && snapshot.statusMessage) {
    gate.append(el('p', 'error', snapshot.statusMessage));
  }

  const incoming = inviteFromLocation();
  const saved = RoomClient.savedRoom();

  if (saved && !incoming) {
    const card = el('section', 'card');
    card.append(el('h2', '', 'Resume'), el('p', '', saved.roomName + ' · as ' + saved.name));
    card.append(button('RESUME ROOM', () => room.resumeRoom()));
    gate.append(card);
  }

  if (!incoming) {
    const card = el('form', 'card');
    const roomName = textInput('Room name', '', 56);
    roomName.required = true;
    const repoInput = textInput('owner/repo or GitHub link (optional)', '', 200);
    repoInput.addEventListener('input', () => {
      repoInput.setCustomValidity('');
      // With a repo, the room can be named after it.
      roomName.required = repoInput.value.trim() === '';
    });
    const yourName = textInput('Your name', RoomClient.savedName(), 28);
    yourName.required = true;
    const submit = el('button', '', 'CREATE ROOM');
    submit.type = 'submit';
    card.append(
      el('h2', '', 'Create'),
      field('Room name', roomName),
      field('GitHub repo (optional)', repoInput),
      field('Your name', yourName),
      submit,
    );
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      if (repoInput.value.trim() && !parseRepoInput(repoInput.value)) {
        repoInput.setCustomValidity('Use owner/name or a github.com link.');
        repoInput.reportValidity();
        return;
      }
      RoomClient.saveName(yourName.value);
      room.createRoom(roomName.value, yourName.value, repoInput.value);
    });
    gate.append(card);
  }

  const joinCard = el('form', 'card');
  const invite = textInput('Paste invite link', incoming?.inviteKey ? window.location.href : '', 1_200);
  invite.required = true;
  invite.addEventListener('input', () => invite.setCustomValidity(''));
  const joinName = textInput('Your name', RoomClient.savedName(), 28);
  joinName.required = true;
  const joinSubmit = el('button', '', 'JOIN ROOM');
  joinSubmit.type = 'submit';
  joinCard.append(el('h2', '', 'Join'), field('Invite link', invite), field('Your name', joinName), joinSubmit);
  joinCard.addEventListener('submit', (event) => {
    event.preventDefault();
    const details = parseInvite(invite.value);
    if (!details) {
      invite.setCustomValidity('That is not a full invite link.');
      invite.reportValidity();
      return;
    }
    invite.setCustomValidity('');
    RoomClient.saveName(joinName.value);
    room.joinRoom(details.roomId, details.inviteKey, joinName.value);
  });
  gate.append(joinCard);

  // Sign in with Discord, if this server has it. A link with no key works for people in the room's Discord server.
  void discordStatus().then((status) => {
    if (!status.enabled || !gate.isConnected) return;
    const card = el('section', 'card');
    card.append(el('h2', '', 'Discord'));
    if (status.name) {
      card.append(el('p', '', 'Signed in as ' + status.name + '.'), button('SIGN OUT', () => {
        window.location.href = '/auth/logout';
      }));
      if (incoming && !incoming.inviteKey && !autoJoinedFromDiscord) {
        autoJoinedFromDiscord = true;
        room.joinRoom(incoming.roomId, '', status.name);
      }
    } else {
      card.append(
        el('p', '', 'Use your Discord account instead of an invite link.'),
        button('JOIN WITH DISCORD', () => {
          window.location.href = '/auth/discord' + (incoming ? '?room=' + encodeURIComponent(incoming.roomId) : '');
        }),
      );
    }
    gate.prepend(card);
  });

  root.append(gate);
}

/* ---------- Room: channels | messages | members ---------- */

// Drag the edge of a side panel to size it, drag it nearly shut (or double-click, or press the arrow) to fold it away.
// Sizes are remembered in this browser.
const PANEL_MIN = 140;
const PANEL_MAX = 560;
const PANEL_DEFAULT = { side: 240, members: 200 };

function addPanelResizers(app: HTMLElement, stage: HTMLElement): void {
  const clamp = (value: number): number => Math.min(Math.max(value, PANEL_MIN), PANEL_MAX);

  // Sidebar resizers
  (['side', 'members'] as const).forEach((name) => {
    const left = name === 'side';
    let width = PANEL_DEFAULT[name];
    let closed = false;
    const handle = el('div', 'resizer resizer-' + name);
    const toggle = button('', () => {
      closed = !closed;
      apply();
    });
    toggle.classList.add('panel-toggle');
    handle.append(toggle);
    const apply = (): void => {
      app.style.setProperty('--' + name + '-w', closed ? '0px' : width + 'px');
      app.classList.toggle('no-' + name, closed);
      toggle.textContent = left !== closed ? '\u2039' : '\u203a';
      toggle.title = closed ? 'Show panel' : 'Hide panel';
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.target === toggle) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const move = (moved: PointerEvent): void => {
        const box = app.getBoundingClientRect();
        const next = left ? moved.clientX - box.left : box.right - moved.clientX;
        closed = next < 80;
        if (!closed) width = clamp(next);
        apply();
      };
      const stop = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
    });
    handle.addEventListener('dblclick', (event) => {
      if (event.target === toggle) return;
      closed = !closed;
      apply();
    });
    apply();
    app.append(handle);
  });

  // Preview pane resizer
  let previewWidth = 400; // pixels
  const previewHandle = el('div', 'resizer resizer-preview');
  const applyPreview = (): void => {
    stage.style.setProperty('--preview-w', previewWidth + 'px');
  };
  previewHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    previewHandle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => {
      const box = stage.getBoundingClientRect();
      const next = box.right - moved.clientX;
      previewWidth = Math.min(Math.max(next, 200), 800);
      applyPreview();
    };
    const stop = (): void => {
      previewHandle.removeEventListener('pointermove', move);
      previewHandle.removeEventListener('pointerup', stop);
    };
    previewHandle.addEventListener('pointermove', move);
    previewHandle.addEventListener('pointerup', stop);
  });
  applyPreview();
  stage.append(previewHandle);
}

function buildRoom(root: HTMLDivElement, snapshot: RoomSnapshot): RoomUi {
  root.replaceChildren();
  const app = el('div', 'app');

  // Left: room + channels
  const side = el('aside', 'side');
  const roomName = el('h2', 'room-name');
  const roomCode = el('div', 'muted');
  const status = el('div', 'status');
  const inviteButton = button('COPY INVITE', () => void copyInvite(inviteButton));
  const isHost = snapshot.role === 'host';
  const leaveButton = button(isHost ? 'CLOSE ROOM' : 'LEAVE', () => {
    if (isHost) {
      // Closing deletes the room for everyone, so make it hard to do by accident.
      const typed = window.prompt(
        'This closes the room for everyone and removes its chat.\nTo confirm, type the room name: ' + current.roomName,
      );
      if (typed === null || typed.trim() !== current.roomName) return;
    }
    room.closeRoom();
  });
  const roomActions = el('div', 'row');
  roomActions.append(inviteButton, leaveButton);

  const channelList = el('div', 'channels');
  const addChannel = el('form', 'row');
  const channelInput = textInput('new-channel', '', 32);
  const addButton = el('button', '', '+');
  addButton.type = 'submit';
  addChannel.append(channelInput, addButton);
  addChannel.addEventListener('submit', (event) => {
    event.preventDefault();
    if (room.createChannel(channelInput.value)) channelInput.value = '';
  });

  const previewButton = button('\u25b6 PREVIEW GAME', () => {
    showPreview = !showPreview;
    if (ui) updateRoom(ui, current);
  });
  const fileList = el('div', 'channels');
  const repoLink = el('a', 'repo-link', 'OPEN REPO ON GITHUB \u2197');
  repoLink.target = '_blank';
  repoLink.rel = 'noreferrer';
  repoLink.hidden = true;
  const disconnectButton = button('DISCONNECT REPO', () => {
    if (window.confirm('Disconnect this repo from the room? Its files stay on GitHub.')) room.disconnectRepo();
  });
  const connectForm = el('form', 'row');
  const connectInput = textInput('owner/repo or GitHub link', '', 200);
  const connectButton = el('button', '', 'CONNECT');
  connectButton.type = 'submit';
  connectForm.append(connectInput, connectButton);
  connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = parseRepoInput(connectInput.value);
    if (
      url &&
      !window.confirm(
        'Connect ' + url.replace('https://github.com/', '').replace(/\.git$/, '') +
          '?\nThe room will save its edits to that repo, under your GitHub login.',
      )
    ) {
      return;
    }
    if (room.connectRepo(connectInput.value)) connectInput.value = '';
  });
  const connectNote = el('div', 'muted', 'Ask the room owner to connect a GitHub repo.');
  const sideNotice = el('div', 'side-notice');
  const branchLine = el('div', 'muted branch-line');
  branchLine.hidden = true;
  const proposeLink = el('a', 'repo-link');
  proposeLink.target = '_blank';
  proposeLink.rel = 'noreferrer';
  proposeLink.hidden = true;
  const trashHeading = el('h3', '', 'RECENTLY DELETED');
  trashHeading.hidden = true;
  const restoreAllButton = button('RESTORE ALL', () => {
    if (window.confirm('Bring back every file in Recently deleted?')) room.undeleteAll();
  });
  restoreAllButton.hidden = true;
  const trashList = el('div', 'channels');
  const addFile = el('form', 'row');
  const fileInput = textInput('notes.md', '', 80);
  const addFileButton = el('button', '', '+');
  addFileButton.type = 'submit';
  addFile.append(fileInput, addFileButton);
  addFile.addEventListener('submit', (event) => {
    event.preventDefault();
    const path = fileInput.value.trim();
    if (path && room.createFile(path)) {
      fileInput.value = '';
      openFileView(path);
    }
  });

  side.append(
    roomName,
    roomCode,
    status,
    roomActions,
    el('h3', '', 'CHANNELS'),
    channelList,
    addChannel,
    el('h3', '', 'FILES (SAVED TO GITHUB)'),
    repoLink,
    branchLine,
    proposeLink,
    disconnectButton,
    connectForm,
    connectNote,
    sideNotice,
    fileList,
    addFile,
    trashHeading,
    restoreAllButton,
    trashList,
    el('h3', '', 'GAME'),
    previewButton,
  );

  // Middle: channel
  const main = el('main', 'main');
  const channelTitle = el('header', 'bar');
  const messages = el('div', 'messages');
  const composer = el('form', 'composer');
  const input = el('textarea');
  input.rows = 2;
  input.maxLength = 2_000;
  input.placeholder = 'Say something. Enter sends, Shift+Enter adds a line.';
  const sendButton = el('button', '', 'SEND');
  sendButton.type = 'submit';
  // Typing / shows the commands you can run. Tab or a click fills one in.
  const slashMenu = el('div', 'slash-menu');
  slashMenu.hidden = true;
  const slashMatches = (): SlashCommand[] => {
    const typed = /^\/([a-z]*)$/i.exec(input.value)?.[1].toLowerCase();
    return typed === undefined ? [] : current.commands.filter((command) => command.name.startsWith(typed));
  };
  const fillCommand = (command: SlashCommand): void => {
    input.value = '/' + command.name + (command.args ? ' ' : '');
    slashMenu.hidden = true;
    input.focus();
  };
  const refreshSlashMenu = (): void => {
    const matches = slashMatches();
    slashMenu.replaceChildren(
      ...matches.map((command) => {
        const row = el('button', 'slash-row', '/' + command.name + (command.args ? ' ' + command.args : '') + ' \u2014 ' + command.help);
        row.type = 'button';
        row.addEventListener('mousedown', (event) => {
          event.preventDefault();
          fillCommand(command);
        });
        return row;
      }),
    );
    slashMenu.hidden = !matches.length;
  };
  input.addEventListener('input', refreshSlashMenu);
  input.addEventListener('blur', () => {
    slashMenu.hidden = true;
  });
  composer.append(slashMenu, input, sendButton);
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    slashMenu.hidden = true;
    if (activeChannelId && room.sendMessage(input.value, activeChannelId)) input.value = '';
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !slashMenu.hidden) {
      event.preventDefault();
      const first = slashMatches()[0];
      if (first) fillCommand(first);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  const filePane = el('div', 'file-pane');
  const fileTitle = el('header', 'bar');
  const fileNotice = el('div', 'file-notice');
  const fileContainer = el('div', 'file-editor');
  const fileWrap = el('div', 'file-wrap');
  const mediaPane = el('div', 'media-pane');
  mediaPane.style.display = 'none';
  fileWrap.append(fileContainer, mediaPane);
  const historyButton = button('HISTORY', () => {
    if (current.history) room.closeHistory();
    else if (current.file) room.requestHistory(current.file.path);
  });
  historyButton.hidden = true;
  const authorsButton = button('AUTHOR COLORS', () => {
    showAuthors = !showAuthors;
    if (ui) updateRoom(ui, current);
  });
  authorsButton.hidden = true;
  const authorLegend = el('div', 'legend');
  const fileTools = el('div', 'file-tools');
  fileTools.append(historyButton, authorsButton, authorLegend);
  const historyPanel = el('div', 'history');
  historyPanel.hidden = true;
  filePane.append(fileTitle, fileTools, historyPanel, fileNotice, fileWrap);

  main.append(channelTitle, messages, composer, filePane);

  // Right: members
  const membersSide = el('aside', 'members');
  const membersTitle = el('h3');
  const memberList = el('div');

  // Owner only: room-wide controls.
  const settingsBox = el('div', 'settings-box');
  settingsBox.hidden = true;
  const canCreateBox = el('input');
  canCreateBox.type = 'checkbox';
  canCreateBox.addEventListener('change', () => room.setSetting('membersCanCreateChannels', canCreateBox.checked));
  const canCreateLabel = el('label', 'auto-reload');
  canCreateLabel.append(canCreateBox, document.createTextNode(' MEMBERS CAN CREATE CHANNELS'));
  const newInviteButton = button('NEW INVITE LINK', () => {
    if (window.confirm('Make a new invite link? Old links stop working. People already in the room stay.')) {
      room.resetInvite();
    }
  });
  // A checkbox that changes one room setting.
  const setting = (name: 'membersCanCreateChannels' | 'membersCanDeleteFiles' | 'newPeopleStartAsViewers', text: string) => {
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => room.setSetting(name, box.checked));
    const label = el('label', 'auto-reload');
    label.append(box, document.createTextNode(' ' + text));
    return { box, label };
  };
  const canDelete = setting('membersCanDeleteFiles', 'MEMBERS CAN DELETE FILES');
  const newViewers = setting('newPeopleStartAsViewers', 'NEW PEOPLE JOIN AS VIEWERS');
  // Let a whole Discord server in without invite links: people sign in with Discord and open the link below.
  const guildInput = textInput('Discord server ID (optional)', '', 20);
  guildInput.addEventListener('change', () => room.setDiscordServer(guildInput.value));
  const discordLinkButton = button('COPY DISCORD LINK', () => {
    const link = window.location.origin + '/#room=' + encodeURIComponent(current.roomId);
    navigator.clipboard.writeText(link).then(
      () => {
        discordLinkButton.textContent = 'COPIED';
        window.setTimeout(() => {
          discordLinkButton.textContent = 'COPY DISCORD LINK';
        }, 1_500);
      },
      () => window.prompt('Copy the Discord link:', link),
    );
  });
  settingsBox.append(
    el('h3', '', 'ROOM SETTINGS'),
    canCreateLabel,
    canDelete.label,
    newViewers.label,
    field('Discord server', guildInput),
    discordLinkButton,
    newInviteButton,
  );

  // People who were removed. Owner and admins can let them back in.
  const bansBox = el('div', 'settings-box');
  bansBox.hidden = true;
  const bansList = el('div');
  bansBox.append(el('h3', '', 'REMOVED PEOPLE'), bansList);
  membersSide.append(membersTitle, memberList, settingsBox, bansBox);

  const toast = el('div', 'toast');
  toast.hidden = true;

  const cursors = el('div', 'cursors');

  // Right of the chat/editor: the running game, in a locked-down frame that cannot reach the room.
  const previewPane = el('aside', 'preview-pane');
  previewPane.hidden = true;
  const previewBar = el('header', 'bar preview-bar');
  const autoBox = el('input');
  autoBox.type = 'checkbox';
  autoBox.checked = autoReload;
  autoBox.addEventListener('change', () => {
    autoReload = autoBox.checked;
    if (ui) updateRoom(ui, current);
  });
  const autoLabel = el('label', 'auto-reload');
  autoLabel.append(autoBox, document.createTextNode(' AUTO-RELOAD'));
  previewBar.append(
    el('span', '', '\u25b6 GAME'),
    button('RELOAD', reloadPreview),
    button('OPEN IN TAB \u2197', () => {
      const url = room.previewUrl();
      if (url) window.open(url, '_blank', 'noopener');
    }),
    autoLabel,
  );
  const previewEmpty = el('div', 'preview-empty');
  previewEmpty.append(
    el('p', '', 'No index.html in the repo yet. The preview runs that file.'),
    button('CREATE STARTER GAME', () => {
      room.createStarter();
    }),
  );
  const previewFrame = el('iframe', 'preview-frame');
  previewFrame.title = 'Game preview';
  previewFrame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  previewFrame.allow = 'fullscreen; gamepad';
  previewFrame.referrerPolicy = 'no-referrer';
  previewPane.append(previewBar, previewEmpty, previewFrame);

  const stage = el('div', 'stage');
  stage.append(main, previewPane);
  app.append(side, stage, membersSide, cursors, toast);
  addPanelResizers(app, stage);
  root.append(app);

  return {
    roomName,
    roomCode,
    status,
    inviteButton,
    channelList,
    channelTitle,
    messages,
    input,
    sendButton,
    membersTitle,
    memberList,
    cursors,
    fileList,
    chatParts: [channelTitle, messages, composer],
    filePane,
    fileTitle,
    fileNotice,
    fileContainer,
    mediaPane,
    repoLink,
    previewButton,
    previewPane,
    previewFrame,
    previewEmpty,
    disconnectButton,
    connectForm,
    connectNote,
    sideNotice,
    addFileForm: addFile,
    historyButton,
    historyPanel,
    trashHeading,
    trashList,
    authorsButton,
    authorLegend,
    branchLine,
    proposeLink,
    addChannelForm: addChannel,
    settingsBox,
    membersCanCreate: canCreateBox,
    toast,
    membersCanDelete: canDelete.box,
    newPeopleViewers: newViewers.box,
    discordServer: guildInput,
    discordLink: discordLinkButton,
    bansBox,
    bansList,
    restoreAllButton,
  };
}

async function copyInvite(target: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(current.inviteLink);
    target.textContent = 'COPIED';
    window.setTimeout(() => {
      target.textContent = 'COPY INVITE';
    }, 1_500);
  } catch {
    window.prompt('Copy the invite link:', current.inviteLink);
  }
}

function updateRoom(view: RoomUi, snapshot: RoomSnapshot): void {
  view.roomName.textContent = snapshot.roomName || 'CONNECTING…';
  view.roomCode.textContent = snapshot.roomCode ? 'CODE ' + snapshot.roomCode : '';
  view.status.textContent = snapshot.status === 'online' ? 'LIVE' : snapshot.statusMessage || snapshot.status.toUpperCase();
  view.status.classList.toggle('bad', snapshot.status === 'error' || snapshot.status === 'offline');
  view.inviteButton.disabled = !snapshot.inviteLink;

  // What this person is allowed to do decides what they see.
  view.addChannelForm.hidden = !can('channels:create');
  view.settingsBox.hidden = snapshot.myRole !== 'owner';
  view.membersCanCreate.checked = snapshot.settings.membersCanCreateChannels;
  view.membersCanDelete.checked = snapshot.settings.membersCanDeleteFiles;
  view.newPeopleViewers.checked = snapshot.settings.newPeopleStartAsViewers;
  if (document.activeElement !== view.discordServer) view.discordServer.value = snapshot.settings.discordGuildId;
  view.discordLink.hidden = !snapshot.settings.discordGuildId;
  view.bansBox.hidden = !can('members:kick') || !snapshot.bans.length;
  view.bansList.replaceChildren(
    ...snapshot.bans.map((ban) => {
      const row = el('div', 'history-row');
      row.append(el('span', '', ban.name), button('LET BACK IN', () => room.unban(ban.id)));
      return row;
    }),
  );
  view.input.placeholder = can('chat')
    ? 'Say something. Enter sends, Shift+Enter adds a line.'
    : 'You have read-only access in this room.';
  if (snapshot.noticeSeq !== shownNoticeSeq) {
    shownNoticeSeq = snapshot.noticeSeq;
    if (snapshot.notice) showToast(view, snapshot.notice);
  }

  if (!snapshot.channels.some((channel) => channel.id === activeChannelId)) {
    activeChannelId = snapshot.channels[0]?.id ?? '';
    renderedKey = '';
  }

  renderChannels(view, snapshot);
  renderMessages(view, snapshot);
  renderMembers(view, snapshot);
  renderFiles(view, snapshot);
  renderPreview(view, snapshot);
  pruneCursors(snapshot);
  view.chatParts.forEach((part) => {
    part.hidden = showFile;
  });
  view.filePane.hidden = !showFile;

  // Tell the room where we are, so others see it in the member list and beside the channel or file.
  const where = showFile
    ? snapshot.file ? 'file:' + snapshot.file.path : mediaPath ? 'file:' + mediaPath : ''
    : activeChannelId ? 'channel:' + activeChannelId : '';
  if (where && where !== announcedWhere) {
    announcedWhere = where;
    room.setLocation(where);
  }

  refreshCursorAway();

  const canSend = snapshot.status === 'online' && Boolean(activeChannelId) && can('chat');
  view.input.disabled = !canSend;
  view.sendButton.disabled = !canSend;
}

function renderChannels(view: RoomUi, snapshot: RoomSnapshot): void {
  view.channelList.replaceChildren();
  snapshot.channels.forEach((channel) => {
    const item = button('# ' + channel.name, () => {
      activeChannelId = channel.id;
      showFile = false;
      renderedKey = '';
      updateRoom(view, current);
    });
    item.classList.add('channel');
    item.classList.toggle('active', !showFile && channel.id === activeChannelId);
    const name = el('span', 'channel-name', '# ' + channel.name);
    appendPresence(name, snapshot, 'channel:' + channel.id);
    const last = el(
      'small',
      'channel-last',
      channel.last ? channel.last.by.name + ' \u00b7 ' + formatTime(channel.last.at) : 'no messages yet',
    );
    item.replaceChildren(name, last);
    item.title = channelInfo(channel);
    // Owner and admins can delete channels (never the first one).
    const row = el('div', 'file-row');
    row.append(item);
    if (can('channels:manage') && snapshot.channels.indexOf(channel) > 0) {
      const remove = button('\u00d7', () => {
        if (window.confirm('Delete #' + channel.name + ' and its messages? A copy is kept on the server.')) {
          room.deleteChannel(channel.id);
        }
      });
      remove.classList.add('remove');
      remove.title = 'Delete #' + channel.name;
      row.append(remove);
    }
    view.channelList.append(row);
  });
  const active = snapshot.channels.find((channel) => channel.id === activeChannelId);
  view.channelTitle.textContent = active ? '# ' + active.name + ' \u00b7 ' + channelInfo(active) : '';
}

// Who made a channel and who spoke last, as text.
function channelInfo(channel: Channel): string {
  const made = 'created by ' + channel.created.by.name;
  return channel.last
    ? made + ' \u00b7 last message by ' + channel.last.by.name + ' at ' + formatTime(channel.last.at)
    : made + ' \u00b7 no messages yet';
}

/* ---------- Game preview ---------- */

function reloadPreview(): void {
  loadedPreviewRev = -1;
  if (ui) updateRoom(ui, current);
}

// Runs the repo's index.html inside the frame, and reloads it when the files change.
function renderPreview(view: RoomUi, snapshot: RoomSnapshot): void {
  view.previewButton.classList.toggle('active', showPreview);
  view.previewPane.hidden = !showPreview;
  if (!showPreview) return;

  const hasIndex = snapshot.files.includes('index.html');
  view.previewEmpty.hidden = hasIndex;
  view.previewFrame.hidden = !hasIndex;
  const url = room.previewUrl();
  if (!hasIndex || !url) {
    loadedPreviewRev = -1;
    return;
  }
  const changed = autoReload && loadedPreviewRev !== snapshot.previewRev;
  if (loadedPreviewRev === -1 || loadedPreviewUrl !== url || changed) {
    loadedPreviewRev = snapshot.previewRev;
    loadedPreviewUrl = url;
    view.previewFrame.src = url + '?v=' + Date.now();
  }
}

// Where a member is, as text: "# general" or a file name.
function whereLabel(snapshot: RoomSnapshot, where: string): string {
  if (where.startsWith('channel:')) {
    const channel = snapshot.channels.find((candidate) => candidate.id === where.slice(8));
    return channel ? '# ' + channel.name : '';
  }
  if (where.startsWith('file:')) return where.slice(5);
  return '';
}

function presentAt(snapshot: RoomSnapshot, where: string): RoomMember[] {
  return snapshot.members.filter((member) => member.where === where && member.id !== snapshot.myId);
}

// Small colored dots beside a channel or file for each other person who is in it.
function appendPresence(item: HTMLElement, snapshot: RoomSnapshot, where: string): void {
  presentAt(snapshot, where).forEach((member) => {
    const marker = dot(member.color);
    marker.classList.add('small');
    marker.title = member.name;
    item.append(marker);
  });
}

function hereLabel(snapshot: RoomSnapshot, where: string): string {
  const names = presentAt(snapshot, where).map((member) => member.name);
  return names.length ? ' \u00b7 also here: ' + names.join(', ') : '';
}

// The saved versions of a file, each with a way back to it.
function renderHistory(panel: HTMLElement, path: string, versions: FileVersion[]): void {
  panel.replaceChildren(el('div', 'muted', 'SAVED VERSIONS, NEWEST FIRST'));
  if (!versions.length) {
    panel.append(el('div', '', 'No saved versions yet. One is saved to GitHub a few seconds after typing stops.'));
    return;
  }
  versions.forEach((version) => {
    const when = new Date(version.at);
    const label = Number.isNaN(when.getTime())
      ? version.at
      : when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const row = el('div', 'history-row');
    row.append(
      el('span', '', label + ' \u00b7 ' + version.author),
      button('RESTORE', () => {
        const ok = window.confirm(
          'Replace ' + path + ' with the version from ' + label + ' by ' + version.author +
            '?\nEveryone sees the change. What you replace stays in history.',
        );
        if (!ok) return;
        room.restoreVersion(path, version.sha);
        room.closeHistory();
      }),
    );
    if (!can('files:restore')) row.querySelector('button')?.remove();
    panel.append(row);
  });
}

const GIT_LABELS: Record<GitState, string> = {
  off: 'GITHUB OFF',
  opening: 'OPENING REPO\u2026',
  idle: 'GITHUB READY',
  pending: 'UNSAVED…',
  saving: 'SAVING…',
  saved: 'SAVED TO GITHUB',
  error: 'GITHUB ERROR',
};

function openFileView(path: string): void {
  showFile = true;
  if (kindOf(path) === 'text') {
    mediaPath = '';
    room.openFile(path);
  } else {
    mediaPath = path;
    room.openMedia();
  }
  if (ui) updateRoom(ui, current);
}

// Folders you have folded away in the file tree. Everything else is shown.
const closedFolders = new Set<string>();

interface TreeNode {
  name: string;
  path: string;
  folders: TreeNode[];
  files: string[];
}

// Turns a flat list of paths into folders and files, folders first, each sorted by name.
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], files: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);
  [...paths].sort((a, b) => a.localeCompare(b)).forEach((path) => {
    const parts = path.split('/');
    let parent = root;
    for (let depth = 1; depth < parts.length; depth++) {
      const folderPath = parts.slice(0, depth).join('/');
      let folder = byPath.get(folderPath);
      if (!folder) {
        folder = { name: parts[depth - 1], path: folderPath, folders: [], files: [] };
        byPath.set(folderPath, folder);
        parent.folders.push(folder);
      }
      parent = folder;
    }
    parent.files.push(path);
  });
  return root;
}

function renderFiles(view: RoomUi, snapshot: RoomSnapshot): void {
  const connected = Boolean(snapshot.git.url);
  const isOwner = snapshot.role === 'host';
  view.fileList.className = 'tree';
  view.fileList.replaceChildren();
  const openPath = snapshot.file?.path ?? '';
  const rows = document.createDocumentFragment();
  const tag = (text: string): HTMLElement => el('span', 'tree-prefix', text);
  // Draws like the `tree` command. Folders open by default; click one to fold it away.
  const addNode = (node: TreeNode, prefix: string): void => {
    const entries = [
      ...node.folders.map((folder) => ({ name: folder.name, folder, path: '' })),
      ...node.files.map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), folder: null, path })),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      const branch = tag(prefix + (last ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '));
      const row = el('div', 'tree-row');
      if (entry.folder) {
        const folder = entry.folder;
        const folded = closedFolders.has(folder.path);
        const toggle = button(entry.name + (folded ? '/ \u2026' : '/'), () => {
          if (closedFolders.has(folder.path)) closedFolders.delete(folder.path);
          else closedFolders.add(folder.path);
          renderFiles(view, current);
        });
        toggle.classList.add('tree-name');
        toggle.title = folder.path;
        row.append(branch, toggle);
        rows.append(row);
        if (!folded) addNode(folder, prefix + (last ? '    ' : '\u2502   '));
        return;
      }
      const path = entry.path;
      const item = button(entry.name, () => openFileView(path));
      item.classList.add('tree-name');
      item.title = path;
      item.classList.toggle('active', showFile && (openPath === path || mediaPath === path));
      appendPresence(item, snapshot, 'file:' + path);
      const remove = button('\u00d7', () => {
        if (window.confirm('Delete ' + path + '? It is removed from GitHub too, though GitHub keeps its history.')) {
          room.deleteFile(path);
        }
      });
      remove.classList.add('tree-x');
      remove.title = 'Delete ' + path;
      remove.hidden = !can('files:delete') || kindOf(path) !== 'text';
      row.append(branch, item, remove);
      rows.append(row);
    });
  };
  const folderCount = new Set(snapshot.files.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/')))).size;
  if (snapshot.files.length) rows.append(el('div', 'tree-root', '.'));
  addNode(buildTree(snapshot.files), '');
  if (snapshot.files.length) rows.append(el('div', 'tree-root', folderCount + ' folder' + (folderCount === 1 ? '' : 's') + ', ' + snapshot.files.length + ' file' + (snapshot.files.length === 1 ? '' : 's')));
  view.fileList.append(rows);
  if (connected && !snapshot.files.length) {
    view.fileList.append(el('div', 'muted', snapshot.git.state === 'opening' ? 'Opening repo\u2026' : 'No files yet.'));
  }
  // Only the owner can connect or disconnect a repo. Everyone sees the state.
  view.disconnectButton.hidden = !(connected && isOwner);
  view.connectForm.hidden = connected || !isOwner;
  view.connectNote.hidden = connected || isOwner;
  view.addFileForm.hidden = !connected || !can('files:create');

  // Edits go to a branch of the room's own. Proposing sends them to main for review on GitHub.
  const git0 = snapshot.git;
  view.branchLine.hidden = !connected || !git0.branch;
  view.branchLine.textContent =
    'Saving to branch ' + git0.branch + (git0.base ? '. Main only changes when a proposal is accepted.' : '.');
  view.proposeLink.hidden = !git0.propose;
  if (git0.propose) {
    view.proposeLink.href = git0.propose;
    view.proposeLink.textContent = 'PROPOSE TO ' + git0.base.toUpperCase() + ' \u2197';
  }
  view.sideNotice.textContent = snapshot.notice || (snapshot.git.state === 'error' ? snapshot.git.message : '');

  // Recently deleted files, with a way back.
  view.trashHeading.hidden = !snapshot.trash.length;
  view.restoreAllButton.hidden = !snapshot.trash.length || !can('files:restore-all');
  view.trashList.replaceChildren(
    ...snapshot.trash.map((item) => {
      const row = el('div', 'file-row');
      const label = el('span', 'trash-name', item.path);
      label.title = 'Deleted by ' + item.by + ' at ' + formatTime(item.at);
      const restore = button('RESTORE', () => room.undelete(item.path));
      restore.hidden = !can('files:restore');
      row.append(label, restore);
      return row;
    }),
  );

  // Saved versions of the open file.
  const openHistory =
    snapshot.history && snapshot.file && snapshot.history.path === snapshot.file.path ? snapshot.history : null;
  view.historyButton.hidden = !snapshot.file;
  view.historyButton.classList.toggle('active', Boolean(openHistory));
  view.historyPanel.hidden = !openHistory;
  if (openHistory !== renderedHistory) {
    renderedHistory = openHistory;
    if (openHistory) renderHistory(view.historyPanel, openHistory.path, openHistory.versions);
  }

  const file = snapshot.file;
  const git = snapshot.git;
  if (mediaPath && !snapshot.files.includes(mediaPath)) mediaPath = '';
  const showingMedia = Boolean(mediaPath) && !file;
  view.fileContainer.style.display = showingMedia ? 'none' : '';
  view.mediaPane.style.display = showingMedia ? '' : 'none';
  if (showingMedia) {
    const key = mediaPath + '|' + snapshot.files.length + '|' + snapshot.status;
    if (key !== renderedMediaKey) {
      renderedMediaKey = key;
      renderMedia(view.mediaPane, mediaPath, snapshot.files, (name) => room.fileUrl(name), openFileView);
    }
  } else {
    renderedMediaKey = '';
  }
  view.fileTitle.textContent = showingMedia
    ? mediaPath + hereLabel(snapshot, 'file:' + mediaPath)
    : file
    ? file.path +
      ' · ' +
      GIT_LABELS[git.state] +
      (file.editedBy && file.editedBy !== 'you' ? ' · last edit by ' + file.editedBy : '') +
      hereLabel(snapshot, 'file:' + file.path)
    : 'Pick a file';
  view.repoLink.hidden = !git.url;
  if (git.url) view.repoLink.href = git.url;
  view.fileNotice.textContent = snapshot.notice || (git.state === 'error' ? git.message : '');

  const session = room.getFileSession();
  if (session) session.pruneRemotes(new Set(snapshot.members.map((member) => member.id)));
  if (session !== boundSession) {
    boundSession = session;
    if (session) {
      session.attach(view.fileContainer, () => redraw(view));
    } else {
      view.fileContainer.replaceChildren();
      drawAuthors(view);
    }
  }
  if (session) {
    redraw(view);
  }

  // Update read-only state for CodeMirror editor
  const editor = session?.getEditor();
  if (editor) {
    const canEdit = snapshot.status === 'online' && can('files:edit');
    editor.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(canEdit)),
    });
  }
}

// Redraws everything painted over the editor: who wrote what, and other people's carets.
function redraw(view: RoomUi): void {
  drawAuthors(view);
  drawCarets();
}

// Colors each stretch of text by who wrote it, and lists the authors of the open file.
function drawAuthors(view: RoomUi): void {
  const session = boundSession;
  view.authorsButton.hidden = !session;
  view.authorsButton.classList.toggle('active', showAuthors);
  const segments = session && showAuthors ? session.authorSegments() : [];
  view.fileContainer.classList.toggle('no-authors', !showAuthors);
  view.authorLegend.replaceChildren();
  const seen = new Set<string>();
  for (const segment of segments) {
    if (seen.has(segment.id)) continue;
    seen.add(segment.id);
    const chip = el('span', 'legend-item');
    chip.append(dot(segment.color), document.createTextNode(' ' + segment.name));
    view.authorLegend.append(chip);
  }
}

// Everyone else's caret and selection in the open file, in their own color.
function drawCarets(): void {
  if (!boundSession) return;
  const carets: DrawnCaret[] = [];
  for (const selection of boundSession.remoteSelections()) {
    const member = current.members.find((candidate) => candidate.id === selection.id);
    if (member && member.id !== current.myId) {
      carets.push({ ...selection, name: member.name, color: member.color });
    }
  }
  showRemoteCarets(boundSession.getEditor(), carets);
}

function renderMessages(view: RoomUi, snapshot: RoomSnapshot): void {
  const list = snapshot.messages.filter((message) => message.channelId === activeChannelId);
  const last = list[list.length - 1];
  const key = activeChannelId + ':' + list.length + ':' + (last?.id ?? '');
  if (key === renderedKey) return;

  const container = view.messages;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const channelChanged = !renderedKey.startsWith(activeChannelId + ':');
  renderedKey = key;

  if (!list.length) {
    container.replaceChildren(el('div', 'muted', 'EMPTY. SAY SOMETHING.'));
    return;
  }
  container.replaceChildren(...list.map(renderMessage));
  if (nearBottom || channelChanged) container.scrollTop = container.scrollHeight;
}

function renderMessage(message: ChatMessage): HTMLElement {
  if (message.kind === 'system') {
    return el('div', 'msg system', '— ' + message.text);
  }
  const own = message.authorId === current.myId;
  const row = el('div', 'msg' + (message.kind === 'ai' ? ' ai' : '') + (own ? ' own' : ''));
  row.style.setProperty('--c', cleanColor(message.authorColor));
  const head = el('div', 'msg-head');
  head.append(
    dot(message.authorColor),
    el('span', 'who', message.authorName),
    el('span', 'time', formatTime(message.createdAt)),
  );
  row.append(head, el('div', 'msg-text', message.text));
  return row;
}

function dot(color: string): HTMLSpanElement {
  const circle = el('span', 'dot');
  circle.style.setProperty('--c', cleanColor(color));
  return circle;
}

function renderMembers(view: RoomUi, snapshot: RoomSnapshot): void {
  view.membersTitle.textContent = 'MEMBERS (' + snapshot.members.length + ')';
  // Don't rebuild the list while someone is dragging their color slider. The next update catches up.
  if (document.activeElement?.classList.contains('hue-slider')) return;
  // Rebuilding while someone is choosing a role would close their menu, so only rebuild when something changed.
  const key = JSON.stringify([snapshot.members, snapshot.myId, snapshot.myRole, snapshot.channels.map((c) => c.id + c.name)]);
  if (key === renderedMembersKey) return;
  renderedMembersKey = key;
  view.memberList.replaceChildren(
    ...snapshot.members.map((member) => {
      const tags = [
        (member.role ?? 'member') !== 'member' ? (member.role as string).toUpperCase() : '',
        member.agent ? 'AI' : '',
        member.id === snapshot.myId ? 'YOU' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const row = el('div', 'member');
      const info = el('div', 'member-info');
      info.append(el('span', '', member.name + (tags ? ' [' + tags + ']' : '')));
      const place = whereLabel(snapshot, member.where ?? '');
      if (place) info.append(el('small', 'muted', place));
      const swatch = dot(member.color);
      row.append(swatch, info);

      // Your own color: slide the hue. Saturation and lightness stay fixed so every color reads well behind text.
      if (member.id === snapshot.myId) {
        const hue = Number(/^hsl\((\d{1,3})/.exec(member.color)?.[1] ?? 0);
        const slider = el('input', 'hue-slider');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '359';
        slider.value = String(hue);
        slider.title = 'Pick your color';
        const colorAt = (value: string) => 'hsl(' + value + ' 65% 62%)';
        // Send a moment after each move. The member list can rebuild mid-drag, which would kill a 'change' event.
        let sendTimer: number | undefined;
        slider.addEventListener('input', () => {
          swatch.style.setProperty('--c', colorAt(slider.value));
          window.clearTimeout(sendTimer);
          sendTimer = window.setTimeout(() => room.setColor(colorAt(slider.value)), 150);
        });
        info.append(slider);
      }

      // Owner and admins can change roles and remove people below them.
      const mine = snapshot.myRole;
      const theirs = member.role ?? 'member';
      const touchable =
        member.id !== snapshot.myId && theirs !== 'owner' && (mine === 'owner' || (mine === 'admin' && theirs !== 'admin'));
      if (touchable && can('members:manage')) {
        const choose = el('select', 'role-select');
        const roles: Role[] = mine === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
        roles.forEach((role) => {
          const option = el('option', '', role.toUpperCase());
          option.value = role;
          option.selected = role === theirs;
          choose.append(option);
        });
        choose.addEventListener('change', () => room.setRole(member.id, choose.value));
        info.append(choose);
      }
      if (touchable && can('members:kick')) {
        info.append(
          button('REMOVE', () => {
            if (window.confirm('Remove ' + member.name + ' from the room?')) room.kick(member.id);
          }),
        );
      }
      return row;
    }),
  );
}

/* ---------- Cursors ---------- */

function removeCursor(id: string): void {
  const entry = cursorEls.get(id);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  entry.element.remove();
  cursorEls.delete(id);
}

function pruneCursors(snapshot: RoomSnapshot): void {
  const ids = new Set(snapshot.members.map((member) => member.id));
  Array.from(cursorEls.keys()).forEach((id) => {
    if (!ids.has(id)) removeCursor(id);
  });
}

// A cursor from someone looking at a different channel or file means nothing where you are, so it is shown faded.
function isAway(member: RoomMember): boolean {
  return Boolean(announcedWhere && member.where && member.where !== announcedWhere);
}

function refreshCursorAway(): void {
  cursorEls.forEach((entry, id) => {
    const member = current.members.find((candidate) => candidate.id === id);
    if (member) entry.element.classList.toggle('away', isAway(member));
  });
}

function showCursor(id: string, x: number, y: number): void {
  if (!ui || id === current.myId) return;
  if (x < 0 || y < 0) {
    removeCursor(id);
    return;
  }
  const member = current.members.find((candidate) => candidate.id === id);
  if (!member) return;
  let entry = cursorEls.get(id);
  if (!entry) {
    const element = el('div', 'cursor');
    element.style.setProperty('--c', cleanColor(member.color));
    element.append(el('span', 'cursor-arrow'), el('span', 'cursor-name', member.name));
    ui.cursors.append(element);
    entry = { element, timer: 0 };
    cursorEls.set(id, entry);
  }
  entry.element.classList.toggle('away', isAway(member));
  entry.element.style.transform = 'translate(' + x * window.innerWidth + 'px, ' + y * window.innerHeight + 'px)';
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => removeCursor(id), 4_000);
}

/* ---------- Mount ---------- */

function renderSnapshot(root: HTMLDivElement, snapshot: RoomSnapshot): void {
  current = snapshot;
  if (!snapshot.role) {
    Array.from(cursorEls.keys()).forEach((id) => removeCursor(id));
    ui = null;
    activeChannelId = '';
    renderedKey = '';
    showFile = false;
    announcedWhere = '';
    renderedMembersKey = '';
    renderedHistory = null;
    showPreview = false;
    loadedPreviewRev = -1;
    loadedPreviewUrl = '';
    boundSession = null;
    renderGate(root, snapshot);
    return;
  }
  if (!ui) {
    ui = buildRoom(root, snapshot);
    renderedKey = '';
  }
  updateRoom(ui, snapshot);
}

export function mountApp(root: HTMLDivElement): void {
  room.subscribe((snapshot) => renderSnapshot(root, snapshot));
  room.onCursor((cursor) => showCursor(cursor.id, cursor.x, cursor.y));
  document.addEventListener('pointermove', (event) => {
    if (!ui || event.pointerType === 'touch') return;
    room.sendCursor(event.clientX / window.innerWidth, event.clientY / window.innerHeight);
  });
  document.documentElement.addEventListener('mouseleave', () => room.sendCursor(-1, -1));
  window.addEventListener('beforeunload', () => room.destroyForUnload());
}
