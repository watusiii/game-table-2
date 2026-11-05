# Game Table usage notes

A running record for this room. Record observations, fixes and remaining uncertainty as work happens.

## Before changing a shared build
- Identify the exact source: local repo branch/commit, room table branch, Studio place, and current Rojo sync owner. They can differ.
- Preserve local edits in a patch or copy before changing branches or sync sources. Commit or push only when requested.
- Hand off one Studio/Rojo writer at a time. Agree which machine and repo supply the next sync; inspect the diff before replacing another person's work.
- Read shared documents through the room CLI before editing them. Keep earlier journal entries and use small changes.

## Issues observed on October 28, 2026

### Reported overwrite of unpushed changes
Watu reported in general that local/unpushed work was overwritten after forgetting to push first, during the Studio/Rojo handoff. The exact overwritten version and recovery status were not independently established. Claude mentioned place version history and local Git state as possible recovery sources; recovery was not verified here. Watu asked to continue the work and record the lesson.

The lesson is to preserve local work and identify source, target and sync owner before switching a shared build. Rojo had also reported an existing sync owner, so a second connection should be an explicit handoff.

### Hendrix repeatedly rejoined the room
A reconnect reopened PACKAGE-MANIFEST.json and sent its full encoded document (about 184 KB) back through a 64 KB message limit. The local client now sends missing Yjs edits instead. Regression tests and a live later reconnect verified recovery. This repair is in the local Game Table installation.

### Codex listener stopped during a reconnect
A room connection-replaced packet reached Node's reserved error event before the listener handler attached. The local CLI now uses room:error for protocol errors. Isolated real-WebSocket tests verified both initial rejection and reconnect recovery, and the passive listener was restored.

## Output and attention
- Humans created separate claude and codex channels for the two assistants' work output.
- A background listener captures events; an active assistant must consume them to pay attention. Check the process and connection before claiming it is online.
- Work feeds must omit credentials, private configuration and internal reasoning. Keep visible progress, answers and explicitly reviewed command results.
- Main and the room's table branch are separate. Cleanup PR #1 merged to main at 68f626f; the room still held earlier source when the milestone was verified. Label the build being tested.

### Notifications and Android feedback (reported October 28)
Watu requested notification sounds and push notifications for new Game Table messages. Watu also reported that desktop mode on Android works well. These are user reports and feature requests; notification delivery and Android behavior have not been independently tested here.

### Requested feature: room-scoped site previews
Watu asked to make the temporary room-scoped site-preview method a Game Table feature. The current workaround uses an existing room-protected preview and an ignored local draft; it is not a finished product feature. A supported design needs clear room audience and access, a preview lifetime and cleanup, no invitation keys in chat or referrers, and safeguards against publishing drafts into Git history.

### Notes and slash-command schema
Watu clarified that a room message beginning with “note” means record it in the notes, not implement it. He asked to start a schema for slash commands that have different UI colors and perform actions such as /note. Record the idea as a proposal; the action, storage, permissions and colors are not decided. Existing server-side command permissions and limits must remain authoritative.

### Note: URL hyperlinks
Watu noted: “we should make url hyperlinks work.” This is recorded as a note; the affected surface and intended behavior remain unspecified.

### Note: spatial map of current activity
Watu noted that a spatial map visual of current activity would be helpful. This is a suggestion for later consideration; the intended scope and design are not yet specified.

### Note: emerging Game Table philosophy and channel use
Watu noted that Game Table's philosophy and how-to-use ideals are forming. One possible approach is to keep #general for responses and questions, use other channels for AI-specific work, and create a channel documenting human inputs. Watu also suggested possible committed agent harnessing to serve different development styles. These are ideas for consideration; the channel and harness are not specified or created by this note.

### Note: thinking animation and status affordances
Watu noted: “we want think... type animation / status affordances for gametable.” Record this as an idea for Game Table; the states, presentation and behavior are not yet specified.

### Note: Discord-style reactions
Watu requested Discord-style reactions in Game Table: “note, want dicord-style reacts in gametable”. Recorded as a feature idea only; no implementation requested.

### Note: agent activity status
Watu would find no-cost status updates helpful to see what any nonhuman agent is processing, including whether an agent received his message. For example, this would make gallery work visible without needing to watch Hendrix’s stream. This is a note for later consideration; no implementation was requested.

### Note: Game Table GitHub link bug
Watu reported a bug with the Game Table GitHub link. The affected behavior and cause are not yet specified or verified. This is a note, not a request to investigate or fix it.

### Note: chat messages invisible to AI agents
Watu would like some kind of prefix for sending chat messages that are invisible to AI agents. This is a feature idea for later consideration; the prefix and how visibility would be enforced are not yet specified.

### Note: sending and displaying media
Watu noted that Game Table needs media support for sending and displaying images and other media. This is a feature idea for later consideration; supported media and behavior are not yet specified.
