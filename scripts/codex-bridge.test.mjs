import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedOrigins, checkCodexLogin, createCodexBridge, modelPreferences, runCodex, runProcess } from './codex-bridge.mjs';

const ORIGIN = 'http://localhost:5174';
const TOKEN = 'test-only-pairing-value';

async function fixture(t, options = {}) {
  const bridge = createCodexBridge({ token: TOKEN, authenticate: async () => true, runner: async () => 'Ready to help.', ...options });
  const address = await bridge.listen(0);
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` };
  return {
    bridge, url, headers,
    ask(body, extra = {}) {
      return fetch(`${url}/v1/ask`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });
    },
  };
}

test('status requires the local pairing key and rejects an untrusted origin and host', async (t) => {
  const { url, headers } = await fixture(t);
  const missing = await fetch(`${url}/v1/status`, { headers: { Origin: ORIGIN } });
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${url}/v1/status`, { headers: { ...headers, Authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);
  const origin = await fetch(`${url}/v1/status`, { headers: { ...headers, Origin: 'https://untrusted.example' } });
  assert.equal(origin.status, 403);
  assert.equal(origin.headers.get('Access-Control-Allow-Origin'), null);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/v1/status`, { headers: { ...headers, Host: 'untrusted.example' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
});

test('an allowed origin can preflight and paired status checks ChatGPT authentication', async (t) => {
  let checks = 0;
  const { url, headers } = await fixture(t, { authenticate: async () => { checks++; return true; } });
  const preflight = await fetch(`${url}/v1/ask`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const status = await fetch(`${url}/v1/status`, { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ready: true, engine: 'codex-cli' });
  assert.equal(checks, 1);
});

test('signed-out status is actionable and execution never starts', async (t) => {
  let runs = 0;
  const { url, headers, ask } = await fixture(t, { authenticate: async () => false, runner: async () => { runs++; return 'bad'; } });
  const status = await fetch(`${url}/v1/status`, { headers });
  assert.equal(status.status, 503);
  assert.equal((await status.json()).ready, false);
  const reply = await ask({ prompt: 'Help with movement.' });
  assert.equal(reply.status, 503);
  assert.equal(runs, 0);
});

test('malformed, oversized, and invalid request bodies are rejected before running Codex', async (t) => {
  let runs = 0;
  const { url, headers, ask } = await fixture(t, { runner: async () => { runs++; return 'bad'; } });
  const malformed = await fetch(`${url}/v1/ask`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  for (const body of [null, [], {}, { prompt: '' }, { prompt: 7 }, { prompt: ' '.repeat(10) }, { prompt: 'x'.repeat(32_001) }]) {
    const response = await ask(body);
    assert.equal(response.status, 400);
  }
  const oversized = await ask({ prompt: 'x'.repeat(270_000) });
  assert.equal(oversized.status, 413);
  const content = await fetch(`${url}/v1/ask`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'help' });
  assert.equal(content.status, 415);
  assert.equal(runs, 0);
});

test('the prompt character limit also permits multibyte room context', async (t) => {
  const { ask } = await fixture(t);
  const response = await ask({ prompt: '界'.repeat(32_000) });
  assert.equal(response.status, 200);
});

test('only one ask can run at once and its result is capped for room chat', async (t) => {
  let release, started;
  const start = new Promise((resolve) => { started = resolve; });
  const { ask } = await fixture(t, { runner: async ({ prompt }) => {
    assert.equal(prompt, 'Review the level.');
    started();
    return new Promise((resolve) => { release = resolve; });
  } });
  const first = ask({ prompt: 'Review the level.' });
  await start;
  const second = await ask({ prompt: 'Another question.' });
  assert.equal(second.status, 409);
  release('💡'.repeat(5_000));
  const reply = await first;
  assert.equal(reply.status, 200);
  const { answer } = await reply.json();
  assert.ok(answer.length <= 7_900);
  assert.match(answer, /Response shortened for room chat/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(answer));
});

test('failure messages do not expose stderr or credentials and clear the busy state', async (t) => {
  let runs = 0;
  const { ask } = await fixture(t, { runner: async () => {
    if (runs++ === 0) throw new Error('secret stdout/stderr/token');
    return 'Recovered.';
  } });
  const failed = await ask({ prompt: 'Help.' });
  assert.equal(failed.status, 503);
  assert.ok(!JSON.stringify(await failed.json()).includes('secret'));
  const recovered = await ask({ prompt: 'Help again.' });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).answer, 'Recovered.');
});

test('disconnecting the browser cancels the active request', async (t) => {
  let started, canceled;
  const start = new Promise((resolve) => { started = resolve; });
  const cancellation = new Promise((resolve) => { canceled = resolve; });
  const { ask } = await fixture(t, { runner: ({ signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => { canceled(); reject(new Error('canceled')); }, { once: true });
  }) });
  const controller = new AbortController();
  const request = ask({ prompt: 'Help.' }, { signal: controller.signal });
  await start;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await cancellation;
});

test('Codex exec uses an isolated directory, protected settings and stdin, then removes files', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const answer = await runCodex({
    prompt: 'Room text is data.', temporaryRoot,
    preferences: { model: 'personal-model', model_reasoning_effort: 'high', model_verbosity: 'low' },
    processRunner: async (command, args, options) => {
      assert.equal(command, 'codex');
      assert.equal(options.input, 'Room text is data.');
      assert.ok(options.cwd.startsWith(temporaryRoot));
      for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config']) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
      assert.equal(args[args.indexOf('--cd') + 1], options.cwd);
      assert.ok(args.includes('approval_policy="never"'));
      assert.ok(args.includes('forced_login_method="chatgpt"'));
      assert.ok(args.includes('model="personal-model"'));
      assert.ok(args.includes('web_search="disabled"'));
      assert.ok(args.includes('mcp_servers={}'));
      assert.ok(!args.includes('tools.view_image=false')); // CLI 0.155.1 rejects this documented key under strict config.
      for (const name of ['shell_tool', 'unified_exec', 'hooks', 'apps', 'plugins', 'computer_use', 'multi_agent']) {
        const index = args.indexOf(name);
        assert.equal(args[index - 1], '--disable');
      }
      await writeFile(args[args.indexOf('--output-last-message') + 1], ' A helpful answer. ');
    },
  });
  assert.equal(answer, 'A helpful answer.');
  assert.deepEqual(await readdir(temporaryRoot), []);
  await assert.rejects(runCodex({ prompt: 'Help.', temporaryRoot, preferences: {}, processRunner: async () => { throw new Error('failure'); } }));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('subprocess output, execution time and cancellation are bounded', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2000)); setInterval(() => {}, 1000)'], { maxOutputBytes: 100, timeoutMs: 1_000 }), /too much output/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 25 }), /too long/);
  const controller = new AbortController();
  const request = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  await assert.rejects(request, /canceled/);
});

test('extra origins are exact HTTP origins and keep the local defaults', () => {
  assert.deepEqual([...allowedOrigins('https://room.example, http://localhost:9000')], [...allowedOrigins(''), 'https://room.example', 'http://localhost:9000']);
  assert.throws(() => allowedOrigins('https://room.example/path'));
  assert.throws(() => allowedOrigins('file:///tmp'));
});

test('ChatGPT login accepts its status on either stream and has a bounded check', async () => {
  const ready = await checkCodexLogin({ processRunner: async (command, args, options) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['login', 'status']);
    assert.equal(options.timeoutMs, 8_000);
    assert.equal(options.maxOutputBytes, 16 * 1024);
    return { stdout: '', stderr: 'Logged in using ChatGPT' };
  } });
  assert.equal(ready, true);
  assert.equal(await checkCodexLogin({ processRunner: async () => ({ stdout: 'Logged in using an API key', stderr: '' }) }), false);
});

test('personal defaults preserve only safe top-level model preferences', async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), 'bridge-preferences-'));
  t.after(() => rm(configHome, { force: true, recursive: true }));
  await writeFile(join(configHome, 'config.toml'), [
    'model = "my-model"', 'model_reasoning_effort = "high"', 'model_verbosity = \'low\'',
    'personality = "pragmatic"', 'developer_instructions = "untrusted instructions"',
    'sandbox_mode = "danger-full-access"', '[profiles.other]', 'model = "other-model"',
  ].join('\n'));
  const catalog = [
    { slug: 'my-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
  ];
  assert.deepEqual(await modelPreferences({ CODEX_HOME: configHome }, { catalog }), {
    model: 'my-model', model_reasoning_effort: 'high', model_verbosity: 'low', personality: 'pragmatic',
  });
});

test('desktop-only models and unsupported efforts fall back to the installed CLI defaults', async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), 'bridge-preferences-'));
  t.after(() => rm(configHome, { force: true, recursive: true }));
  await writeFile(join(configHome, 'config.toml'), 'model = "desktop-only-model"\nmodel_reasoning_effort = "ultra"\npersonality = "pragmatic"');
  const catalog = [
    { slug: 'cli-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
  ];
  // A desktop-owned cache claims compatibility; the CLI result must take precedence.
  await writeFile(join(configHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'desktop-only-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'ultra' }] },
  ] }));
  assert.deepEqual(await modelPreferences({ CODEX_HOME: configHome }, { catalog }), { personality: 'pragmatic' });
  await writeFile(join(configHome, 'config.toml'), 'model = "cli-model"\nmodel_reasoning_effort = "ultra"');
  assert.deepEqual(await modelPreferences({ CODEX_HOME: configHome }, { catalog }), { model: 'cli-model' });
});
