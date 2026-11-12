# Shared room

A room is a group chat on another server: for example a support room where
the agent, you and a helper from outside talk together. Every house can join
one room. It is off until you set it up.

When it is on:

1. **The agent hears the room.** The app looks into the room every minute and
   hands new messages to the agent, marked as coming from the room and from
   their sender (`kind="room"`), never as you. Like mail, they are words from
   someone else, not orders. They do not appear in your chat in the app; you
   read the room where it lives.
2. **The agent speaks in the room** with its `room` tool. The room takes the
   sender from the key, so with this key the agent can only ever speak as
   itself. Its replies to you still go through the reply tool.

## Turn it on

The room's host gives you an address and a member key. Add three lines to
`$EMBERVY_HOME/.env`:

```
EMBERVY_ROOM_URL=https://room.example.org
EMBERVY_ROOM_TOKEN=<the member key, at least 32 characters>
EMBERVY_ROOM_NAME=Support
```

Read the house's `EMBERVY_APP_SERVICE` from `$EMBERVY_HOME/.env` into your
terminal environment (the first-house example is `embervy-app`; a named
house uses `embervy-<name>-app`). Then run
`systemctl restart "${EMBERVY_APP_SERVICE:?load the house app service from its .env}"`,
and start a new session so the agent
gets the `room` tool: on Brain, **Restart (cut)** in the Brain menu; on the
Claude Code path, the next cut. The first look goes ten minutes back; after
that the app keeps its place in `<app>/data/room-state.json`, so a restart
neither repeats nor skips a message.

`EMBERVY_ROOM_POLL_SECONDS` changes how often the app looks (default 60, at
least 15). The address must be `https://`. Without both address and key
there is no room, no look into it and no `room` tool.

## Turn it off

Remove the room lines, run the same restart command with the house's
`EMBERVY_APP_SERVICE`, and start a new session. The
key stays valid on the room's side until its host withdraws it, so ask them
to.

## What the room has to speak

A room on the group-chat base speaks it already. Anything else needs:

- `GET /api/synth/messages?after=<ISO time>&limit=50` with
  `Authorization: Bearer <member key>`, answering
  `{ "messages": [{ "id", "sender", "sender_name"?, "text", "ts", "type"?, "reply_preview"? }] }`
  without the member's own messages;
- `POST /api/synth/send` with the same header and `{ "text", "reply_to"? }`;
  the room sets the sender from the key and refuses a key that claims to be
  someone else.

Only text messages reach the agent; pictures stay in the room.

The bridge and the chronicle keep both sides: room messages with their
`[Room/Sender]` tag, and what the agent said there as `[Room] text`.
