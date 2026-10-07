# Contributing

Thanks for wanting to help. This project is small on purpose, so a few rules keep it that way.

## Run it

```bash
npm install
npm run dev      # room server + app on http://localhost:5174
npm run check    # merge-conflict markers, broken JSON, type errors
```

You need Node.js 20 or newer and Git.

## What makes a good change

- **Small and focused.** One thing per pull request, with a short description of what and why.
- **Thin code, few dependencies.** Please do not add a package for something a few lines can do. If you must, say why.
- **Safe for strangers.** The server talks to people you do not know. Check permissions on the server, never only in the browser. New commands go on a fixed list, never a passthrough to git or a shell.
- **Plain and readable.** No clever tricks. Comments say why, not what.
- **Test what you change.** Run it with two browsers (one private window) when it touches rooms or editing.

## Never commit

`server/data/`, `server/config.json`, `.env` files, `node_modules/`, or anything with a key, token, or password. A secret scanner runs in CI and before pushes, but do not rely on it.

## Pull requests

1. Fork, make a branch, make your change.
2. Run `npm run check`.
3. Open a pull request and fill in the template.

## Using an AI to help

Fine, and this project is built for it. You are still responsible for what you submit: read it, run it, and say in the pull request that an AI helped. Read `AGENTS.md` first, because it is the rulebook AI helpers follow here.

## Questions and ideas

Open an issue. For anything about security, use the private route in [SECURITY.md](SECURITY.md).
