import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { buildRoomPrompt, createRoomAgent, isCodexRequest, isHumanConfirmation } from './codex-room-agent.mjs';

const CONFIG = {
  server: 'wss://room.test', roomId: 'test-room', inviteKey: 'test-only-invite',
  clientId: 'codex-member', name: 'Codex', color: 'hsl(120 50% 50%)',
};
const CHANNELS = [{ id: 'general-id', name: 'general' }, { id: 'ideas-id', name: 'ideas' }];
const MEMBERS = [
  { id: 'human-member', name: 'Human', agent: false },
  { id: CONFIG.clientId, name: 'AI · Codex', agent: true },
  { id: 'other-helper', name: 'AI · Helper', agent: true },
];

function message(id, text, overrides = {}) {
  return {
    id, text, authorId: 'human-member', authorName: 'Human', authorColor: '',
    channelId: 'general-id', kind: 'chat', createdAt: new Date().toISOString(), ...overrides,
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, description = 'expected agent behavior', timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

class FakeSocket extends EventEmitter {
  constructor({ autoAck = true, fileContents = {} } = {}) {
    super();
    this.readyState = 0;
    this.sent = [];
    this.autoAck = autoAck;
    this.fileContents = fileContents;
  }

  open() { this.readyState = 1; this.emit('open'); }
  receive(packet) { this.emit('message', Buffer.from(JSON.stringify(packet))); }
  send(raw) {
    assert.equal(this.readyState, 1, 'closed sockets cannot send');
    const packet = JSON.parse(raw);
    this.sent.push(packet);
    if (packet.type === 'chat' && this.autoAck) queueMicrotask(() => this.ack(packet));
    if (packet.type === 'file:open' && Object.hasOwn(this.fileContents, packet.path)) {
      const doc = new Y.Doc();
      doc.getText('content').insert(0, this.fileContents[packet.path]);
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
      doc.destroy();
      queueMicrotask(() => this.receive({ type: 'file:state', path: packet.path, update }));
    }
  }

  ack(packet = this.chats.at(-1)) {
    assert.ok(packet, 'there must be a reply to acknowledge');
    this.receive({ type: 'chat', message: message(`reply-${this.sent.length}`, packet.text, {
      authorId: CONFIG.clientId, authorName: 'AI · Codex', channelId: packet.channelId, kind: 'ai',
    }) });
  }

  disconnect() { this.readyState = 3; this.emit('close', 1006); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close', 1000); } }
  terminate() { this.close(); }
  get chats() { return this.sent.filter((packet) => packet.type === 'chat'); }
}

function snapshot({ messages = [], can = ['chat'], members = MEMBERS } = {}) {
  return {
    type: 'snapshot', roomId: CONFIG.roomId, youId: CONFIG.clientId,
    roomName: 'Test Room', role: 'member', can, channels: CHANNELS, messages, members,
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-room-agent-test-'));
  const statePath = join(directory, 'state.json');
  const sockets = [], agents = [], runs = [];
  const runner = options.runner ?? (async (request) => { runs.push(request); return 'A room answer.'; });
  function makeAgent(extra = {}) {
    const agent = createRoomAgent({
      config: CONFIG, runner, statePath, reconnectMs: 10,
      ackTimeoutMs: options.ackTimeoutMs, fileTimeoutMs: options.fileTimeoutMs,
      socketFactory: (server) => {
        assert.equal(server, CONFIG.server);
        const socket = new FakeSocket(options);
        sockets.push(socket);
        return socket;
      },
      ...extra,
    });
    agents.push(agent);
    return agent;
  }
  const agent = makeAgent();
  t.after(async () => {
    for (const current of agents) await current.stop();
    await rm(directory, { force: true, recursive: true });
  });
  async function connect(current = agent, initial = {}) {
    const before = sockets.length;
    const started = current.start();
    await eventually(() => sockets.length > before, 'socket creation');
    const socket = sockets.at(-1);
    socket.open();
    socket.receive(snapshot(initial));
    socket.receive({ type: 'files', files: initial.files ?? [] });
    socket.receive({ type: 'preview', rev: 0 });
    await started;
    return socket;
  }
  return { agent, connect, makeAgent, sockets, runs, statePath };
}

test('humans can address Codex or all helpers and another AI can address Codex directly', () => {
  for (const text of ['Codex, explain movement.', '@codex what do you think?', 'Could Codex read index.html?', 'All AIs, review this plan.', 'Everyone, what do you suggest?']) {
    assert.equal(isCodexRequest(message('request', text), CONFIG.clientId, MEMBERS), true, text);
  }
  for (const request of [
    message('ai', 'Codex, review my proposal.', { kind: 'ai', authorId: 'other-helper' }),
    message('agent', 'Codex, review my proposal.', { authorId: 'other-helper' }),
  ]) assert.equal(isCodexRequest(request, CONFIG.clientId, MEMBERS), true, request.id);
  for (const request of [
    message('self', 'Codex, hello.', { authorId: CONFIG.clientId }),
    message('system', 'Codex joined.', { kind: 'system', authorId: 'system' }),
    message('ai-broadcast', 'Everyone, review my proposal.', { kind: 'ai', authorId: 'other-helper' }),
    message('agent-broadcast', 'All helpers, review my proposal.', { authorId: 'other-helper' }),
    message('casual', 'The jump animation looks good.'),
    message('substring', 'codexes should not be a mention'),
    message('empty', ''),
  ]) assert.equal(isCodexRequest(request, CONFIG.clientId, MEMBERS), false, request.id);
});

test('only an explicit affirmative message from a human confirms another AI reply', () => {
  for (const text of ['Yes.', 'OK', 'Confirmed.', 'Approved', 'Go ahead.', 'Continue', 'Proceed', 'Codex, continue']) {
    assert.equal(isHumanConfirmation(message('confirmation', text), MEMBERS), true, text);
  }
  for (const request of [
    message('negative', 'Do not continue.'),
    message('stop', 'Stop.'),
    message('disapproval', 'Not approved.'),
    message('casual', 'The animation looks smoother now.'),
    message('code-context', 'The loop uses continue statements.'),
    message('ai-confirmation', 'Confirmed.', { kind: 'ai', authorId: 'other-helper' }),
    message('agent-confirmation', 'Confirmed.', { authorId: 'other-helper' }),
    message('system-confirmation', 'Confirmed.', { kind: 'system', authorId: 'system' }),
  ]) assert.equal(isHumanConfirmation(request, MEMBERS), false, request.id);
});

test('room prompt carries the request, recent conversation, and shared file text within its budget', () => {
  const request = message('request', 'Codex, explain our jump code.');
  const prompt = buildRoomPrompt({
    roomName: 'Test Room', channelName: 'ideas', request,
    messages: [message('context', 'The player should jump twice.'), request],
    files: [{ path: 'index.html', content: 'const jumpLimit = 2;' }],
  });
  for (const detail of ['Test Room', 'ideas', request.text, 'The player should jump twice.', 'index.html', 'const jumpLimit = 2;']) {
    assert.ok(prompt.includes(detail), `missing ${detail}`);
  }
  const bounded = buildRoomPrompt({
    roomName: 'Test Room', channelName: 'general', request,
    messages: Array.from({ length: 200 }, (_, index) => message(String(index), 'context'.repeat(5_000))),
    files: Array.from({ length: 20 }, (_, index) => ({ path: `file${index}.js`, content: 'file text'.repeat(20_000) })),
  });
  assert.ok(bounded.length <= 32_000, `prompt was ${bounded.length} characters`);
  assert.ok(bounded.includes(request.text), 'large context must not consume the actual request');
});

test('joins as an AI and waits for the initial room state before running the latest request', async (t) => {
  const { agent, sockets, runs } = await fixture(t);
  const started = agent.start();
  await eventually(() => sockets.length === 1, 'socket creation');
  const socket = sockets[0];
  socket.open();
  const { server: ignoredServer, ...joinConfig } = CONFIG;
  assert.deepEqual(socket.sent[0], { type: 'join', ...joinConfig, agent: true });
  socket.receive(snapshot({ messages: [message('old', 'Codex, older question.'), message('latest', 'Codex, latest question.')] }));
  assert.equal(runs.length, 0, 'a snapshot alone is not yet a complete room read');
  socket.receive({ type: 'files', files: [] });
  socket.receive({ type: 'preview', rev: 0 });
  await started;
  await eventually(() => socket.chats.length === 1, 'initial reply');
  assert.equal(runs.length, 1);
  assert.ok(runs[0].prompt.includes('latest question.'));
});

test('future requests use shared room files and reply automatically in their original channel', async (t) => {
  const { connect, runs } = await fixture(t, { fileContents: { 'index.html': 'const sharedRoomMarker = 42;' } });
  const socket = await connect(undefined, { files: ['index.html'] });
  socket.receive({ type: 'chat', message: message('context', 'The character has a double jump.', { channelId: 'ideas-id' }) });
  socket.receive({ type: 'chat', message: message('request', 'Codex, explain index.html.', { channelId: 'ideas-id' }) });
  await eventually(() => socket.chats.length === 1, 'automatic reply');
  assert.equal(runs.length, 1);
  assert.ok(runs[0].prompt.includes('double jump'));
  assert.ok(runs[0].prompt.includes('const sharedRoomMarker = 42;'));
  assert.deepEqual(socket.chats[0], { type: 'chat', channelId: 'ideas-id', text: 'A room answer.', kind: 'ai' });
});

test('live self, system, other-AI broadcasts, and unaddressed messages never start another Codex run', async (t) => {
  const { connect, runs } = await fixture(t);
  const socket = await connect();
  for (const request of [
    message('self', 'Codex, answer again.', { authorId: CONFIG.clientId }),
    message('other-ai', 'Everyone, answer again.', { kind: 'ai', authorId: 'other-helper' }),
    message('system', 'Codex entered.', { kind: 'system' }),
    message('normal', 'Looks good to me.'),
  ]) socket.receive({ type: 'chat', message: request });
  await tick(30);
  assert.equal(runs.length, 0);
  assert.equal(socket.chats.length, 0);
});

test('another AI can collaborate through a direct request and its earlier message remains context', async (t) => {
  const { connect, runs } = await fixture(t);
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('ai-context', 'I suggest a double jump.', { kind: 'ai', authorId: 'other-helper', authorName: 'AI · Helper' }) });
  socket.receive({ type: 'chat', message: message('ai-request', 'Codex, evaluate my suggestion.', { kind: 'ai', authorId: 'other-helper', authorName: 'AI · Helper' }) });
  await eventually(() => socket.chats.length === 1, 'collaborating AI reply');
  assert.equal(runs.length, 1);
  assert.ok(runs[0].prompt.includes('I suggest a double jump.'));
  assert.ok(runs[0].prompt.includes('Codex, evaluate my suggestion.'));
});

test('one AI reply spends the turn and only human confirmation resumes one deferred question', async (t) => {
  const runs = [];
  const { connect } = await fixture(t, { runner: async (request) => {
    runs.push(request);
    return `Collaboration answer ${runs.length}.`;
  } });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('ai-first', 'Codex, collaborate on the first design.', { kind: 'ai', authorId: 'other-helper' }) });
  await eventually(() => socket.chats.length === 1, 'first AI reply');
  socket.receive({ type: 'chat', message: message('ai-deferred', 'Codex, evaluate the pending design question.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs.length, 1, 'the next AI question waits for a person');
  socket.receive({ type: 'chat', message: message('human-casual', 'The animation looks smoother now.') });
  socket.receive({ type: 'chat', message: message('ai-confirmation', 'Confirmed.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs.length, 1, 'casual human chat and AI confirmation cannot reset the turn');
  socket.receive({ type: 'chat', message: message('human-confirmation', 'Codex, continue.') });
  await eventually(() => socket.chats.length === 2, 'one deferred reply after confirmation');
  assert.ok(runs[1].prompt.includes('pending design question'), 'confirmation answers the deferred question');
  await tick(30);
  assert.equal(runs.length, 2, 'confirmation does not create an extra reply of its own');
  socket.receive({ type: 'chat', message: message('ai-deferred-again', 'Codex, another design question.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs.length, 2, 'the resumed AI reply spends the turn again');
});

test('the spent AI turn and its deferred question survive an agent restart', async (t) => {
  const { agent, connect, makeAgent, runs, statePath } = await fixture(t);
  const first = message('ai-before-restart', 'Codex, first AI collaboration.', { kind: 'ai', authorId: 'other-helper' });
  const deferred = message('ai-deferred-restart', 'Codex, preserve this pending AI question.', { kind: 'ai', authorId: 'other-helper' });
  const socket = await connect();
  socket.receive({ type: 'chat', message: first });
  await eventually(() => socket.chats.length === 1 && agent.getStatus().handled === 1, 'acknowledged AI reply');
  socket.receive({ type: 'chat', message: deferred });
  await eventually(async () => (await readFile(statePath, 'utf8')).includes(deferred.id), 'durable deferred question');
  await agent.stop();
  const restarted = makeAgent();
  const restored = await connect(restarted, { messages: [first, deferred] });
  await tick(30);
  assert.equal(runs.length, 1, 'restarting does not grant another AI turn');
  assert.equal(restored.chats.length, 0);
  restored.receive({ type: 'chat', message: message('restart-confirmation', 'Confirmed.') });
  await eventually(() => restored.chats.length === 1, 'persisted question resumed once');
  assert.equal(runs.length, 2);
  assert.ok(runs[1].prompt.includes(deferred.text));
  restored.receive({ type: 'chat', message: message('restart-third-ai', 'Codex, another AI request.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs.length, 2, 'one confirmation allows only one AI reply');
});

test('human confirmation before an AI reply is posted cannot bank a second turn', async (t) => {
  const runs = [], releases = [];
  const { connect } = await fixture(t, { runner: (request) => {
    runs.push(request);
    return new Promise((resolve) => releases.push(resolve));
  } });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('ai-in-flight', 'Codex, an AI request in progress.', { kind: 'ai', authorId: 'other-helper' }) });
  await eventually(() => runs.length === 1, 'in-flight AI invocation');
  socket.receive({ type: 'chat', message: message('too-early-confirmation', 'Continue.') });
  socket.receive({ type: 'chat', message: message('ai-queued-in-flight', 'Codex, wait for confirmation after that reply.', { kind: 'ai', authorId: 'other-helper' }) });
  releases[0]('The first AI reply.');
  await eventually(() => socket.chats.length === 1, 'first posted AI reply');
  await tick(30);
  assert.equal(runs.length, 1, 'an early confirmation cannot authorize an AI-only chain');
  socket.receive({ type: 'chat', message: message('after-reply-confirmation', 'Proceed.') });
  await eventually(() => runs.length === 2, 'deferred AI invocation after a later confirmation');
  releases[1]('The explicitly confirmed AI reply.');
  await eventually(() => socket.chats.length === 2, 'confirmed AI reply');
});

test('replaying an already consumed human confirmation cannot grant another AI turn', async (t) => {
  let runs = 0;
  const { connect } = await fixture(t, { runner: async () => `Answer ${++runs}.` });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('replay-ai-first', 'Codex, first AI question.', { kind: 'ai', authorId: 'other-helper' }) });
  await eventually(() => socket.chats.length === 1, 'first AI reply');
  socket.receive({ type: 'chat', message: message('replay-ai-second', 'Codex, second AI question.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(20);
  const confirmation = message('confirmation-once', 'Confirmed.');
  socket.receive({ type: 'chat', message: confirmation });
  await eventually(() => socket.chats.length === 2, 'confirmed second AI reply');
  socket.receive({ type: 'chat', message: confirmation });
  socket.receive({ type: 'chat', message: message('replay-ai-third', 'Codex, third AI question.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs, 2, 'the same human message cannot authorize two separate AI replies');
  assert.equal(socket.chats.length, 2);
});

test('a human confirmation immediately following the AI acknowledgment counts even in the same millisecond', async (t) => {
  let runs = 0;
  const { agent, connect } = await fixture(t, { autoAck: false, runner: async () => `Same-frame answer ${++runs}.` });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('same-frame-ai-first', 'Codex, first same-frame question.', { kind: 'ai', authorId: 'other-helper' }) });
  await eventually(() => socket.chats.length === 1, 'first unacknowledged AI reply');
  socket.receive({ type: 'chat', message: message('same-frame-ai-second', 'Codex, second same-frame question.', { kind: 'ai', authorId: 'other-helper' }) });
  const posted = message('same-frame-first-reply', socket.chats[0].text, { kind: 'ai', authorId: CONFIG.clientId });
  socket.receive({ type: 'chat', message: posted });
  socket.receive({ type: 'chat', message: message('same-frame-confirmation', 'Confirmed.', { createdAt: posted.createdAt }) });
  await eventually(() => socket.chats.length === 2, 'AI reply authorized by subsequent human confirmation');
  socket.ack();
  await eventually(() => agent.getStatus().handled === 2, 'both acknowledged AI replies');
  socket.receive({ type: 'chat', message: message('same-frame-ai-third', 'Codex, third same-frame question.', { kind: 'ai', authorId: 'other-helper' }) });
  await tick(30);
  assert.equal(runs, 2, 'the confirmation still permits only one additional AI reply');
});

test('AI questions awaiting human confirmation retain a bounded deferred backlog', async (t) => {
  const { agent, connect, runs } = await fixture(t);
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('deferred-bound-first', 'Codex, use the first AI turn.', { kind: 'ai', authorId: 'other-helper' }) });
  await eventually(() => agent.getStatus().handled === 1, 'spent AI turn');
  for (let index = 0; index < 35; index++) {
    socket.receive({ type: 'chat', message: message(`deferred-bound-${index}`, `Codex, deferred question ${index}.`, { kind: 'ai', authorId: 'other-helper' }) });
    await tick();
  }
  await eventually(() => !agent.getStatus().busy, 'settled deferred backlog');
  assert.equal(runs.length, 1, 'a deferred backlog cannot bypass human confirmation');
  assert.ok(agent.getStatus().waiting > 0, 'blocked questions should be retained');
  assert.ok(agent.getStatus().waiting <= 13, 'deferred requests share the bounded outstanding-request budget');
});

test('requests execute serially and duplicate delivery cannot create a second reply', async (t) => {
  const runs = [], releases = [];
  const { connect } = await fixture(t, {
    runner: (request) => { runs.push(request); return new Promise((resolve) => releases.push(resolve)); },
  });
  const socket = await connect();
  const first = message('one', 'Codex, first question.');
  socket.receive({ type: 'chat', message: first });
  socket.receive({ type: 'chat', message: first });
  socket.receive({ type: 'chat', message: message('two', 'Codex, second question.') });
  await eventually(() => runs.length === 1, 'first invocation');
  await tick(20);
  assert.equal(runs.length, 1, 'second invocation waits for the first');
  releases[0]('First answer.');
  await eventually(() => runs.length === 2, 'queued invocation');
  releases[1]('Second answer.');
  await eventually(() => socket.chats.length === 2, 'both replies');
  socket.receive({ type: 'chat', message: first });
  await tick(30);
  assert.equal(runs.length, 2);
  assert.deepEqual(socket.chats.map((reply) => reply.text), ['First answer.', 'Second answer.']);
});

test('a burst of addressed messages has a bounded queue and one active invocation', async (t) => {
  let runs = 0;
  const { agent, connect } = await fixture(t, { runner: ({ signal }) => {
    runs++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }));
  } });
  const socket = await connect();
  for (let index = 0; index < 80; index++) socket.receive({ type: 'chat', message: message(`burst-${index}`, `Codex, question ${index}.`) });
  await eventually(() => runs === 1, 'first invocation');
  assert.ok(agent.getStatus().queued > 0, 'some requests should remain queued');
  assert.ok(agent.getStatus().queued < 79, 'the queue must not accept an unlimited burst');
  assert.equal(runs, 1);
});

test('an oversized answer fits room chat without splitting a Unicode character', async (t) => {
  const { connect } = await fixture(t, { runner: async () => '💡'.repeat(5_000) });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('large-answer', 'Codex, give a long answer.') });
  await eventually(() => socket.chats.length === 1, 'bounded reply');
  const answer = socket.chats[0].text;
  assert.ok(answer.length <= 7_900);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(answer));
});

test('a failed Codex invocation does not expose diagnostics and later requests still run', async (t) => {
  let runs = 0;
  const { connect } = await fixture(t, { runner: async () => {
    if (runs++ === 0) throw new Error('private diagnostic credentials must stay local');
    return 'Recovered answer.';
  } });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('failed', 'Codex, first attempt.') });
  await eventually(() => runs === 1, 'failed invocation');
  await tick(20);
  socket.receive({ type: 'chat', message: message('recovered', 'Codex, second attempt.') });
  await eventually(() => socket.chats.some((reply) => reply.text === 'Recovered answer.'), 'recovered reply');
  assert.equal(runs, 2);
  assert.ok(!JSON.stringify(socket.chats).includes('private diagnostic credentials'));
});

test('acknowledged requests stay deduplicated across an agent restart', async (t) => {
  const { agent, connect, makeAgent, runs, statePath } = await fixture(t);
  const request = message('persistent-request', 'Codex, remember that this was handled.');
  const socket = await connect();
  socket.receive({ type: 'chat', message: request });
  await eventually(() => socket.chats.length === 1, 'reply');
  await eventually(async () => {
    try { return (await readFile(statePath, 'utf8')).includes(request.id); } catch { return false; }
  }, 'durable request receipt');
  await agent.stop();
  const restarted = makeAgent();
  const secondSocket = await connect(restarted, { messages: [request] });
  await tick(30);
  assert.equal(runs.length, 1, 'a restart does not regenerate an acknowledged answer');
  assert.equal(secondSocket.chats.length, 0);
});

test('stopping during the second request preserves it and the queued third request across restart', async (t) => {
  const runs = [];
  const { agent, connect, makeAgent } = await fixture(t, { runner: (request) => {
    runs.push(request);
    if (runs.length === 2) {
      return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }));
    }
    return Promise.resolve(`Answer from invocation ${runs.length}.`);
  } });
  const requests = [
    message('queued-first', 'Codex, first queued request.'),
    message('queued-second', 'Codex, second queued request.'),
    message('queued-third', 'Codex, third queued request.'),
  ];
  const socket = await connect();
  for (const request of requests) socket.receive({ type: 'chat', message: request });
  await eventually(() => runs.length === 2 && agent.getStatus().handled === 1, 'second invocation after first receipt');
  const firstReply = message('queued-first-reply', socket.chats[0].text, { kind: 'ai', authorId: CONFIG.clientId });
  await agent.stop();
  const restarted = makeAgent();
  const restored = await connect(restarted, { messages: [...requests, firstReply] });
  await eventually(() => restored.chats.length === 2 && restarted.getStatus().handled === 3, 'remaining requests after restart');
  assert.equal(runs.length, 4, 'first request runs once, canceled second retries once, and third runs once');
  assert.deepEqual(restored.chats.map((reply) => reply.text), ['Answer from invocation 3.', 'Answer from invocation 4.']);
});

test('reconnect recovers a lost delivery acknowledgment from room history without reposting', async (t) => {
  const { connect, sockets, runs } = await fixture(t, { autoAck: false });
  const request = message('lost-ack-request', 'Codex, answer once even if the connection drops.');
  const socket = await connect();
  socket.receive({ type: 'chat', message: request });
  await eventually(() => socket.chats.length === 1, 'unacknowledged reply');
  const delivered = message('stored-reply', socket.chats[0].text, { authorId: CONFIG.clientId, authorName: 'AI · Codex', kind: 'ai' });
  socket.disconnect();
  await eventually(() => sockets.length === 2, 'reconnection');
  const restored = sockets[1];
  restored.open();
  restored.receive(snapshot({ messages: [request, delivered] }));
  restored.receive({ type: 'files', files: [] });
  restored.receive({ type: 'preview', rev: 0 });
  await tick(50);
  assert.equal(runs.length, 1);
  assert.equal(restored.chats.length, 0, 'history acknowledgment prevents sending the same answer twice');
});

test('an answer absent from room history is recovered from the outbox without running Codex again', async (t) => {
  const { agent, connect, sockets, runs } = await fixture(t, { autoAck: false });
  const request = message('outbox-request', 'Codex, keep the answer if delivery fails.');
  const socket = await connect();
  socket.receive({ type: 'chat', message: request });
  await eventually(() => socket.chats.length === 1, 'first delivery attempt');
  socket.disconnect();
  await eventually(() => sockets.length === 2, 'reconnection');
  const restored = sockets[1];
  restored.autoAck = true;
  restored.open();
  restored.receive(snapshot({ messages: [request] }));
  restored.receive({ type: 'files', files: [] });
  restored.receive({ type: 'preview', rev: 0 });
  await eventually(() => restored.chats.length === 1 && agent.getStatus().pending === 0, 'outbox delivery acknowledgment');
  assert.equal(runs.length, 1, 'a saved answer does not require another model call');
  assert.equal(restored.chats[0].text, socket.chats[0].text);
});

test('a socket entering CLOSING before its close event retains the answer and recovers without another model call', async (t) => {
  let currentSocket, runs = 0;
  const { agent, connect, sockets } = await fixture(t, {
    ackTimeoutMs: 20, fileTimeoutMs: 20,
    runner: async () => {
      runs++;
      currentSocket.readyState = 2;
      return 'The answer survives a closing socket.';
    },
  });
  currentSocket = await connect();
  const request = message('closing-request', 'Codex, retain this reply during connection shutdown.');
  currentSocket.receive({ type: 'chat', message: request });
  await eventually(() => agent.getStatus().pending === 1 && !agent.getStatus().busy, 'retained answer on CLOSING socket');
  assert.equal(currentSocket.chats.length, 0, 'CLOSING sockets cannot send room chat');
  await tick(40); // A failed send must not leave a later unhandled acknowledgment rejection.
  currentSocket.disconnect();
  await eventually(() => sockets.length === 2, 'reconnection after close event');
  const restored = sockets[1];
  restored.open();
  restored.receive(snapshot({ messages: [request] }));
  restored.receive({ type: 'files', files: [] });
  restored.receive({ type: 'preview', rev: 0 });
  await eventually(() => restored.chats.length === 1 && agent.getStatus().pending === 0, 'recovered retained reply');
  assert.equal(runs, 1, 'socket state changes do not require regenerating the answer');
  assert.equal(restored.chats[0].text, 'The answer survives a closing socket.');
});

test('reconnect backfills requests received while offline without repeating previous work', async (t) => {
  const { connect, sockets, runs, statePath } = await fixture(t);
  const original = message('original', 'Codex, initial request.');
  const socket = await connect();
  socket.receive({ type: 'chat', message: original });
  await eventually(async () => {
    try { return (await readFile(statePath, 'utf8')).includes(original.id); } catch { return false; }
  }, 'first acknowledged request');
  socket.disconnect();
  await eventually(() => sockets.length === 2, 'reconnection');
  const restored = sockets[1];
  restored.open();
  restored.receive(snapshot({ messages: [original, message('offline-one', 'Codex, offline first.'), message('offline-two', 'Codex, offline second.')] }));
  restored.receive({ type: 'files', files: [] });
  restored.receive({ type: 'preview', rev: 0 });
  await eventually(() => restored.chats.length === 2, 'both missed requests');
  assert.equal(runs.length, 3);
});

test('permission revocation prevents posting and a completed answer waits until chat returns', async (t) => {
  let release;
  const runs = [];
  const { connect } = await fixture(t, { runner: (request) => {
    runs.push(request);
    return new Promise((resolve) => { release = resolve; });
  } });
  const socket = await connect();
  socket.receive({ type: 'chat', message: message('revoked', 'Codex, answer after a permission change.') });
  await eventually(() => runs.length === 1, 'invocation');
  socket.receive({ type: 'perms', role: 'viewer', can: [] });
  release('The completed answer.');
  await tick(30);
  assert.equal(socket.chats.length, 0, 'revoked chat permission blocks delivery');
  socket.receive({ type: 'perms', role: 'member', can: ['chat'] });
  await eventually(() => socket.chats.length === 1, 'delivery after permission restoration');
  assert.equal(socket.chats[0].text, 'The completed answer.');
  assert.equal(runs.length, 1);
});

test('a viewer cannot start Codex and stop prevents a late runner result from posting', async (t) => {
  let release;
  const runs = [];
  const { agent, connect } = await fixture(t, { runner: (request) => {
    runs.push(request);
    return new Promise((resolve) => { release = resolve; });
  } });
  const socket = await connect(undefined, { can: [] });
  socket.receive({ type: 'chat', message: message('viewer', 'Codex, no chat permission yet.') });
  await tick(30);
  assert.equal(runs.length, 0);
  socket.receive({ type: 'perms', role: 'member', can: ['chat'] });
  socket.receive({ type: 'chat', message: message('active', 'Codex, work that will be stopped.') });
  await eventually(() => runs.length === 1, 'active invocation');
  const stopped = agent.stop();
  release('This must not get posted.');
  await stopped;
  await tick(30);
  assert.equal(socket.chats.length, 0);
  assert.equal(runs[0].signal.aborted, true);
});

test('replacement by another client stops the agent without fighting for the helper identity', async (t) => {
  const { agent, connect, sockets } = await fixture(t);
  const socket = await connect();
  socket.receive({ type: 'error', code: 'replaced', message: 'This room was opened somewhere else.' });
  socket.close();
  await tick(50);
  assert.equal(sockets.length, 1, 'a replaced connection must not reconnect');
  assert.equal(agent.getStatus().stopped, true);
});
