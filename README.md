# Sentinel — Lovkar's Discord bot

Six small jobs, all of them things Discord itself cannot do without a bot - and a dashboard
to watch them from:

1. **The member role.** Everyone who joins gets `Dreamer`. Discord only assigns roles
   automatically through Onboarding questions, which people can skip.
2. **Bug triage.** Every new post in `#bug-reports` gets a severity tag (`Critical` /
   `Major` / `Minor`), the tag for whichever project it is about, and `needs log` when
   the post has no log in it — plus a short reply saying what is missing.
3. **What a boost unlocks.** Discord does not create the `Server Booster` role until somebody
   actually boosts, so the channels a boost is meant to open cannot be configured beforehand.
   The bot grants that role `View Channel` on `BOOSTER_CHANNELS` at startup and whenever the
   roles change — so the perk turns itself on with the first boost, and channels named there
   that do not exist yet are simply skipped.
4. **The OG badge.** The first `OG_LIMIT` (200) people through the door keep an `OG` role. The
   role is created if it is missing, handed to everyone already here oldest-first, and to each
   new arrival while places remain. The role's own member count is the tally, so there is still
   nothing to store — and the promise it makes is exactly what anyone can check: at most two
   hundred people wear it.

5. **New videos.** A video going up on the YouTube channel is announced in `#announcements`
   by itself, and published to the servers that follow that channel. What it has already
   posted it reads back out of the channel - Discord is the record - so a restart or a
   redeploy knows exactly as much as it did before, and there is still no database.

6. **Packs.** A handful of pictures, posted to the channel they belong in, in one go — a
   sneak peek to `#sneak-peek` or a behind-the-scenes set to `#behind-the-scenes`. Marko does
   it from the dashboard's Packs page; whoever is at a terminal does it with `pack.js`.

It reads and it tags. It never deletes, kicks, bans, or edits anyone else's messages, and it
leaves alone any post a human has already given a severity tag.

## Packs

`packs.js` knows two packs — `sneak` and `bts` — and where each one goes. Both doors into it
end up in the same place, so the channel mapping, the batching and the rules about what may be
posted are written once.

From the dashboard, sign in and open **Packs**: pick which pack, drop the files on it, write a
line, send. From a terminal, when the pictures are already on the server:

```
docker exec lovkar-bot node pack.js sneak "The tornado finally has a body." /tmp/pack/*.png
docker exec lovkar-bot node pack.js bts   ""                                /tmp/pack/tex.jpg
```

An empty caption means the pack says its own line. Up to 30 files, 10 MB each; Discord takes ten
attachments per message, so more than that becomes several messages and only the first carries
the words.

**Nothing is stored.** The files go from the upload straight to Discord and are forgotten — the
bot still has no database, and Discord keeps the only copy that matters. The multipart parser is
written by hand (the bot has no dependencies beyond discord.js) and it walks the raw buffer
rather than turning it into a string first: a PNG turned into a UTF-8 string and back is no
longer a PNG.

## Where the settings live

The server's `docker-compose.yml` used to carry every setting inline, secrets included — a file
that git tracks, one `git add -A` away from publishing a bot token. `envfile.py` moves that block
out: the values go into `.env.compose` (mode 0600, ignored by git along with every other `.env*`),
and the compose file keeps one `env_file:` line. Run it once in the directory that has the compose
file; it never prints a value, only the key names it moved. There is a
`docker-compose.yml.before-envfile` left beside it, which still has the old inline block in it —
delete that once you are happy.

## The YouTube watcher

`youtube.js` reads the channel's public Atom feed every `YOUTUBE_POLL_MINUTES`. No API key, no
quota, and a new upload shows up there within a few minutes.

Two things keep it from ever announcing the back catalogue: nothing older than
`YOUTUBE_MAX_AGE_HOURS` is posted, and everything the feed lists at startup that is already
older than that is marked seen before the first poll. On top of both, the last hundred messages
of the announcement channel are read at startup and every YouTube link in them counts as posted
- so a post Marko made by hand is not repeated by the bot either.

**There are two of those feeds and they do not agree.** The obvious one is keyed by channel
(`?channel_id=UC...`), and YouTube builds it when a video is *published* — so a video uploaded
as unlisted and switched to public later never appears in it. That is the state this channel is
in: the trailer is public and that feed lists nothing at all. The channel's uploads *playlist*
(`?playlist_id=UU...` — the same id with `UC` swapped for `UU`) does list it, with a real
publication date. So the watcher reads the playlist feed first and falls back to the channel
feed. Same Atom document, same parser, and nothing here scrapes a web page.

The channel is a default in `youtube.js` rather than a setting on the server: CasaOS owns this
app's environment block and rewrites the compose file from its own store on every deploy, so a
variable added there by hand does not survive. Nothing about a channel id is secret. Setting
`YOUTUBE_CHANNEL_ID` in the environment still overrides it.

Run it on its own to see what it would post, with no Discord connection and nothing written:

```
node youtube.js
```

## How the triage decides

`triage.js` first scores the title and body against a keyword table — free, instant, and
arguable: every verdict traces back to a word in that file, in English or Slovene. Turning on
`LLM_PROVIDER` adds a second pass (Gemini or Claude) for reports the keywords miss, but the
model can only move a report between the same three buckets, and never below the evidence: a
post carrying a stack trace stays Critical whatever anything says about it.

`GEMINI_API_KEY` takes one key or a list of them, one per Google project. A key that comes
back rate-limited or out of quota stands down for an hour and the next one is used; when they
are all cooling the model pass is skipped and the keywords decide alone — the bot never stops
tagging because of a quota. Keys are named by position in the log and never printed. Leave
`GEMINI_MODEL` empty and the bot asks the account which models it has and takes the newest
flash one, so a renamed or retired model does not break it.

What the model sees is the title and body of a public forum post, nothing else — no member
list, no private channels, no logs the poster did not paste in themselves.

    Critical  the game or server will not run; a world or items lost or corrupted; a dupe
    Major     it runs, but something is properly broken: a feature dead, no progress, bad TPS
    Minor     cosmetic or textual: typos, textures, sounds, tooltips, small UI

`npm test` runs the classifier against a dozen reports that look like real ones, and the key
ring against a fake rate-limited Gemini. No network in either.

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
  Read Message History. Manage Roles is also what lets it set the booster channel permissions;
  it does **not** need Manage Channels for that, only to create a channel (which it never does).
* Its own role must sit **above** `Dreamer` in Server Settings → Roles, or it cannot hand it
  out. The bot says so in its log if it cannot.

Severity tags are created on the forum at startup if they are not there; the tags already on
the channel are left exactly as they are.

## The dashboard

A single page, served by the bot's own process, so it answers from the live gateway connection
rather than a database — the bot still stores nothing. Three tabs: every post in the bug forum
with its tags (and the controls to change them, re-run the triage, or mark one fixed), the
server's numbers, and the bot's own uptime and log.

Sign-in is Discord's OAuth2 with the `identify` scope and nothing more. That establishes only
*who* you are; whether you may see anything is decided here, against the guild — you must be a
member of it and either own it or wear one of `DASH_ROLES`. Being signed in to Discord is not a
permission.

It listens on 8081 inside the container and is never published on the LAN: the Cloudflare tunnel
that already runs beside `lovkar-supporters` routes a hostname straight at `lovkar-bot:8081`.
Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DASH_BASE_URL` to switch it on; leave any of
them empty and it does not start, and everything else carries on regardless.

## Files

    bot.js           gateway wiring: join → role, new forum post → triage, boost → channels
    web.js           the dashboard: OAuth2 sign-in, the API, and the page
    triage.js        the keyword classifier and the floor rules
    llm.js           the optional model pass and the Gemini key ring
    test.js          the classifier's tests
    test-keyring.js  the key ring's tests
    test-web.js      the session cookie's tests

Lovkar & Claude.
