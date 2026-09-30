# INTENT

Working notes on what this is and why. Not a spec. Edit freely.

## What it is

A shared studio for making things together. First use case is game development, but nothing in the room is game-specific.

Familiar like Discord and Slack: rooms, channels, members, files. Live like Google Docs and Figma: everyone sees each other's cursors, carets, and edits as they happen.

## What it is not

- Not an AI chat with extra people added.
- Not a prompt editor that funnels everyone's ideas into one person's AI.

The first Game Table (game-table) went that way. This is a restart with the idea the right way round.

## Core ideas

1. **The room is the product.** One shared space, one source of truth. Everyone connected sees the same thing.
2. **The work is the point.** Files, assets, and decisions are what matter. Chat exists to make them.
3. **A connected computer is a member.** Each person joins from their own machine.
4. **AI is a tool, not the center.** Each person plugs in whatever AI they use, on their own tokens. The room is model-agnostic and cannot tell which model anyone uses.
5. **Nothing blocks anyone.** Everyone can talk and work at once. Progress should never stall waiting on one person.
6. **Nothing gets lost.** Changes are versioned in GitHub. Anything can be undone.
7. **Private by default.** Keys and AI stay on each person's machine and are never sent to the room.

## What exists now

- Rooms with invite links, channels, chat, and member colors.
- A small room server we own (Node + WebSocket). Rooms survive tab closes.
- Files backed by a GitHub repo: edits save and push a few seconds after typing stops; changes made on GitHub are pulled in.
- Live shared editing (Yjs): simultaneous typing merges, with colored carets, name tags, and selections.
- Presence: where each person is (channel or file), shown in the member list and beside channels and files.
- Channels know their creator and last speaker (`Actor` and `Activity` types, reusable for files, tasks, assets).
- Repo link in the room.
- Each room works from its own GitHub repo (room from repo, or bring a repo into a room).
- Edits save to a branch of the room's own, never straight to main. A Propose button opens GitHub's pull request page, so main only changes when the group accepts something.
- Author colors: every stretch of text is tinted by who wrote it, with a legend. Authorship is declared by each person's browser, so it is a record for the team, not proof. Server-verified attribution is a later step.
- Safety nets: undo for deleted files, version history with restore, a secret scanner before pushing, typed confirmation to close a room, clean shutdown.

## Agents (decided direction)

- An AI is a tool that belongs to a person, not a separate member. It acts as its human and shows up as "AI - Name" (the `ai` message kind already exists).
- Agents reach the room through a **command-line tool** (Hendrix's suggestion). A CLI is the universal interface: anything that can run a terminal works, whether that is Claude Code, Codex, or a local model. Model-agnostic by construction.
- The CLI speaks the same protocol the browser does. Rough commands: join, listen (stream what people say), say, list files, read a file, edit a file live, who is here.
- Humans and their AIs can both listen and talk. Keys and models stay on the person's own machine.
- Later: agent changes can arrive as proposals the group accepts, instead of landing directly.

## Roles and permissions

First slice is built and enforced on the server: four roles (owner, admin, member, viewer), a permission list per role, a room setting for whether members may create channels (off by default), owner/admin controls to set roles, remove people, and delete channels, a new-invite-link button, and flood limits on chat, channels, and file actions.

Still to do: custom roles, per-channel and per-file permissions, agent permissions, and real accounts. Today a person is one browser (not one tab). A removed person is blocked by browser and, behind the tunnel, by connection address; someone determined can still come back from a private window or another network, so the backstops are NEW PEOPLE JOIN AS VIEWERS and NEW INVITE LINK. Accounts are the real fix.

Original plan, kept for reference:

- **Roles:** owner, admin, editor, viewer. Owner and admins can assign roles.
- **Permissions:** read, chat, create channels, create and edit files, run the preview, invite people, manage roles, change the repo, use agents.
- **Agents:** an agent gets its human's permissions, and can be capped lower (for example read and propose only).
- **Enforced on the server**, never only in the interface.
- Later: permissions per channel and per file.

## Sandbox preview (planned)

- Show the game running inside the room, from the repo's files.
- Plain web games first (HTML, JS, CSS; p5, Three.js). No build steps yet.
- Runs in a sandboxed iframe with no access to the room, the page around it, or the user's storage.
- The server serves the repo's files read-only to the preview. Auto-reloads about a second after a save.
- Everyone sees the same game; each browser runs its own copy.
- Later: capture the game's errors into the room, and playing together.

## Profile

- Pick your own color instead of a random one.
- Idea: offer a Lab-style picker with lightness held fixed, so every color stays readable behind text.

## Open questions

- How should decisions get made when people disagree? A default that applies if nobody answers?
- How do non-text assets (images, audio, 3D) get versioned?
- Does one room map to one repo, or can a room hold several?
- What does "propose" look like for an agent's file changes?

## Carried over from game-table v1

- Invite-link join flow.
- The idea of a local bridge so AI runs on the user's own machine (now replaced by the CLI).
