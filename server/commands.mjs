// Slash commands for the room chat. People and AI helpers type them the same way.
// A fixed list, run by the server. There is no passthrough to git or gh: the server holds the
// owner's GitHub login, so strangers only ever get these named operations.
import { execFile } from 'node:child_process';

export class CommandError extends Error {}

const MAX_LINE = 120;
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LINE);

/* ---------- GitHub API, using the same login git already has ---------- */

let cachedToken = { value: '', at: 0 };

function credentialFill() {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      { timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => resolve(error ? '' : /^password=(.*)$/m.exec(stdout)?.[1]?.trim() ?? ''),
    );
    child.stdin?.end('protocol=https\nhost=github.com\n\n');
  });
}

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (cachedToken.value && Date.now() - cachedToken.at < 5 * 60_000) return cachedToken.value;
  const value = await credentialFill();
  cachedToken = { value, at: Date.now() };
  return value;
}

async function api(method, path, body) {
  const key = await token();
  if (!key) throw new CommandError('The server has no GitHub login to use for that.');
  let response;
  try {
    response = await fetch('https://api.github.com' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'game-table-2',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CommandError('Could not reach GitHub.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new CommandError('GitHub said no (' + response.status + '): ' + clean(data.message));
  return data;
}

const slugOf = (web) => /github\.com\/([\w.-]+\/[\w.-]+)$/.exec(web)?.[1] ?? '';

function need(value) {
  if (!value) throw new CommandError('Connect a GitHub repo to this room first.');
  return value;
}

/* ---------- The commands ---------- */

// perm: the room permission needed to run it. limit: counts against the GitHub-writes allowance.
export const COMMANDS = [
  { name: 'help', args: '', help: 'List what you can run here.', perm: 'chat', run: ({ list }) => list() },
  { name: 'rules', args: '', help: 'The rules every AI helper follows in this project.', perm: 'chat', run: ({ rules }) => rules },
  {
    name: 'status', args: '', help: 'Branch, unsaved changes, how far behind main.', perm: 'github:read',
    async run({ repo }) {
      const s = await need(repo).look('status');
      return 'Branch ' + s.branch + ' (base ' + s.base + '). ' + s.ahead + ' ahead, ' + s.behind + ' behind. ' + s.changed + ' unsaved file(s).';
    },
  },
  {
    name: 'log', args: '[count]', help: 'Recent saves on the room branch.', perm: 'github:read',
    async run({ repo, args }) {
      const count = Math.min(Math.max(parseInt(args[0], 10) || 8, 1), 15);
      return (await need(repo).look('log', count)).split('\n').map(clean).join('\n') || 'No commits yet.';
    },
  },
  {
    name: 'diff', args: '', help: 'What this branch changed compared to main.', perm: 'github:read',
    async run({ repo }) {
      return (await need(repo).look('diff')).split('\n').slice(-20).map(clean).join('\n') || 'No differences from main.';
    },
  },
  {
    name: 'branch', args: '', help: 'The branch and its GitHub link.', perm: 'github:read',
    run({ repo, web }) {
      const info = need(repo).info();
      return info.branch + (web ? '\n' + web + '/tree/' + info.branch.split('/').map(encodeURIComponent).join('/') : '');
    },
  },
  {
    name: 'update', args: '', help: 'Pull the latest main into this room branch.', perm: 'github:write', limit: true,
    run: ({ repo }) => need(repo).updateFromBase(),
  },
  {
    name: 'issues', args: '', help: 'Open issues (latest 8).', perm: 'github:read',
    async run({ web }) {
      const list = (await api('GET', '/repos/' + need(slugOf(web)) + '/issues?state=open&per_page=8')).filter((item) => !item.pull_request);
      return list.map((item) => '#' + item.number + ' ' + clean(item.title)).join('\n') || 'No open issues.';
    },
  },
  {
    name: 'issue', args: 'new <title> | <number>', help: 'Open a new issue, or look one up.', perm: 'github:read',
    async run({ web, args, allowed, spend, by }) {
      const slug = need(slugOf(web));
      if (args[0] === 'new') {
        if (!allowed('github:write')) throw new CommandError("You don't have permission to open issues.");
        const title = clean(args.slice(1).join(' '));
        if (!title) throw new CommandError('Usage: /issue new <title>');
        spend();
        const made = await api('POST', '/repos/' + slug + '/issues', { title, body: 'Opened from the Game Table by ' + by + '.' });
        return 'Opened #' + made.number + ': ' + made.html_url;
      }
      const number = parseInt(args[0], 10);
      if (!number) throw new CommandError('Usage: /issue new <title>   or   /issue <number>');
      const item = await api('GET', '/repos/' + slug + '/issues/' + number);
      return '#' + item.number + ' [' + item.state + '] ' + clean(item.title) + '\n' + item.html_url;
    },
  },
  {
    name: 'pr', args: '[open]', help: "This branch's pull request, or open one.", perm: 'github:read',
    async run({ web, repo, args, allowed, spend, by }) {
      const slug = need(slugOf(web));
      const { branch, base } = need(repo).info();
      if (!branch || branch === base) throw new CommandError('This room is not on its own branch yet.');
      const found = await api('GET', '/repos/' + slug + '/pulls?state=open&head=' + encodeURIComponent(slug.split('/')[0] + ':' + branch));
      if (found[0]) return 'PR #' + found[0].number + ': ' + clean(found[0].title) + '\n' + found[0].html_url;
      if (args[0] !== 'open') return 'No open pull request for ' + branch + '. Type /pr open to make one.';
      if (!allowed('github:write')) throw new CommandError("You don't have permission to open pull requests.");
      spend();
      const made = await api('POST', '/repos/' + slug + '/pulls', {
        title: 'Changes from ' + branch,
        head: branch,
        base,
        body: 'Opened from the Game Table by ' + by + '. Review the diff before merging.',
      });
      return 'Opened PR #' + made.number + ': ' + made.html_url;
    },
  },
  {
    name: 'merge', args: '<number> confirm', help: 'Merge a pull request. Room owner only.', perm: 'github:merge', limit: true,
    async run({ web, args }) {
      const slug = need(slugOf(web));
      const number = parseInt(args[0], 10);
      if (!number) throw new CommandError('Usage: /merge <number> confirm');
      if (args[1] !== 'confirm') {
        const pr = await api('GET', '/repos/' + slug + '/pulls/' + number);
        return 'About to merge #' + number + ' "' + clean(pr.title) + '" into ' + pr.base.ref + '. Type /merge ' + number + ' confirm to do it.';
      }
      const done = await api('PUT', '/repos/' + slug + '/pulls/' + number + '/merge', { merge_method: 'merge' });
      return done.merged ? 'Merged #' + number + '.' : 'Not merged: ' + clean(done.message);
    },
  },
];

// The commands this person can run, as the browser shows them in its / menu.
export function commandsFor(allowed) {
  return COMMANDS.filter((command) => allowed(command.perm)).map(({ name, args, help }) => ({ name, args, help }));
}

export const isSlash = (text) => /^\/[a-z]/i.test(text);

// Runs one typed command. Returns the text to post, or throws CommandError for a private notice.
// context: allowed(action), spend() (throws if too fast), repo, web, rules, by.
export async function runCommand(text, context) {
  const [word, ...args] = text.slice(1).trim().split(/\s+/);
  const command = COMMANDS.find((candidate) => candidate.name === word.toLowerCase());
  if (!command) throw new CommandError('No command called /' + clean(word) + '. Type /help.');
  if (!context.allowed(command.perm)) throw new CommandError("You don't have permission to run /" + command.name + '.');
  if (command.limit) context.spend();
  try {
    return await command.run({
      ...context,
      args,
      list: () => commandsFor(context.allowed).map((item) => '/' + item.name + (item.args ? ' ' + item.args : '') + ' — ' + item.help).join('\n'),
    });
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(clean(error.message) || 'That command failed.');
  }
}
