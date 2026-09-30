// One open file, edited live by everyone. Each edit becomes a small Yjs update that is
// merged with everyone else's, so simultaneous typing never overwrites anyone.
// Each person's caret and selection are shared too, as Yjs relative positions, so they
// stay attached to the right characters while other people type.
import * as Y from 'yjs';
import type { Actor } from './types';

const LOCAL = 'local';
const REMOTE = 'remote';
const PRESENCE_DELAY_MS = 60;
const HEARTBEAT_MS = 3_000;
const BATCH_MS = 100;

// A selection as it travels over the wire: two relative positions in JSON form.
export interface PresenceWire {
  start: unknown;
  end: unknown;
  back: boolean;
}

// A remote person's selection, as character positions in the text right now.
export interface RemoteSelection {
  id: string;
  start: number;
  end: number;
  back: boolean;
}

// A stretch of text and who wrote it.
export interface AuthorSegment {
  start: number;
  end: number;
  id: string;
  name: string;
  color: string;
}

interface RemoteState {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
  back: boolean;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class FileSession {
  readonly path: string;
  private author: Actor;
  private send: (base64Update: string) => void;
  private sendPresence: (presence: PresenceWire | null) => void;
  private doc = new Y.Doc();
  private text = this.doc.getText('content');
  private textarea: HTMLTextAreaElement | null = null;
  private listeners: Array<[string, () => void]> = [];
  private onChange: (() => void) | null = null;
  private remotes = new Map<string, RemoteState>();
  private presenceTimer: number | undefined;
  private heartbeat: number | undefined;
  private queued: Uint8Array[] = [];
  private batchTimer: number | undefined;

  constructor(
    path: string,
    author: Actor,
    send: (base64Update: string) => void,
    sendPresence: (presence: PresenceWire | null) => void,
  ) {
    this.path = path;
    this.author = author;
    this.send = send;
    this.sendPresence = sendPresence;
    // Only your own edits are sent out, bundled into ~100ms batches; updates from others are not echoed back.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL) return;
      this.queued.push(update);
      if (this.batchTimer === undefined) this.batchTimer = window.setTimeout(() => this.flush(), BATCH_MS);
    });
  }

  // Show this file in a textarea, send whatever the person types, and share their caret.
  // onChange is called whenever the text or anyone's caret moves, so the caller can redraw.
  attach(textarea: HTMLTextAreaElement, onChange: () => void): void {
    this.detach();
    this.textarea = textarea;
    this.onChange = onChange;
    textarea.value = this.text.toString();

    const typed = () => {
      this.applyLocal(textarea.value);
      this.onChange?.();
      this.publishSoon();
    };
    const moved = () => this.publishSoon();
    this.listen(textarea, 'input', typed);
    for (const name of ['keyup', 'mouseup', 'select', 'focus']) this.listen(textarea, name, moved);

    this.heartbeat = window.setInterval(() => {
      if (document.activeElement === textarea) this.publishNow();
    }, HEARTBEAT_MS);
    this.onChange?.();
  }

  // Merge an update from someone else and refresh the textarea, keeping your caret in place.
  applyRemote(base64Update: string): void {
    let update: Uint8Array;
    try {
      update = fromBase64(base64Update);
    } catch {
      return;
    }
    const textarea = this.textarea;
    let start: Y.RelativePosition | null = null;
    let end: Y.RelativePosition | null = null;
    if (textarea && document.activeElement === textarea) {
      start = Y.createRelativePositionFromTypeIndex(this.text, textarea.selectionStart);
      end = Y.createRelativePositionFromTypeIndex(this.text, textarea.selectionEnd);
    }
    try {
      Y.applyUpdate(this.doc, update, REMOTE);
    } catch {
      return;
    }
    if (textarea) {
      const merged = this.text.toString();
      if (textarea.value !== merged) {
        const scrollTop = textarea.scrollTop;
        textarea.value = merged;
        textarea.scrollTop = scrollTop;
        if (start && end) {
          const from = Y.createAbsolutePositionFromRelativePosition(start, this.doc);
          const to = Y.createAbsolutePositionFromRelativePosition(end, this.doc);
          if (from && to) textarea.setSelectionRange(from.index, to.index);
        }
      }
    }
    this.onChange?.();
  }

  // Remember (or forget, with null) where another person's caret is.
  setRemote(id: string, presence: PresenceWire | null): void {
    if (!presence) {
      this.remotes.delete(id);
    } else {
      try {
        this.remotes.set(id, {
          start: Y.createRelativePositionFromJSON(presence.start),
          end: Y.createRelativePositionFromJSON(presence.end),
          back: presence.back,
        });
      } catch {
        return;
      }
    }
    this.onChange?.();
  }

  // Drop carets belonging to people who are no longer in the room.
  pruneRemotes(memberIds: Set<string>): void {
    for (const id of Array.from(this.remotes.keys())) {
      if (!memberIds.has(id)) this.remotes.delete(id);
    }
  }

  remoteSelections(): RemoteSelection[] {
    const out: RemoteSelection[] = [];
    this.remotes.forEach((state, id) => {
      const start = Y.createAbsolutePositionFromRelativePosition(state.start, this.doc);
      const end = Y.createAbsolutePositionFromRelativePosition(state.end, this.doc);
      if (start && end) out.push({ id, start: start.index, end: end.index, back: state.back });
    });
    return out;
  }

  // Who wrote each stretch of the text. Text nobody claimed (from GitHub, or from before authorship was tracked) is skipped.
  // Authorship is declared by each person's own browser, so it is a record for the team, not proof.
  authorSegments(): AuthorSegment[] {
    const out: AuthorSegment[] = [];
    let index = 0;
    for (const op of this.text.toDelta()) {
      if (typeof op.insert !== 'string') continue;
      const length = op.insert.length;
      const author = op.attributes?.author;
      if (
        author &&
        typeof author === 'object' &&
        typeof author.id === 'string' &&
        typeof author.name === 'string' &&
        typeof author.color === 'string'
      ) {
        out.push({ start: index, end: index + length, id: author.id, name: author.name, color: author.color });
      }
      index += length;
    }
    return out;
  }

  // Send everything we have. Used after a reconnect so nothing typed offline is lost.
  pushAll(): void {
    this.flush();
    this.send(toBase64(Y.encodeStateAsUpdate(this.doc)));
  }

  dispose(): void {
    this.flush();
    this.sendPresence(null);
    this.detach();
    this.doc.destroy();
  }

  // Send everything typed since the last batch as one message.
  private flush(): void {
    window.clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (!this.queued.length) return;
    const merged = this.queued.length === 1 ? this.queued[0] : Y.mergeUpdates(this.queued);
    this.queued = [];
    this.send(toBase64(merged));
  }

  private listen(target: HTMLTextAreaElement, name: string, handler: () => void): void {
    target.addEventListener(name, handler);
    this.listeners.push([name, handler]);
  }

  private detach(): void {
    const textarea = this.textarea;
    if (textarea) this.listeners.forEach(([name, handler]) => textarea.removeEventListener(name, handler));
    this.listeners = [];
    this.textarea = null;
    this.onChange = null;
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.presenceTimer);
    this.heartbeat = undefined;
    this.presenceTimer = undefined;
  }

  private publishSoon(): void {
    if (this.presenceTimer !== undefined) return;
    this.presenceTimer = window.setTimeout(() => {
      this.presenceTimer = undefined;
      this.publishNow();
    }, PRESENCE_DELAY_MS);
  }

  private publishNow(): void {
    const textarea = this.textarea;
    if (!textarea || document.activeElement !== textarea) return;
    this.sendPresence({
      start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, textarea.selectionStart)),
      end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, textarea.selectionEnd)),
      back: textarea.selectionDirection === 'backward',
    });
  }

  // Turn "the textarea now says X" into the smallest insert/delete that gets the document there.
  private applyLocal(next: string): void {
    const old = this.text.toString();
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
    this.doc.transact(() => {
      if (endOld > start) this.text.delete(start, endOld - start);
      if (endNew > start) this.text.insert(start, next.slice(start, endNew), { author: this.author });
    }, LOCAL);
  }
}
