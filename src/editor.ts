// The code editor (CodeMirror 6), joined to the same Yjs text and send path the app already uses.
// Typing becomes a Yjs update tagged as your own, with your name on it, so it is sent to the room,
// saved to GitHub, and tinted with your color. Other people's changes come back in the same way.
import { Annotation, Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import type { Actor } from './types';
import { cleanColor } from './room';

// Compartment for editable state so it can be reconfigured
export const editableCompartment = new Compartment();

// Marks a change that came from someone else, so it is not sent back out.
const fromRoom = Annotation.define<boolean>();

// Detect language by file extension
function languageExtension(path: string): Extension | null {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'jsx':
      return javascript({ jsx: true });
    case 'css':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return null;
  }
}

// Keeps the editor and the shared text the same. This plugin comes first, so by the time
// anything else looks at the Yjs text it already has the latest typing.
function yjsBinding(text: Y.Text, author: Actor, origin: unknown): Extension {
  return ViewPlugin.fromClass(
    class {
      private watcher: (event: Y.YTextEvent, transaction: Y.Transaction) => void;

      constructor(private view: EditorView) {
        // Changes from other people (or the first load from the server) go into the editor.
        this.watcher = (event, transaction) => {
          if (transaction.origin === origin) return;
          const changes: Array<{ from: number; to?: number; insert?: string }> = [];
          let position = 0;
          for (const op of event.delta) {
            if (op.retain) position += op.retain;
            else if (typeof op.insert === 'string') changes.push({ from: position, insert: op.insert });
            else if (op.delete) {
              changes.push({ from: position, to: position + op.delete });
              position += op.delete;
            }
          }
          if (!changes.length) return;
          this.view.dispatch({ changes, annotations: [fromRoom.of(true), Transaction.addToHistory.of(false)] });
        };
        text.observe(this.watcher);
      }

      // Your own typing goes into the shared text, marked with who wrote it.
      update(update: ViewUpdate) {
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(fromRoom))) return;
        const doc = text.doc;
        if (!doc) return;
        doc.transact(() => {
          let shift = 0;
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const index = fromA + shift;
            if (toA > fromA) text.delete(index, toA - fromA);
            if (inserted.length) text.insert(index, inserted.toString(), { author });
            shift += inserted.length - (toA - fromA);
          });
        }, origin);
      }

      destroy() {
        text.unobserve(this.watcher);
      }
    },
  );
}

// Tints each stretch of text with the color of whoever wrote it.
function authorColorExtension(text: Y.Text): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(_view: EditorView) {
        this.decorations = this.build();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = this.build();
      }

      build(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        let index = 0;
        for (const op of text.toDelta()) {
          if (typeof op.insert !== 'string') continue;
          const length = op.insert.length;
          const author = op.attributes?.author;
          if (
            author &&
            typeof author === 'object' &&
            typeof author.id === 'string' &&
            typeof author.name === 'string' &&
            typeof author.color === 'string' &&
            length > 0
          ) {
            builder.add(index, index + length, Decoration.mark({ class: 'author-span', attributes: { style: '--c: ' + cleanColor(author.color) } }));
          }
          index += length;
        }
        return builder.finish();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

// Other people's carets and selections, drawn inside the editor so they scroll and wrap with the text.
export interface RemoteCaret {
  id: string;
  name: string;
  color: string;
  start: number;
  end: number;
  back: boolean;
}

const setRemoteCarets = StateEffect.define<RemoteCaret[]>();

class CaretWidget extends WidgetType {
  constructor(private name: string, private color: string) {
    super();
  }

  eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.style.setProperty('--c', this.color);
    const label = document.createElement('span');
    label.className = 'caret-name';
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildCarets(carets: RemoteCaret[], length: number): DecorationSet {
  const clamp = (index: number) => Math.min(length, Math.max(0, index));
  const ranges = [];
  for (const caret of carets) {
    const color = cleanColor(caret.color);
    const start = clamp(Math.min(caret.start, caret.end));
    const end = clamp(Math.max(caret.start, caret.end));
    if (end > start) ranges.push(Decoration.mark({ class: 'caret-sel', attributes: { style: '--c: ' + color } }).range(start, end));
    ranges.push(Decoration.widget({ widget: new CaretWidget(caret.name, color), side: 1 }).range(caret.back ? start : end));
  }
  return Decoration.set(ranges, true);
}

const remoteCaretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setRemoteCarets)) value = buildCarets(effect.value, transaction.state.doc.length);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function showRemoteCarets(view: EditorView | null, carets: RemoteCaret[]): void {
  view?.dispatch({ effects: setRemoteCarets.of(carets) });
}

// Custom theme matching the rest of the page
const customTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--ink)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '22px 14px 14px',
    fontSize: '15px',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    caretColor: 'var(--ink)',
  },
  '.cm-line': {
    wordWrap: 'break-word',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--ink)',
    opacity: '0.55',
    border: '0',
    borderRight: 'var(--line)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 10px',
    fontSize: '12px',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--select)',
    outline: '1px solid var(--ink)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--ink)',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--select)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--select)',
  },
});

// Code colors, picked to sit on the beige page. Language packs parse the code; this paints it.
const codeColors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: '#9a3412', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#166534' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#1d4ed8' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8a8575', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#6d28d9' },
  { tag: [t.propertyName, t.attributeName], color: '#0e7490' },
  { tag: [t.typeName, t.className, t.namespace], color: '#a16207' },
  { tag: [t.tagName, t.angleBracket], color: '#9a3412' },
  { tag: [t.heading, t.strong], fontWeight: '700' },
  { tag: t.heading1, fontSize: '1.2em' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#1d4ed8', textDecoration: 'underline' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#57534e' },
  { tag: t.meta, color: '#8a8575' },
]);

// Creates the editor inside container. origin tags your own typing; onSelect fires when your caret moves.
export function createEditor(
  container: HTMLElement,
  text: Y.Text,
  author: Actor,
  path: string,
  origin: unknown,
  onSelect: () => void,
): EditorView {
  const state = EditorState.create({
    doc: text.toString(),
    extensions: [
      yjsBinding(text, author, origin),
      authorColorExtension(text),
      remoteCaretField,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      customTheme,
      lineNumbers(),
      bracketMatching(),
      syntaxHighlighting(codeColors),
      languageExtension(path) ?? [],
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.focusChanged) onSelect();
      }),
    ],
  });
  return new EditorView({ state, parent: container });
}
