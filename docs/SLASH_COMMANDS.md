# Slash Command Schema (Proposal)

Proposal for adding slash commands to Game Table chat. Commands trigger actions instead of sending normal chat messages.

## Requirements

- **Server-authoritative**: All permissions and validation happen server-side
- **Visual distinction**: Different UI colors/styling per command type
- **Clear feedback**: User sees what happened
- **Backward compatible**: Regular chat still works

## Proposed Commands

### `/note <text>`
Record note in session journal without chat clutter.

- **Permission**: Same as chat (members+)
- **Storage**: Append to `GAME_TABLE_USAGE.md` or per-room notes file
- **UI**: Muted color, maybe timestamp + author only
- **Server response**: `{ type: 'command-ack', command: 'note', success: true }`

### `/status <text>` or `/here <text>`
Update visible presence status (mirrors CLI `here` command).

- **Permission**: Any connected user
- **Storage**: In-memory only (`member.where`)
- **UI**: System message style, "Alice is now: working on docs"
- **Server response**: Broadcast `members` update

### `/clear`
Clear local chat history (client-only).

- **Permission**: Self only
- **Storage**: None
- **UI**: Client removes messages, shows "Chat cleared"
- **Server response**: None (client-side only)

### `/pin <message-id>`
Pin important message to channel (future).

- **Permission**: Admin+
- **Storage**: Add `pinnedMessages: string[]` to channel
- **UI**: Pinned section at top of channel
- **Server response**: `{ type: 'channel-update', channelId, pinned }`

## Protocol Changes

### Client sends
```typescript
{
  type: 'command',
  channelId: string,
  command: string,      // e.g., 'note'
  args: string,         // rest of text after command
}
```

### Server validates
```javascript
// server.mjs
if (msg.type === 'command') {
  const { command, args } = msg;

  if (command === 'note') {
    // Check permission (same as chat)
    requirePermission(person, 'chat');
    // Write to notes file
    appendNote(room, person.name, args);
    // Send acknowledgment
    send(ws, { type: 'command-ack', command: 'note' });
  }

  else if (command === 'status' || command === 'here') {
    // Update presence
    ws.where = cleanText(args, 80);
    broadcast(room, { type: 'members', members: membersOf(room) });
  }

  else {
    send(ws, { type: 'error', reason: 'Unknown command: ' + command });
  }
}
```

### Server responds
```typescript
// Success acknowledgment
{
  type: 'command-ack',
  command: string,
  result?: any,
}

// Or error
{
  type: 'error',
  reason: string,
}
```

## UI Implementation

### Client parsing (app.ts)
```typescript
// In message input handler
if (text.startsWith('/')) {
  const [command, ...args] = text.slice(1).split(' ');

  if (command === 'clear') {
    // Client-side only
    current.messages = [];
    patch({ messages: [] });
    return;
  }

  // Send to server
  room.send({
    type: 'command',
    channelId: current.channelId,
    command,
    args: args.join(' '),
  });
  return;
}

// Normal chat
room.sendMessage(current.channelId, text);
```

### Message styling (style.css)
```css
.msg.command {
  background: rgba(100, 100, 255, 0.05);
  border-left: 2px solid #6464ff;
}

.msg.command.note {
  opacity: 0.7;
  font-size: 11px;
}
```

## Command Types & Colors

| Command | Type | Color | Visibility |
|---------|------|-------|------------|
| `/note` | record | muted gray | Low-key |
| `/status`, `/here` | presence | blue | System message |
| `/pin` | action | yellow | Highlighted |
| `/clear` | local | none | Client-only |

## Security

- **No eval**: Commands parsed by explicit switch/if
- **Permissions enforced**: Server checks `PERMISSIONS` map
- **Rate limits**: Use existing `LIMITS.chat` or separate `LIMITS.command`
- **Sanitization**: `cleanText()` on all args
- **Agent restrictions**: Commands in `AGENT_BLOCKED` if needed

## Storage Options

### Option 1: Separate notes file per room
- `server/data/<roomId>/notes.md`
- Append-only log with timestamps
- Not synced via Yjs (keeps chat clean)

### Option 2: Special channel
- Create `#notes` channel
- Commands post there instead
- Searchable, has full history

### Option 3: Room metadata
- Add `room.notes: Note[]` array
- Sent in snapshot
- Limited size (last 100?)

**Recommended: Option 1** - keeps notes separate, doesn't clutter chat or channels.

## Open Questions

1. **Note formatting**: Plain text or markdown support?
2. **Note access**: Who can read? Just author, or all members?
3. **Command discovery**: `/help` to list commands?
4. **Autocomplete**: Show available commands while typing?
5. **Command history**: Up arrow cycles through previous commands?
6. **Aliases**: `/s` for `/status`, `/n` for `/note`?

## Implementation Steps

1. Add `command` message type to protocol (server + client)
2. Implement `/note` server handler + file storage
3. Add `/status` as alias for existing `here` message
4. Add client-side `/clear` command
5. Add CSS styling for command messages
6. Update client input to parse `/` prefix
7. Add `/help` to list available commands
8. Test permissions and rate limits

## Backward Compatibility

- Old clients ignore unknown message types
- Commands sent as regular chat if server doesn't recognize
- Feature detection via capabilities in snapshot
