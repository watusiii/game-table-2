// GitHub-backed files. Keeps a working copy of one repo, merges everyone's typing with Yjs,
// saves to disk, commits and pushes a few seconds after the last edit, and pulls changes made elsewhere.
// It shells out to the git on this computer, so it uses whatever GitHub login git already has.
//
// Safety nets: deleted files go to a trash you can restore from, every saved version stays
// in git history and can be restored, likely secrets are never pushed, and stopping the
// server finishes saving first.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import * as Y from 'yjs';

const FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_\-. /]{0,120}$/;
const ALLOWED_EXT = /\.(md|txt|json|js|mjs|ts|html|css)$/i;
const MAX_FILE_CHARS = 200_000;
const MAX_UPDATE_CHARS = 90_000;
const MAX_FILES = 200;
const MAX_OTHER_FILES = 500; // images, audio and other non-text files listed for viewing
const MAX_TRASH = 100;
const MAX_TRASH_CHARS = 5_000_000;
const MAX_VERSIONS = 20;
const COMMIT_IDLE_MS = 8_000;
const COMMIT_MAX_WAIT_MS = 30_000;
const RETRY_DELAY_MS = 30_000;
const PULL_INTERVAL_MS = 60_000;
const DISK_DELAY_MS = 1_000;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 15 * 60_000;

// What the game preview is allowed to load from the repo.
const PREVIEW_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.otf': 'font/otf',
  '.csv': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// A tiny playable game, so the preview has something to run the first time.
const STARTER_HTML = [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<title>Game</title>',
  '<style>',
  '  html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 14px monospace; }',
  '  canvas { display: block; margin: 0 auto; background: #1b1b1b; }',
  '</style>',
  '<canvas id="c" width="480" height="320"></canvas>',
  '<script>',
  "  const canvas = document.getElementById('c');",
  "  const g = canvas.getContext('2d');",
  '  const me = { x: 240, y: 160, speed: 3 };',
  '  const keys = {};',
  "  addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });",
  "  addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });",
  '  function tick() {',
  '    if (keys.arrowleft || keys.a) me.x -= me.speed;',
  '    if (keys.arrowright || keys.d) me.x += me.speed;',
  '    if (keys.arrowup || keys.w) me.y -= me.speed;',
  '    if (keys.arrowdown || keys.s) me.y += me.speed;',
  "    g.fillStyle = '#1b1b1b';",
  '    g.fillRect(0, 0, 480, 320);',
  "    g.fillStyle = '#7cf';",
  '    g.fillRect(me.x - 8, me.y - 8, 16, 16);',
  "    g.fillStyle = '#eee';",
  "    g.fillText('Click here, then arrow keys or WASD. Edit index.html and this reloads.', 10, 20);",
  '    requestAnimationFrame(tick);',
  '  }',
  '  tick();',
  '</script>',
  '',
].join('\n');

// Things that should never end up in a public repo. Checked before anything is pushed.
const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
];

function findSecret(text) {
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// Git prints its progress to the same place as its errors, so the real reason can be buried.
// Keep the lines that say what went wrong.
function explainGitError(error, stderr) {
  if (error.killed) return 'it took too long and was stopped';
  const lines = String(stderr || error.message)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(Cloning into|Receiving objects|Resolving deltas|Updating files|Unpacking objects|Enumerating objects|Counting objects|Compressing objects|remote: (Enumerating|Counting|Compressing|Total))/i.test(line),
    );
  return (lines.slice(-4).join(' ') || String(error.message)).slice(0, 400);
}

function git(cwd, args, raw = false, timeoutMs = 90_000) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(explainGitError(error, stderr)));
        else resolvePromise(raw ? stdout : stdout.trim());
      },
    );
  });
}

const short = (message) => String(message).slice(0, 300);
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

// Replace a Y.Text's content with `next`, changing only the part that differs.
function spliceText(doc, text, next, origin) {
  const old = text.toString();
  if (old === next) return;
  let start = 0;
  const min = Math.min(old.length, next.length);
  while (start < min && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endOld = old.length;
  let endNew = next.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  doc.transact(() => {
    if (endOld > start) text.delete(start, endOld - start);
    if (endNew > start) text.insert(start, next.slice(start, endNew), { author: null });
  }, origin);
}

export function createRepo({ url, branch = '', dir, onStatus: reportStatus, onUpdate, onFiles, onTrash }) {
  const repoDir = join(dir, 'repo');
  const trashFile = join(dir, 'trash.json');
  const docsDir = join(dir, 'docs');
  let disposed = false;
  // Once disposed (repo disconnected, room closed) nothing more is reported to the room.
  const onStatus = (state, message) => {
    if (!disposed) reportStatus(state, message);
  };
  const states = new Map(); // path -> { doc, text, editedBy }
  const editors = new Set();
  const touched = new Set(); // files edited since the last save, checked for secrets
  let ready = false;
  let pullTimer = null;
  let pending = false;
  // Edits are saved to a branch of the room's own, not to main. base is the branch proposals go to.
  let currentBranch = '';
  let baseBranch = '';
  let bootstrapping = false;
  let commitTimer = null;
  let queue = Promise.resolve();

  // Typing is kept in memory and written to disk at most once a second.
  const dirty = new Set();
  let flushTimer = null;

  function flushDirty() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirty.forEach((path) => {
      const state = states.get(path);
      const abs = resolveFile(path);
      if (!state || !abs) return;
      try {
        writeFileSync(abs, state.text.toString());
        persistDoc(path);
      } catch (error) {
        console.error('Could not write ' + path + ': ' + error.message);
      }
    });
    dirty.clear();
  }

  function markDirty(path) {
    dirty.add(path);
    if (!flushTimer) flushTimer = setTimeout(flushDirty, DISK_DELAY_MS);
  }

  // Git jobs run one at a time so a pull never overlaps a push.
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /* ---------- Trash ---------- */

  // Newest first: { path, content, by, at }. Kept beside the repo, never inside it.
  let trash = [];
  try {
    const saved = JSON.parse(readFileSync(trashFile, 'utf8'));
    if (Array.isArray(saved)) {
      trash = saved
        .filter((item) =>
          item && typeof item.path === 'string' && typeof item.content === 'string' &&
          typeof item.by === 'string' && typeof item.at === 'string')
        .slice(0, MAX_TRASH);
    }
  } catch {
    // Nothing in the trash yet.
  }

  function saveTrash() {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(trashFile, JSON.stringify(trash));
    } catch (error) {
      console.error('Could not save the trash: ' + error.message);
    }
  }

  const trashList = () => trash.map(({ path, by, at }) => ({ path, by, at }));

  /* ---------- Files ---------- */

  function resolveFile(rel) {
    if (typeof rel !== 'string' || !FILE_PATTERN.test(rel) || !ALLOWED_EXT.test(rel)) return null;
    if (rel.split('/').some((part) => part === '' || part.startsWith('.'))) return null;
    const abs = resolve(repoDir, rel);
    return abs.startsWith(repoDir + sep) ? abs : null;
  }

  // Any plain file name is fine to show in the tree. Reading it still goes through readPreview's checks.
  const LISTABLE = /^[^\u0000-\u001f\\<>"|?*]{1,200}$/;

  function scan(folder, base = '', depth = 0, out = [], counts = { text: 0, other: 0 }) {
    if (depth > 3) return out;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = base ? base + '/' + entry.name : entry.name;
      if (entry.isDirectory()) scan(join(folder, entry.name), rel, depth + 1, out, counts);
      else if (resolveFile(rel)) {
        if (counts.text < MAX_FILES) {
          counts.text += 1;
          out.push(rel);
        }
      } else if (entry.isFile() && LISTABLE.test(rel) && counts.other < MAX_OTHER_FILES) {
        counts.other += 1;
        out.push(rel);
      }
    }
    return out.sort();
  }

  function list() {
    if (!ready) return [];
    try {
      return scan(repoDir);
    } catch {
      return [];
    }
  }

  const readDisk = (abs) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

  // Where each file's live document (including who wrote what) is kept between runs.
  const docFile = (path) => join(docsDir, createHash('sha1').update(path).digest('hex') + '.ydoc');

  function persistDoc(path) {
    const state = states.get(path);
    if (!state) return;
    try {
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(docFile(path), Buffer.from(Y.encodeStateAsUpdate(state.doc)));
    } catch (error) {
      console.error('Could not save authorship for ' + path + ': ' + error.message);
    }
  }

  function track(path, content, editedBy) {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    // Pick up who wrote what from last time, then reconcile with what is on disk now.
    try {
      Y.applyUpdate(doc, new Uint8Array(readFileSync(docFile(path))), 'load');
    } catch {
      // No saved authorship (a new file), or it could not be read.
    }
    spliceText(doc, text, content, 'load');
    // Changes that come from disk (a pull, a size cap) or from a restore go to everyone;
    // ordinary typing is relayed by the caller.
    doc.on('update', (update, origin) => {
      if (origin === 'disk') onUpdate(path, toBase64(update), 'GitHub');
      else if (typeof origin === 'string' && origin.startsWith('restore:')) onUpdate(path, toBase64(update), origin.slice(8));
    });
    const state = { doc, text, editedBy };
    states.set(path, state);
    return state;
  }

  function load(path) {
    const existing = states.get(path);
    if (existing) return existing;
    const abs = resolveFile(path);
    if (!abs) return null;
    try {
      const content = readDisk(abs);
      return content.length > MAX_FILE_CHARS ? null : track(path, content, '');
    } catch {
      return null;
    }
  }

  // Hand a client the whole document so it can start editing.
  function open(path) {
    const state = ready ? load(path) : null;
    return state ? { path, update: toBase64(Y.encodeStateAsUpdate(state.doc)) } : null;
  }

  // Saves happen a little after typing stops, but never later than COMMIT_MAX_WAIT_MS after the first
  // unsaved change, so a busy room makes a steady trickle of commits instead of a flood.
  let firstPendingAt = 0;
  function scheduleCommit(delay = COMMIT_IDLE_MS, quiet = false) {
    const now = Date.now();
    if (!pending) {
      pending = true;
      firstPendingAt = now;
      if (!quiet) onStatus('pending', 'Changes waiting to save\u2026');
    }
    const wait = Math.max(0, Math.min(delay, firstPendingAt + COMMIT_MAX_WAIT_MS - now));
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = null;
      void enqueue(save);
    }, wait);
  }

  // A client's typing arrives as a Yjs update. Merge it in and save the result.
  function applyUpdate(path, base64, author) {
    if (!ready || typeof base64 !== 'string' || base64.length > MAX_UPDATE_CHARS) return false;
    const state = load(path);
    if (!state) return false;
    try {
      Y.applyUpdate(state.doc, new Uint8Array(Buffer.from(base64, 'base64')), 'client');
    } catch {
      return false;
    }
    if (state.text.length > MAX_FILE_CHARS) {
      state.doc.transact(() => state.text.delete(MAX_FILE_CHARS, state.text.length - MAX_FILE_CHARS), 'disk');
    }
    state.editedBy = author;
    markDirty(path);
    touched.add(path);
    editors.add(author);
    scheduleCommit();
    return true;
  }

  function create(path, author, starter = false) {
    if (!ready) return false;
    const abs = resolveFile(path);
    if (!abs || existsSync(abs)) return false;
    const content = starter && path === 'index.html' ? STARTER_HTML : '';
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    track(path, content, author);
    persistDoc(path);
    touched.add(path);
    editors.add(author);
    scheduleCommit();
    onFiles();
    return true;
  }

  // Put `content` into a file, replacing what is there (everyone sees it change), or recreate the file if it is gone.
  function writeVersion(path, content, author, quiet = false) {
    const abs = resolveFile(path);
    if (!abs || content.length > MAX_FILE_CHARS) return false;
    const state = existsSync(abs) ? load(path) : null;
    if (state) {
      state.editedBy = author;
      spliceText(state.doc, state.text, content, 'restore:' + author);
      markDirty(path);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      states.get(path)?.doc.destroy();
      track(path, content, author);
      if (!quiet) onFiles();
    }
    touched.add(path);
    editors.add(author);
    scheduleCommit();
    return true;
  }

  // Delete a file: gone from disk and memory now, from GitHub with the next save,
  // and a copy is kept in the trash so it can be brought back.
  function remove(path, author) {
    if (!ready) return false;
    const abs = resolveFile(path);
    if (!abs || !existsSync(abs)) return false;
    const state = states.get(path);
    let content = state ? state.text.toString() : '';
    if (!state) {
      try {
        content = readDisk(abs);
      } catch {
        content = '';
      }
    }
    try {
      unlinkSync(abs);
    } catch {
      return false;
    }
    try {
      unlinkSync(docFile(path));
    } catch {
      // No saved authorship to remove.
    }
    trash.unshift({ path, content, by: author, at: new Date().toISOString() });
    trash = trash.slice(0, MAX_TRASH);
    let total = 0;
    trash = trash.filter((entry) => (total += entry.content.length) <= MAX_TRASH_CHARS);
    saveTrash();
    if (state) {
      state.doc.destroy();
      states.delete(path);
    }
    dirty.delete(path);
    touched.delete(path);
    editors.add(author);
    scheduleCommit();
    onFiles();
    onTrash();
    return true;
  }

  function restoreDeleted(path, author) {
    if (!ready) return false;
    const index = trash.findIndex((item) => item.path === path);
    const abs = resolveFile(path);
    if (index === -1 || !abs || existsSync(abs)) return false;
    if (!writeVersion(path, trash[index].content, author)) return false;
    trash.splice(index, 1);
    saveTrash();
    onTrash();
    return true;
  }

  // Bring back every deleted file in one go (skipping names that exist again), as a single save.
  function restoreAllDeleted(author) {
    if (!ready) return 0;
    let restored = 0;
    const remaining = [];
    for (const item of trash) {
      const abs = resolveFile(item.path);
      if (abs && !existsSync(abs) && writeVersion(item.path, item.content, author, true)) restored += 1;
      else remaining.push(item);
    }
    trash = remaining;
    saveTrash();
    onFiles();
    onTrash();
    return restored;
  }

  /* ---------- Version history ---------- */

  // The saved versions of one file, newest first. Every save to GitHub is one.
  async function history(path) {
    if (!ready || !resolveFile(path)) return [];
    try {
      const out = await git(repoDir, ['log', '-n', String(MAX_VERSIONS), '--format=%H%x1f%aI%x1f%an%x1f%s', '--', path]);
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [sha, at, author, subject] = line.split('\x1f');
        return { sha, at, author, subject };
      });
    } catch {
      return []; // no commits yet
    }
  }

  // Bring back an older saved version. This is itself a new edit, so it can be undone from history too.
  async function restoreVersion(path, sha, author) {
    if (!ready || typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || !resolveFile(path)) return false;
    let content;
    try {
      content = (await git(repoDir, ['show', sha + ':' + path], true)).replace(/\r\n/g, '\n');
    } catch {
      return false;
    }
    return writeVersion(path, content, author);
  }

  /* ---------- Syncing ---------- */

  // The first edited file that looks like it holds a password or key, if any.
  function secretIn() {
    for (const path of touched) {
      const state = states.get(path);
      const label = state ? findSecret(state.text.toString()) : null;
      if (label) return { path, label };
    }
    return null;
  }

  // Bring anything changed on disk (by a pull) into the open documents and tell everyone.
  function refreshFromDisk() {
    states.forEach((state, path) => {
      if (dirty.has(path)) return; // newer typing not on disk yet; keep it
      let content;
      try {
        content = readDisk(resolveFile(path));
      } catch {
        // The file is gone from disk (removed on GitHub, then pulled). Forget it.
        state.doc.destroy();
        states.delete(path);
        try {
          unlinkSync(docFile(path));
        } catch {
          // No saved authorship to remove.
        }
        return;
      }
      if (content !== state.text.toString()) {
        state.editedBy = 'GitHub';
        spliceText(state.doc, state.text, content, 'disk');
        persistDoc(path);
      }
    });
    onFiles();
  }

  // Stop watching this repo (the room disconnected it or closed). Unsaved typing is still committed.
  function dispose() {
    flushDirty();
    if (pending && !secretIn()) void enqueue(save);
    disposed = true;
    ready = false;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (pullTimer) {
      clearInterval(pullTimer);
      pullTimer = null;
    }
    states.forEach((state) => state.doc.destroy());
    states.clear();
  }

  // Finish saving before the whole server stops, so stopping it never loses typing.
  async function shutdown() {
    flushDirty();
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (pullTimer) {
      clearInterval(pullTimer);
      pullTimer = null;
    }
    if (pending) await enqueue(save).catch(() => {});
    await queue;
  }

  // A file for the game preview: the live text if someone is editing it, otherwise straight from disk.
  // Read-only, only inside the repo, never dotfiles, and only known file types.
  function readPreview(rel) {
    if (!ready || typeof rel !== 'string' || rel.length > 300 || rel.includes('\0') || rel.includes('\\')) return null;
    if (rel.split('/').some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return null;
    const type = PREVIEW_TYPES[extname(rel).toLowerCase()];
    if (!type) return null;
    const abs = resolve(repoDir, rel);
    if (!abs.startsWith(repoDir + sep)) return null;
    const live = states.get(rel);
    if (live) return { body: Buffer.from(live.text.toString(), 'utf8'), type };
    try {
      // Follow links first, so a link inside the repo cannot lead outside it.
      if (!realpathSync(abs).startsWith(realpathSync(repoDir) + sep)) return null;
      const info = statSync(abs);
      if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) return null;
      return { body: readFileSync(abs), type };
    } catch {
      return null;
    }
  }

  // Find the branch proposals go to (usually main).
  async function detectBase() {
    try {
      return (await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');
    } catch {
      // origin/HEAD is not always set; try the usual names.
    }
    for (const name of ['main', 'master']) {
      try {
        await git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + name]);
        return name;
      } catch {
        // Not that one.
      }
    }
    return '';
  }

  // Switch to our branch, creating it if needed. Never resets a branch that already has work on it.
  async function ensureBranch(name) {
    const has = (ref) => git(repoDir, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
    if (await has('refs/heads/' + name)) await git(repoDir, ['checkout', name]);
    else if (await has('refs/remotes/origin/' + name)) await git(repoDir, ['checkout', '-b', name, '--track', 'origin/' + name]);
    else await git(repoDir, ['checkout', '-b', name]);
  }

  async function push() {
    try {
      await git(repoDir, ['push', '-u', 'origin', 'HEAD']);
    } catch (error) {
      if (!/rejected|fetch first|non-fast-forward/i.test(error.message)) throw error;
      flushDirty();
      await git(repoDir, ['pull', '--rebase', '--autostash']);
      await git(repoDir, ['push', '-u', 'origin', 'HEAD']);
      refreshFromDisk();
    }
  }

  async function save() {
    if (!pending) return;
    pending = false;
    flushDirty();

    // Never push something that looks like a password or key. The repo may be public.
    const secret = secretIn();
    if (secret) {
      scheduleCommit(RETRY_DELAY_MS, true);
      onStatus(
        'error',
        'Not saved to GitHub: ' + secret.path + ' looks like it contains ' + secret.label + '. Remove it and saving resumes. This repo may be public.',
      );
      return;
    }

    onStatus('saving', 'Saving to GitHub\u2026');
    try {
      await git(repoDir, ['add', '-A']);
      const changed = await git(repoDir, ['status', '--porcelain']);
      if (changed) {
        const names = [...editors].map((name) => name.replace(/[<>"\r\n]/g, '')).filter(Boolean);
        editors.clear();
        await git(repoDir, [
          '-c', 'user.name=Game Table',
          '-c', 'user.email=game-table@localhost',
          'commit',
          '-m', 'Edit via Game Table (' + (names.join(', ') || 'unknown') + ')',
          '--author', (names[0] || 'Game Table') + ' <noreply@game-table.local>',
        ]);
      }
      await push();
      touched.clear();
      if (bootstrapping) {
        // The empty repo now has its first commit on its main branch. Move to our own branch from here on.
        await ensureBranch(branch);
        baseBranch = currentBranch;
        currentBranch = branch;
        bootstrapping = false;
      }
      onStatus('saved', 'Saved to GitHub');
    } catch (error) {
      onStatus('error', 'Could not save to GitHub: ' + short(error.message));
      scheduleCommit(RETRY_DELAY_MS, true);
    }
  }

  async function pull() {
    if (!ready || pending) return;
    try {
      const before = await git(repoDir, ['rev-parse', 'HEAD']).catch(() => '');
      await git(repoDir, ['pull', '--rebase', '--autostash']);
      const after = await git(repoDir, ['rev-parse', 'HEAD']).catch(() => '');
      if (before !== after) refreshFromDisk();
    } catch {
      // Empty remote, or offline. Try again on the next round.
    }
  }

  async function init() {
    if (!url) {
      onStatus('off', 'No repo configured.');
      return;
    }
    onStatus('opening', 'Opening repo\u2026');
    try {
      mkdirSync(dir, { recursive: true });
      const hasHead = () => git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
      let cloned = existsSync(join(repoDir, '.git'));
      if (cloned) await git(repoDir, ['fetch', 'origin']).catch(() => {});
      if (cloned && !(await hasHead())) {
        // A clone that never finished looks just like an empty repo. Ask GitHub which one it is.
        const heads = await git(repoDir, ['ls-remote', '--heads', 'origin']).catch(() => null);
        if (heads) {
          rmSync(repoDir, { recursive: true, force: true });
          cloned = false;
        }
      }
      if (!cloned) {
        onStatus('opening', 'Downloading from GitHub. Big repos take a while\u2026');
        try {
          await git(dir, ['-c', 'core.longpaths=true', 'clone', '--quiet', url, 'repo'], false, CLONE_TIMEOUT_MS);
        } catch (error) {
          rmSync(repoDir, { recursive: true, force: true }); // never leave half a clone behind
          throw error;
        }
      }
      await git(repoDir, ['config', 'core.longpaths', 'true']).catch(() => {});
      if (disposed) return;
      baseBranch = await detectBase();
      const hasCommits = await hasHead();
      if (hasCommits && branch) {
        // Work on a branch of our own, so the shared main branch only changes when a proposal is accepted.
        if (!baseBranch) {
          const head = await git(repoDir, ['symbolic-ref', '--short', 'HEAD']).catch(() => '');
          baseBranch = head === branch ? '' : head;
        }
        await ensureBranch(branch);
        currentBranch = branch;
      } else {
        // An empty repo: the first save has to create its main branch. After that we move to our own.
        bootstrapping = Boolean(branch);
        currentBranch = await git(repoDir, ['symbolic-ref', '--short', 'HEAD']).catch(() => '');
      }
      if (hasCommits) await git(repoDir, ['pull', '--rebase', '--autostash']).catch(() => {});
      if (disposed) return;
      ready = true;
      onStatus('idle', 'Connected to GitHub');
      onFiles();
      pullTimer = setInterval(() => void enqueue(pull), PULL_INTERVAL_MS);
      pullTimer.unref();
    } catch (error) {
      onStatus('error', 'Could not open the repo: ' + short(error.message));
    }
  }

  // Read-only looks at the repo for the /commands. A fixed list, never a free-form git command.
  async function look(kind, count = 8) {
    flushDirty();
    const base = baseBranch ? 'origin/' + baseBranch : '';
    if (kind === 'status') {
      const changed = (await git(repoDir, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
      let behind = '?';
      let ahead = '?';
      if (base) [behind, ahead] = (await git(repoDir, ['rev-list', '--left-right', '--count', base + '...HEAD'])).split(/\s+/);
      return { branch: currentBranch, base: baseBranch, changed, ahead, behind };
    }
    if (kind === 'log') return git(repoDir, ['log', '-n', String(count), '--pretty=%h %s (%an, %ar)']);
    if (kind === 'diff') return base ? git(repoDir, ['diff', '--stat', base + '...HEAD']) : '';
    return '';
  }

  // Merge the base branch into the room branch. A conflict is backed out and left for GitHub.
  function updateFromBase() {
    return enqueue(async () => {
      if (!ready || !baseBranch || !currentBranch || currentBranch === baseBranch) throw new Error('This room has no branch of its own to update yet.');
      flushDirty();
      await save();
      await git(repoDir, ['fetch', 'origin']);
      const behind = Number(await git(repoDir, ['rev-list', '--count', 'HEAD..origin/' + baseBranch]));
      if (!behind) return 'Already up to date with ' + baseBranch + '.';
      try {
        await git(repoDir, ['merge', '--no-edit', 'origin/' + baseBranch]);
      } catch {
        await git(repoDir, ['merge', '--abort']).catch(() => {});
        throw new Error('Could not merge ' + baseBranch + ' (conflict or unsaved changes). Nothing was changed. Sort it out on GitHub.');
      }
      await push();
      refreshFromDisk();
      return 'Pulled ' + behind + ' new commit(s) from ' + baseBranch + '.';
    });
  }

  return {
    look,
    updateFromBase,
    init,
    list,
    open,
    applyUpdate,
    create,
    remove,
    restoreDeleted,
    restoreAllDeleted,
    trashList,
    history,
    restoreVersion,
    dispose,
    shutdown,
    readPreview,
    info: () => ({ branch: currentBranch, base: baseBranch }),
  };
}
