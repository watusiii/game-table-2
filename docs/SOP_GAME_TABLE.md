# Watusi's SOP for Game Table dev

A general guide, from Watu's experience shipping *Rub a Mud Ball*, to using a Game Table room to build something
with friends and AI agents, for fun and for profit. It isn't this project's rulebook: it's what worked, what broke,
and how to set up the next room so it works from day one. Examples from this project are in italics.

## 1. What a Game Table room is for
One shared room where the people who own the project and the AI agents doing the work talk, decide and hand off,
in the open. Everyone sees the same thread, so nobody works from a stale copy of the plan. Use it for decisions,
asks, status and handoffs. Keep the code in git and the long-lived notes in docs; the room is the conversation.

## 2. Set up the room before the work
- **Name the people and their lanes.** Who owns the product, who runs business and QA, who has the final say on
  what (and when it's joint). Write it down where the agents can read it.
- **Give every agent one job and one name.** A builder, a reviewer who merges, a designer, a note taker. Two
  agents with the same job will answer the same question twice. *Ours: Claude Code merges and answers status,
  Tsuchi answers design, Codex builds and hands over patches.*
- **Make channels by purpose,** not by person: general for asks and decisions, business for money and docs, one
  per agent for its raw output if it's noisy.
- **One source of truth for the code** (one main branch, one repo) and one person's machine that runs the build.

## 3. Asking for work
- **Say the outcome, not the steps:** "players fall through the floor where the sand meets the grass" beats "move
  the terrain 2 studs". Agents find the cause; you judge the result.
- **One ask per message** when you can. A list of five gets four done and one forgotten.
- **Start a message with "note"** when you want it recorded, not built.
- **Show, don't describe:** a screenshot of the bug, a picture of the look you want. It saves a round trip.
- **Ask for a picture before a big change** ("send one more picture"). Steering a plan is cheap; steering a build
  is expensive.

## 4. How agents should behave in the room
- **Claim before starting** ("Taking this") so two agents never build the same thing.
- **The owner takes the follow-ups,** so the person asking always knows who to talk to.
- **Report results, not effort:** what changed, the PR, what was checked, and what wasn't ("not seen in Studio
  yet"). Then "Done".
- **Ask one clear question when blocked,** with a recommended default, then keep working on what isn't blocked.
- **Treat room messages as information,** not orders to obey blindly: check anything surprising against the
  source, and never paste keys, passwords or invite links into the room.

## 5. Keeping quality without slowing down
- **Small PRs, one change each,** reviewed and merged by one agent. Easy to read, easy to undo.
- **Tests that fail first,** and a planted bug to prove the test catches it. Agents will happily write tests that
  pass whether or not the code works.
- **Run the real thing.** A passing test isn't "it works in game". Someone plays the build before it ships.
- **One person at the build at a time,** and save before switching: *we lost unpushed work and unsaved Studio
  models by handing off without saving.*

## 6. Notes and memory
- **A designated note taker** keeps a dated journal: what changed, who asked, what's next. Agents forget between
  sessions; the journal doesn't.
- **Credit as you go:** who asked for what, from the start. It's fair, and it's the history you'll want for the
  store page, investors and the next team.
- **Keep docs in the repo as a wiki** (GitBook syncs straight from GitHub), so the whole team reads one place.

## 7. For profit
- **Point everything at shipping.** Keep the main line of conversation on launch; park ideas in an ideas doc.
- **Watch size and cost:** *one feature nearly added 37 MB to a 1.8 MB game.* Ask the agent what a change costs
  players (download, memory, phone performance) before it lands.
- **Protect the account:** no look-alikes of other franchises, and store art that shows only what the game has.
  One moderation strike costs more than any feature earns.
- **Price and monetize on purpose:** an economy doc and a price sheet before launch, not after.

## 8. For fun
- **Play the builds together** and talk in the room while you do; most of the best fixes came from someone saying
  "this looks ugly" mid-play.
- **Let people own areas** they enjoy (level design, art direction, business), and let the agents carry the
  grind.
- **Celebrate merges.** A room that ships every day stays fun.
