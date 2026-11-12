# Calendar

One switch, `EMBERVY_HOOK_CALENDAR=1` in `$EMBERVY_HOME/.env` (the installer's
Finalize step writes it when you tick **Calendar**), turns on three things:

1. **The agent knows its day.** Today's entries from the agent's own
   calendar appear next to the clock, once when a session starts and once
   when the day changes — not on every turn.
2. **You see the agent's calendar on your phone.** The app serves a
   read-only feed at `/calendar.ics?token=…` that any calendar app can
   subscribe to. No native app needed.
3. **The agent knows your appointments.** Optional: add the secret ICS
   links of your own calendars; the agent sees them next to its own,
   read-only and marked as yours.

With the switch off, the agent still has its `calendar` tool (add / list /
remove); there is no day line, the feed answers 404 and your links are not
read.

## The agent's calendar

The agent keeps it with the `calendar` tool. Entries live in
`<app>/data/calendar.json`, in house time (`EMBERVY_TIMEZONE`, an IANA name
such as `Europe/Lisbon`; the installer sets it from your computer's zone if
the `.env` has none). An entry without a time is all-day.

**What the phone feed shows:** every entry *not* marked `private`, with
title and time only. Notes never leave the server. The agent adds
`private: true` for anything that should stay off your phone (a surprise,
something about someone else).

## Subscribe on your phone

The phone feed is off until you enable **Calendar** in the installer or set
`EMBERVY_HOOK_CALENDAR=1` in the house and app environment and restart the app.
With it on, ask your agent for the link (`calendar` → `feed`), or open
`https://<your app address>/api/calendar/feed` while logged in to the app.
It looks like `https://home.<your-domain>/calendar.ics?token=…`. The feed
is read-only: you cannot edit these entries on the phone, and they update
when your calendar app refreshes.

- **iPhone / iPad:** Settings → Calendar → Accounts → Add Account → Other →
  *Add Subscribed Calendar* → paste the link → Next → Save. Refresh rate:
  Settings → Calendar → Accounts → Fetch New Data.
- **Android / Google Calendar:** on a computer, open calendar.google.com →
  *Other calendars* (+) → *From URL* → paste the link → *Add calendar*. It
  then appears in the Google Calendar app on your phone (turn on *Sync* for
  it there). Google refreshes subscriptions on its own schedule — often every
  few hours, sometimes less. Without Google: the free ICSx⁵ app subscribes
  directly on the phone.
- **Outlook:** outlook.com or Outlook on the web → Calendar → *Add
  calendar* → *Subscribe from web* → paste the link → Import. Outlook also
  refreshes on its own schedule (hours).

**The link is a password.** Anyone who has it can read the non-private
entries. Subscribing through Google or Outlook means their servers fetch
the feed, so those titles and times pass through them. If it leaks, rotate it: `bun shared/calendar/feed-token.ts rotate`
on the server (writes a new `CALENDAR_FEED_TOKEN` into `.env`), then
`systemctl restart "${EMBERVY_APP_SERVICE:?load the house app service from its .env}"`
and subscribe again with the new link. Read `EMBERVY_APP_SERVICE` from
`$EMBERVY_HOME/.env` into your terminal environment first: `embervy-app`
is the first-house example; named houses use `embervy-<name>-app`. The
old link stops working. `feed-token.ts show` prints the current one.

## Your own calendars (read-only)

Put the secret ICS links of your calendars into `.env`, comma-separated,
**in single quotes** (links can contain `&`), then restart the app:

```
CALENDAR_ICS_URLS='https://calendar.google.com/calendar/ical/…/private-…/basic.ics,webcal://p…-caldav.icloud.com/published/2/…'
```

Where to find them:

- **Google:** calendar.google.com → Settings → your calendar → *Integrate
  calendar* → *Secret address in iCal format*.
- **iCloud:** Calendar app → the calendar's share button → *Public
  Calendar* → copy link (`webcal://…` is fine).
- **Outlook / Microsoft 365:** Outlook on the web → Settings → Calendar →
  *Shared calendars* → *Publish a calendar* → pick the calendar and *Can view
  all details* → copy the **ICS** link.

The app fetches every link every 15 minutes (`CALENDAR_ICS_POLL_MINUTES`,
5–1440), with a 15-second timeout and a 5 MB cap per link
(`CALENDAR_ICS_TIMEOUT_MS`, `CALENDAR_ICS_MAX_BYTES`). It keeps the next 30
days in `<app>/data/calendar-external.json` — appointment titles and times,
never the links. A link that fails keeps its last good data and shows up as
failing in the day line and in `calendar list`. The links themselves are
never logged.

**What this release does not do:** it never writes to your calendars — no
CalDAV, no invitations, no changes. Recurring events are expanded for
daily, weekly, monthly and yearly rules (intervals, counts, end dates,
weekdays like "second Tuesday" or "last Friday", excluded and moved
instances). Rarer rules (`BYSETPOS`, week numbers, several times a day)
show on their first date only and are marked `repeats_unexpanded`. Time
zones are read by name, including Outlook's Windows names; an unknown zone
falls back to the calendar's own zone, then to the house zone.

## Settings at a glance

| Key | Meaning |
|---|---|
| `EMBERVY_HOOK_CALENDAR` | `1` = on (day line, phone feed, your links). |
| `CALENDAR_FEED_TOKEN` | Feed secret. Created once at Finalize, kept on re-runs; rotate with `feed-token.ts`. |
| `EMBERVY_APP_URL` | Public app address; lets the agent hand out the full feed link. |
| `CALENDAR_ICS_URLS` | Your secret ICS links, comma-separated, single-quoted. Empty = none. |
| `CALENDAR_ICS_POLL_MINUTES` | How often to read them (default 15). |
| `EMBERVY_TIMEZONE` | House time zone for entries, the day line and the feed. |
