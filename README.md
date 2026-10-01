# Game Table

A shared studio for making things together, with your friends and their AI helpers, in one live room.

Think Discord for the room (channels, chat, members) plus Google Docs for the work (everyone edits the same files at once, with colored cursors), backed by a GitHub repo so nothing is ever lost. The first use case is game development, and there is a live game preview next to the editor.

> **Early software.** It works for small groups of people you trust. Read [What to know first](#what-to-know-first) before you put it in front of strangers.

---

## What you can do

- **Talk** in channels, like Discord.
- **Edit files together, live.** Simultaneous typing merges. You see everyone's cursor and selection, and every stretch of text is tinted by who wrote it.
- **Save to GitHub automatically.** Edits go to a branch of the room's own. A **Propose** button opens a GitHub pull request, so the main branch only changes when your group accepts something.
- **Play the game while you build it.** A preview pane runs the repo's `index.html` in a sandbox and reloads when files change.
- **Bring AI helpers.** Anyone's AI (Claude Code, Codex, a local model, a script) can join through a small command-line tool, listen, talk, and edit files live, labeled as AI.
- **Run the room.** Owner and admins set roles, remove people, and delete channels. Deleted files can be restored, and every saved version can be brought back.

---

## Quick start

You need:

- **Node.js 20 or newer**
- **Git**, already signed in to GitHub on your computer (if you can `git push` from a terminal, you are set)

```bash
npm install
npm run dev
```

Open **http://localhost:5174**, create a room, and you are in. `npm run dev` starts both the room server and the web app. Press **Ctrl+C** to stop. It finishes saving first, so you do not lose typing.

To use a GitHub repo, paste `owner/name` into the **GitHub repo** box when you create a room, or click **CONNECT** in the sidebar of an existing room. The repo must be one your GitHub login can push to.

---

## Bring friends in

Your computer runs the room, so friends need a way to reach it. The simplest is a free tunnel:

1. `npm run share` (builds the app and serves it on port 4173)
2. In a second terminal: `npx cloudflared tunnel --url http://localhost:4173`
3. It prints an address ending in `.trycloudflare.com`.
4. **Open that address yourself**, create your room there, and copy the invite. The invite is built from whatever address you opened the app on, so if you create the room on `localhost`, the link will say localhost and will not work for anyone else.
5. Send the invite to your friends.

The tunnel address changes every time you restart it. Old invites stop working, but rooms and their history are kept on your computer. Resume the room and copy a fresh invite.

---

## AI helpers

Each person can bring their own AI. It runs on their computer with their own keys, and talks to the room through a small command-line tool, the separate **game-table-cli** repo. It shows up as **AI · Name**, has less power than a person, and cannot delete files, run the room, or change settings.

Friends clone that repo, run `npm install`, and sign in with your invite link. Its README has the setup, the commands, and the safety rules to give an AI.

### Use your own Codex from chat

If you already use OpenAI Codex CLI with your ChatGPT sign-in, the room can send a message to it and bring the reply back. Each person connects the CLI running on their own computer.

1. Run `codex login` if your CLI is not signed in with ChatGPT yet.
2. Start `npm run bridge` in a second terminal. For local development, `npm run dev:codex` starts the app and the bridge together instead.
3. In the room sidebar, open **MY AI → CONNECT MY AI**, paste the pairing key printed in your terminal, and click **CONNECT**.
4. Type a prompt and click **ASK MY AI**, or use **ASK MY AI** under a message already in the channel. Selecting part of your draft asks about that text.
5. Choose the reply destination. **Insert at chat cursor** puts the reply at the text cursor you had when you asked, preserving the rest of your draft and following edits made while Codex works. Click **SEND** to share that draft; it is labeled as AI. **Post to chat automatically** sends the response directly to the original channel, labeled **AI · Your Name**.

Codex receives your prompt and up to 24 recent messages from that channel. It runs in a temporary read-only workspace for each request, with execution and external tool integrations disabled. It cannot edit your local project or the room's files through this chat connection. Replies go into the **chat input**, not the shared file editor.

Compatible personal model and response preferences are reused. Model names that are available only in the desktop app fall back to the CLI's own defaults. This integration was verified with Codex CLI 0.155.1.

ASK MY AI sends your prompt and the last 24 messages of the channel to your own AI. Nobody else in the room is told when you do.

The pairing key stays in your browser tab and goes only to the local bridge at `http://127.0.0.1:43198`. Your CLI credentials stay on your computer. The bridge must remain running; restarting it creates a new key, so connect again. You can cancel an in-progress request. Cursor replies are kept for recovery if you change rooms or channels before they arrive. Automatic chat replies still go to the original channel. When a reply cannot be delivered because you left, disconnected, or lost permissions, the UI keeps it for copying, posting to its original channel, or discarding.

For a room opened through a tunnel, start the bridge with that exact page origin allowed:

```bash
GAME_TABLE_ORIGINS=https://your-room.trycloudflare.com npm run bridge
```

When prompted by your browser, allow the room page to access your local network. The room server and tunnel do not carry the pairing key or launch your CLI.

---

## How GitHub is used

If you only ever used GitHub to back up a project, here is what is different.

- The server keeps a copy of your repo on your computer.
- About 8 to 30 seconds after typing stops, it saves a snapshot (a **commit**) and uploads it (a **push**). It also checks GitHub every minute, so edits made on github.com show up in the room.
- Saves go to a **branch** named like `table/my-room-3fa9c1`, not to `main`. `main` stays the accepted version.
- **PROPOSE TO MAIN** opens GitHub's pull request page, prefilled. Review and merge it there.
- Recommended: on GitHub, protect `main` (Settings, then Rules, then require a pull request before merging), so nothing can change it directly.

---

## Roles

| Role | Can do |
| --- | --- |
| **Owner** (made the room) | Everything, including connecting the repo, settings, and a new invite link |
| **Admin** | Run the room: set roles below them, remove people, delete channels, restore files |
| **Member** (default) | Chat, edit and create files, restore files |
| **Viewer** | Watch only |

Room settings (owner): members can create channels, members can delete files, and **new people join as viewers**, which is the best defense when strangers might show up. **NEW INVITE LINK** makes old invite links stop working while people already in the room stay.

---

## What to know first

- **Everything runs on your computer.** Rooms, chat, and the GitHub copy live in `server/data/`. If your computer is off, the room is off.
- **Saves go out under your GitHub login.** Anyone you let edit files can change your repo's branch. Only invite people you trust, and use viewers-first joining.
- **A repo may be public.** Do not put keys, passwords, or private files in the room. A scanner blocks obvious secrets (private keys, GitHub tokens, `sk-` style keys) from being pushed, but it cannot catch everything.
- **Identity is one browser, not an account.** A removed person is blocked by browser and, behind the tunnel, by connection address. Someone determined can come back from a private window or another network. Use **new people join as viewers** and **NEW INVITE LINK**. Real accounts are the lasting fix.
- **Authorship colors are self-declared** by each person's browser. They are a record for the team, not proof.
- **To test as a second person, use a private window or another browser.** Two tabs in one browser are the same person.
- **The game preview cannot use `localStorage`**, because it runs in a sandbox.
- **Text from other people can try to give orders to an AI.** The CLI wraps everything it reads from the room and marks it untrusted, and the guide tells the AI to treat it as data. That reduces the risk. It cannot remove it.

---

## Project layout

```
src/        the web app (rooms, chat, editor, preview)
server/     the room server, the GitHub sync, and the game preview
cli/        the AI helper command line. It is its own repo (game-table-cli), git-ignored here
scripts/    the script behind npm run dev
INTENT.md   why this exists and where it is going
```

`server/data/` is created at runtime (rooms, invite keys, connection addresses, repo copies). It is git-ignored and must never be committed.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | room server plus app, for development |
| `npm run dev:codex` | development app plus your local Codex bridge |
| `npm run bridge` | your local Codex connection, with a new pairing key |
| `npm run test:bridge` | local bridge authentication, request, and process checks |
| `npm run test:codex` | bridge plus chat cursor and prompt-context regressions |
| `npm run share` | built app plus room server on port 4173, for the tunnel |
| `npm run typecheck` | checks the code for type errors |
| `npm run table -- <command>` | runs the AI helper command line, if you have the game-table-cli folder in here |

---

## Status and plans

Working: rooms, channels, live editing with cursors and authorship, GitHub sync on branches, game preview, roles and permissions, flood limits, undo and history, AI helpers through the CLI.

Not yet: real accounts, custom roles, per-channel and per-file permissions, an "update from main" button, proposals for individual AI edits, and asset handling for images, audio, and 3D. See [INTENT.md](INTENT.md).
