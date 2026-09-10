# Sentinel — Lovkar's Discord bot

A dozen small jobs, all of them things Discord itself cannot do without a bot - a dashboard to
watch them from, slash commands to run them from inside Discord, and one small file to remember
what Discord cannot be asked about:

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
   redeploy knows exactly as much as it did before.

6. **Packs.** A handful of pictures, posted to the channel they belong in, in one go — a
   sneak peek to `#sneak-peek` or a behind-the-scenes set to `#behind-the-scenes`. Marko does
   it from the dashboard's Packs page; whoever is at a terminal does it with `pack.js`.

7. **Giveaways.** A prize, a deadline and a button. People press it to enter and press it again
   to take their name back out; when the time is up the bot draws the winners itself and says so
   in the channel. The countdown is Discord's own relative timestamp, so it ticks in everyone's
   client without the bot editing anything.

8. **Polls.** Discord's own poll, asked in one line. Two kinds, because supporters and the wider
   server are not always being asked the same thing: `#polls` for the people who pay for it,
   `#community-polls` for everybody. Discord counts the votes; the book keeps what was said after
   the message is gone.

9. **Releases.** A new file on Modrinth or CurseForge is announced in `#announcements` the same
   way a new video is, with its changelog, and published to the servers that follow.

10. **The suggestion board.** Every idea posted in `#ideas-and-feedback` gets its 👍 and 👎 the
    moment it arrives, so nobody has to add them, and once a week the best five are collected
    into one message. A week with nothing above zero posts nothing at all.

11. **The queue.** Twenty screenshots taken in one good evening, dropped on the dashboard at
    once, become a sneak peek every three days for a month. They wait on the same volume as the
    book, so a redeploy cannot lose them.

12. **The small courtesies.** A welcome card with the new member's name drawn across a picture
    from the mod; the round numbers announced once each and never again; and a row of buttons
    that hand out "ping me about releases / sneak peeks / streams / giveaways", so `@everyone` is
    never the only way to reach people.

It reads and it tags. It never deletes, kicks, bans, or edits anyone else's messages, and it
leaves alone any post a human has already given a severity tag.

## The book

For most of its life this bot had no database at all, and the reason was a good one: Discord
already holds the record. The tags on a post, the roles on a member, the messages in
`#announcements` - all of it can be read back off the gateway on every start, and none of it
can go stale or disagree with what people actually see. That has not changed, and nothing
Discord can answer for is copied here as the truth.

What Discord cannot answer for is the bot's account of itself: the log the dashboard shows,
how many posts it has ever triaged, which pictures went out and when. Those used to live in
memory and die with the container. They now live in `db.js` - one SQLite file, no server, no
new dependency, because SQLite ships inside Node.

    /data/sentinel.db     mounted from ./data next to the compose file

It holds the log, a lifetime counter per thing the bot does, a line per pack posted, a line
per video announced, what the triage decided about each post, and a small key/value corner for
anything else worth one line. Roughly a megabyte a year on a server this size.

Two rules keep it honest:

* **Discord stays the record.** The watcher still reads `#announcements` at startup; the book
  only *adds* to what it finds there. Delete a message and the bot agrees with you.
* **It must run without it.** If the volume is missing, read-only, or the runtime has no
  SQLite, every call to the book quietly does nothing, the dashboard says so on the Bot tab,
  and the bot behaves exactly as it did before there was one. Losing the file costs history,
  never function.

`node test-db.js` covers it end to end - what it keeps, what survives a reopen, and that a bot
with nowhere to write still runs.

## Slash commands

Everything above can be run from inside Discord. The commands are registered per guild, which is
instant, so a change is live on the next restart rather than in an hour's time.

    /giveaway start|end|reroll|cancel|list      staff
    /poll ask|close|list                        staff
    /pack <kind> <pictures…> [queue: true]      staff
    /queue list|now|drop                        staff
    /roles [channel]                            staff
    /version                                    everyone
    /bug                                        everyone

`/bug` is the one that earns its keep. It opens a form asking for the one-line summary, what
happened, the mod version, the loader version and any other mods - and only then makes the forum
post, already filled in. The triage tags it as usual. Nearly every "needs log" reply the bot used
to write was asking for something this form asks for up front.

`/giveaway end|reroll|cancel` take a giveaway by name, not by id: the id field autocompletes from
what is actually running.

## Giveaways

    docker exec lovkar-bot node giveaway.js start "A copy of the modpack" 24h
    docker exec lovkar-bot node giveaway.js start "Early access" 3d 2 sneak-peek "Server Booster"
    docker exec lovkar-bot node giveaway.js list
    docker exec lovkar-bot node giveaway.js end|cancel|reroll <id>

or the dashboard's **Giveaways** page, which is the same code with a form in front of it.
`30m`, `2h`, `3d`, `1h30m` and a bare number of minutes are all understood; anything else is
refused rather than guessed at.

This is the one feature that cannot work without the book, and it is the reason there is one.
Nobody can read the entrants of a giveaway back off Discord - pressing a button leaves no trace
anyone else can see - so the entries are the one thing here that only exists in `sentinel.db`.
In exchange, a giveaway survives a restart, a redeploy, and a night with the server switched
off: the sweep runs every fifteen seconds and draws anything whose time ran out while the bot
was away, the moment it is back.

The draw is a partial Fisher-Yates with `crypto.randomInt` rather than `Math.random`: it costs
nothing and means the result cannot be argued with. Nobody is drawn twice, fewer entrants than
places simply means fewer winners, and a reroll never hands it back to somebody who has already
won. `node test-giveaways.js` holds all of that to account, including that every entrant can
actually win - a draw that always picked the first name would pass a weaker test.

> **Keep the `volumes:` line.** CasaOS rewrites this app's compose file from its own store when
> the app is edited in its UI. If `- ./data:/data` disappears, the bot still starts - it just
> forgets everything on every redeploy, and the Bot tab will say so.

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

## Polls

    /poll ask question:"Which cataclysm next?" answers:"🌋 Volcano | 🌪 Tornado | ☄ Meteor" who:Everyone hours:48

Discord has had a real poll of its own since 2024 - it renders properly on every client, counts
server-side, hides the tally until you have voted and closes itself at the hour you asked for.
Building one out of reactions would be worse in every way, so this does not: it sends Discord's
poll and stays out of the way. What Discord will not do is remember, so when the poll closes the
final numbers are copied into the book, where they outlive the message.

Answers are separated by `|`. An answer may start with an emoji, which becomes the answer's emoji
rather than part of its text.

## Releases

Set `RELEASE_MODRINTH` and `RELEASE_CURSEFORGE` and a new file on either is announced with its
changelog. Modrinth's API is open; CurseForge's is not, so that side goes through the same public
proxy the project already uses elsewhere, and a proxy that is down is one line in the log rather
than a watcher that stops. `RELEASE_TYPES` decides whether alpha builds are worth announcing -
they usually are not.

Nothing older than `RELEASE_MAX_AGE_HOURS` is ever posted, and everything already in the feed at
the first start is marked seen, so switching this on cannot dump the back catalogue into
`#announcements`.

## The bump reminder

Server-listing bots (DISBOARD and its kind) put the server at the top of their list when someone
types `/bump`, and then make everyone wait two hours. A bot may not bump for you - that is against
their rules and Discord's, and gets a server delisted - so Sentinel only keeps the clock: it reads
the listing bot's own reply ("Bump done", or "please wait another N minutes"), remembers when the
next bump is allowed, and pings Lovkar in that channel the moment it is. One reminder per bump and,
if it goes unanswered, a nudge every `BUMP_NUDGE_MIN` minutes (never more than one an hour). The
clock is in the book, so a restart does not lose it.

`BUMP_BOTS` lists the bots as `name:botId:cooldownMinutes` (default
`disboard:302050872383242240:120,discadia:*:120`; a `*` matches the bot by its username, and a
cooldown the bot states itself - "next bump in 6 hours" - beats the configured one), `BUMP_CHANNEL`
sends the ping somewhere else than where the bump was typed, `BUMP_DM=1` adds a DM, `BUMP_ENABLED=0`
switches it off.

## Discadia votes

Discadia can call a URL for every vote a listed server gets (`user_id`, `guild_id`, `server_slug`,
`vote_url` - nothing signed, no header), and Sentinel is that URL. Each vote is counted in the book
(per person, per month, all time), thanked in `#votes` with the voter's name and their count -
nobody is pinged - and the voter gets the `Voter` role. A retry within a minute is the same vote; a
vote for another server's `guild_id` is refused.

The address is `DASH_BASE_URL/hooks/discadia/<VOTE_HOOK_TOKEN>`: the token is the whole secret, so
it lives in the env file, is shown only on the dashboard's Bot tab (with a copy button) and is pasted
into Discadia → Edit listing → Vote Webhooks by hand. The `Voter` role is Sentinel's to give (Discadia's
own role picker never listed the roles this bot had created) and to take back: a sweep removes it
`VOTE_ROLE_DAYS` (7) after the person's last vote, so a Voter is somebody who voted this week.
`VOTE_CHANNEL`, `VOTE_ROLE` and `VOTE_QUIET=1` adjust the rest; without a token the path does not exist.

## The Supporter role

`SUPPORTER_ROLE_NAME` (default `Supporter`) is the booster role's twin, made for the people who help
without boosting: created on the first start if it does not exist, in the booster pink, shown
separately in the member list, and opened to the same `BOOSTER_CHANNELS` plus `SUPPORTER_CHANNELS`
(default `polls,supporters-lounge`). Nobody gets it on their own; Lovkar hands it out in the member
settings. An empty name switches it off.

## The suggestion board

The two reactions go on automatically, which is the whole trick: a suggestion with no reactions
gets none, and a suggestion with two gets fifty. Bots, one-word replies and bare links are left
alone. The score is recounted from the message rather than incremented, so a duplicate event or a
day of downtime cannot make it drift.

The weekly digest posts the best five of the last seven days. A week where nothing scored above
zero posts nothing - an empty "top ideas" is worse than silence - but the clock still winds on,
so the first upvote of the new week does not fire a digest of one.

## The queue

    /pack kind:sneak picture:… queue:true

or the checkbox on the dashboard's Packs page. One goes out every `QUEUE_EVERY_HOURS` (72), only
between `QUEUE_FROM_HOUR` and `QUEUE_TO_HOUR`, so nothing is posted at four in the morning. The
first one goes out at once - dropping twenty pictures should show one straight away, not leave
the channel silent for three days.

Or put it on a clock: `QUEUE_AT=19:00` (or `12:30,19:00`) posts one picture at each named time,
on the days in `QUEUE_DAYS` if that is set. This replaces the spacing rule rather than joining it -
pictures are queued in order and the clock decides. Which slots have already fired is one line in
the book, so a redeploy does not fire them again, and a slot more than `QUEUE_CATCHUP_MINUTES`
(90) past is a missed slot rather than a late one: a bot that was off for two days must not empty
the queue the moment it comes back.

A named time means nothing without a zone, and the image is UTC: `TZ` in the compose is what makes
19:00 mean 19:00 here rather than 21:00. Node carries its own zone data, so that one variable is
the whole of it - the shell's `date` inside the container still says UTC and does not matter.

The files wait in `/data/queue`, beside the book and on the same volume, because a picture
waiting three weeks has to survive every redeploy in between. Posting goes through `packs.js`
like anything else, so there is one code path to the channel.

## The welcome card

`@napi-rs/canvas` draws a 1000×360 card: the background from `/data/welcome-bg.jpg`, a scrim so
the text always reads, the member's avatar in a gold ring, and their name shrunk to fit beside
it. It is an **optional** dependency and the module says so: if it is not installed, or the
background is missing, or the avatar will not fetch, the member is still welcomed - with an
embed, or with an initial in a circle. Nobody is ever not welcomed because a drawing library was
not there.

The image installs `font-noto` and `font-noto-emoji`, because skia ships no fonts of its own and
without them every string measures zero and the card comes out wordless.

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
    bump.js          the bump reminder - the listing bot's clock and the ping
    votes.js         Discadia's vote webhook: the count, the thank-you and the Voter role
    notify.js        a DM and a moderator mention for every new bug report
    triage.js        the keyword classifier and the floor rules
    llm.js           the optional model pass and the Gemini key ring
    test.js          the classifier's tests
    test-keyring.js  the key ring's tests
    test-web.js      the session cookie's tests

Lovkar & Claude.
