import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/codex.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { chatCursor, codexPrompt, CodexClient, CODEX_BRIDGE_URL } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

// The fixture implements only the textarea operations used by this public API.
class Textarea extends EventTarget {
  constructor(value, start = value.length, end = start) {
    super();
    this.value = value;
    this.selectionStart = start;
    this.selectionEnd = end;
    this.inputListeners = new Set();
  }

  addEventListener(type, listener, options) {
    if (type === 'input') this.inputListeners.add(listener);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === 'input') this.inputListeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  setRangeText(text, start, end, mode) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    assert.equal(mode, 'end');
    this.selectionStart = this.selectionEnd = start + text.length;
  }

  edit(value, caret = value.length) {
    this.value = value;
    this.selectionStart = this.selectionEnd = caret;
    this.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

test('reply follows edits before the captured cursor, independent of later caret movement', () => {
  const input = new Textarea('alpha omega', 6);
  const anchor = chatCursor(input);
  input.edit('new alpha omega');
  input.selectionStart = input.selectionEnd = 0;

  assert.equal(anchor.insert('REPLY '), true);
  assert.equal(input.value, 'new alpha REPLY omega');
  assert.equal(input.selectionStart, 'new alpha REPLY '.length);
  assert.equal(input.inputListeners.size, 0);
});

test('reply inserts beside a selected draft without erasing its selected words', () => {
  const input = new Textarea('keep this draft', 5, 9);
  assert.equal(chatCursor(input).insert('answer '), true);
  assert.equal(input.value, 'keep answer this draft');
  assert.equal(input.selectionStart, 12);
  assert.equal(input.selectionEnd, 12);
});

test('reply that would exceed chat capacity preserves the entire draft and selection', () => {
  const value = 'x'.repeat(7_998);
  const input = new Textarea(value, 10, 20);
  assert.equal(chatCursor(input).insert('abc'), false);
  assert.equal(input.value, value);
  assert.equal(input.selectionStart, 10);
  assert.equal(input.selectionEnd, 20);
  assert.equal(input.inputListeners.size, 0);
});

test('reply can fill the exact 8000-character chat capacity', () => {
  const input = new Textarea('x'.repeat(7_997), 0);
  assert.equal(chatCursor(input).insert('abc'), true);
  assert.equal(input.value, 'abc' + 'x'.repeat(7_997));
  assert.equal(input.value.length, 8_000);
});

test('discarding a cursor anchor detaches its draft listener', () => {
  const input = new Textarea('draft', 2);
  const anchor = chatCursor(input);
  assert.equal(input.inputListeners.size, 1);
  anchor.dispose();
  anchor.dispose();
  assert.equal(input.inputListeners.size, 0);
  input.edit('another draft');
  assert.equal(input.inputListeners.size, 0);
  assert.equal(input.value, 'another draft');
});

function promptJson(prompt, label) {
  const line = prompt.split('\n\n').find((part) => part.startsWith(label + ': '));
  assert.ok(line, `Prompt contains ${label}`);
  return JSON.parse(line.slice(label.length + 2));
}

test('Unicode prompt with 24 history messages and an 8000-character request preserves newest context within budget', () => {
  const history = Array.from({ length: 24 }, (_, index) => ({
    authorName: `Player ${index}`, kind: 'chat',
    text: (`History ${index}: ` + '界🕹️'.repeat(400)).slice(0, 1_000),
  }));
  const request = ('Build a movement system 🕹️ '.repeat(400)).slice(0, 8_000);
  assert.equal(request.length, 8_000);
  const prompt = codexPrompt(request, '遊戲房間', 'movement', history);
  assert.ok(prompt.length <= 30_000);
  assert.equal(promptJson(prompt, 'USER_REQUEST_JSON'), request);
  const context = promptJson(prompt, 'ROOM_CONTEXT_JSON');
  assert.equal(context.room, '遊戲房間');
  assert.equal(context.channel, 'movement');
  assert.ok(context.messages.length > 0);
  assert.ok(context.messages.length < history.length);
  assert.deepEqual(context.messages.at(-1), {
    author: history.at(-1).authorName, kind: 'chat', text: history.at(-1).text,
  });
});

test('prompt rejects an explicit request whose escaped control characters alone exceed the budget', () => {
  const request = '\u0000'.repeat(8_000);
  assert.throws(() => codexPrompt(request, 'Room', 'general', []), /too long.*[Ss]horten/);
});

function tabStorage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const entries = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  });
  return entries;
}

test('paired client sends its key only to loopback authorization and stores it in tab storage', async (t) => {
  const storage = tabStorage(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/v1/status') ? { ready: true } : { answer: 'Use arrows to move.' });
  });
  const client = new CodexClient();
  assert.equal(client.hasKey(), false);
  await client.connect(' test-only-key ');
  assert.equal(client.hasKey(), true);
  assert.deepEqual([...storage.values()], ['test-only-key']);
  assert.equal(await client.ask('Help with movement.', new AbortController().signal), 'Use arrows to move.');

  assert.deepEqual(calls.map((call) => call.url), [CODEX_BRIDGE_URL + '/v1/status', CODEX_BRIDGE_URL + '/v1/ask']);
  for (const { options } of calls) {
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
  }
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { prompt: 'Help with movement.' });
  client.disconnect();
  assert.equal(client.hasKey(), false);
  assert.equal(storage.size, 0);
  await assert.rejects(client.ask('Help.', new AbortController().signal), /Connect your local AI first/);
  assert.equal(calls.length, 2);
});

test('client reports bridge rejection and does not keep an unsuccessful pairing key', async (t) => {
  const storage = tabStorage(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Sign in to Codex CLI with ChatGPT, then try again.' }, { status: 503 }));
  const client = new CodexClient();
  await assert.rejects(client.connect('test-only-key'), /Sign in to Codex CLI with ChatGPT/);
  assert.equal(client.hasKey(), false);
  assert.equal(storage.size, 0);
});

test('client distinguishes malformed replies from cancelled requests', async (t) => {
  tabStorage(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ready: true }));
  const client = new CodexClient();
  await client.connect('test-only-key');
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  await assert.rejects(client.ask('Help.', new AbortController().signal), /invalid response/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ answer: '  ' }));
  await assert.rejects(client.ask('Help.', new AbortController().signal), /did not return a reply/);
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(client.ask('Help.', controller.signal), /cancelled or timed out/);
});
