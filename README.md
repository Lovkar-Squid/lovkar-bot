# Sentinel — Lovkar's Discord bot

Two small jobs, both of them things Discord itself cannot do without a bot:

1. **The member role.** Everyone who joins gets `Dreamer`. Discord only assigns roles
   automatically through Onboarding questions, which people can skip.
2. **Bug triage.** Every new post in `#bug-reports` gets a severity tag (`Critical` /
   `Major` / `Minor`), the tag for whichever project it is about, and `needs log` when
   the post has no log in it — plus a short reply saying what is missing.

It reads and it tags. It never deletes, kicks, bans, or edits anyone else's messages, and it
leaves alone any post a human has already given a severity tag.

## How the triage decides

`triage.js` first scores the title and body against a keyword table — free, instant, and
arguable: every verdict traces back to a word in that file, in English or Slovene. Turning on
`LLM_PROVIDER` adds a second pass (Gemini or Claude) for reports the keywords miss, but the
model can only move a report between the same three buckets, and never below the evidence: a
post carrying a stack trace stays Critical whatever anything says about it.

    Critical  the game or server will not run; a world or items lost or corrupted; a dupe
    Major     it runs, but something is properly broken: a feature dead, no progress, bad TPS
    Minor     cosmetic or textual: typos, textures, sounds, tooltips, small UI

`npm test` runs the classifier against a dozen reports that look like real ones. No network.

## Running it

    cp .env.example .env        # then put the bot token in DISCORD_TOKEN
    docker compose up -d --build

Or, on the server, the same way as lovkar-supporters:

    cd ~/lovkar-bot && git pull --ff-only && docker compose up -d --build

The token is never committed: `.env` is in `.gitignore`, and the compose reads it from the
environment (or from Portainer's stack editor).

### First run

Set `DRY_RUN=1` for the first start. The bot then logs every decision it *would* make and
writes nothing — the log tells you whether it found the role and the forum, and what the
existing tags are. Set it back to `0` when the log looks right.

Set `BACKFILL_MEMBER_ROLE=1` for one run to give `Dreamer` to everyone already in the server,
then set it back to `0`.

## What it needs on Discord

* Privileged intents: **Server Members** and **Message Content** (Developer Portal → Bot).
* Permissions: Manage Roles, Manage Threads, Send Messages, Send Messages in Threads,
  Read Message History.
* Its own role must sit **above** `Dreamer` in Server Settings → Roles, or it cannot hand it
  out. The bot says so in its log if it cannot.

Severity tags are created on the forum at startup if they are not there; the tags already on
the channel are left exactly as they are.

## Files

    bot.js       gateway wiring: join → role, new forum post → triage
    triage.js    the keyword classifier and the floor rules
    llm.js       the optional model pass; off unless LLM_PROVIDER is set
    test.js      the classifier's tests

Lovkar & Claude.
