# Security

Game Table runs a server on your own computer that people connect to, so security reports are taken seriously.

## Reporting a problem

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what it could let someone do. You will get a reply as soon as the maintainer can, and credit in the fix if you want it.

## What is in scope

- Getting into a room without an invite, or getting more power than your role allows.
- Reading or changing files outside the room's repo, or reaching the server's files.
- Escaping the game preview sandbox to reach the app, the room, or a person's login.
- An AI helper doing something its limits should block (deleting files, changing settings, merging).
- Leaking invite keys, session cookies, or the Discord login secret.
- Slash commands running anything outside the fixed list.

## What is not a bug

These are known limits, written down in the README under "What to know first": identity is one browser and not an account, authorship colors are self-declared, and text written by other people can try to give orders to an AI.

## If you run a room

- Keep `server/config.json` and `server/data/` private. They are git-ignored on purpose. Never commit them.
- Turn on **new people join as viewers**, and protect `main` on GitHub so nothing changes it without a pull request.
- Only invite people you trust to edit files. Saves go out under your GitHub login.

Only the latest version on `main` is supported.
