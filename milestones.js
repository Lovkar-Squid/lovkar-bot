/**
 * Milestones: the round numbers a server passes, said out loud once each.
 *
 * <p>Nobody notices the hundredth member arriving. The count sits in the sidebar, it goes up by one
 * while everyone is busy talking about something else, and the day it happens goes by unremarked.
 * This watches the three numbers worth noticing - members, boosts, the boost level - and posts one
 * warm line when the server reaches one of them.</p>
 *
 * <p>"Once each, ever" is the whole difficulty, and it is the reason this file touches the book.
 * What has been announced is written down under keys like <code>milestone:members:100</code>, so a
 * restart, a redeploy or a week switched off cannot say it twice. And because a mark is either
 * written down or it is not, a server that dips under a hundred and climbs back is quiet the second
 * time: the count is only ever read as "have we reached this", never as "did it just go up".</p>
 *
 * <p>The first run is the awkward one. Switching this on in a server of nine hundred people should
 * not post eight messages in a row, so the first look writes down everything already passed without
 * a word and leaves <code>milestone:seeded</code> behind to say that it has. Only crossings that
 * happen afterwards get a message. A bot with no book never gets past that first look and so says
 * nothing at all, which is the right way round: with nowhere to write it down there is no way to
 * promise "once", and silence is better than the same eight messages every ten minutes.</p>
 *
 * <p>The check is a timer rather than a GuildMemberAdd handler, because joining is not the only way
 * a count moves - people leave, boosts expire, and the bot is not always up at the moment it
 * happens. guild.memberCount is kept live by the gateway anyway, so a look costs a few reads of the
 * book and no Discord traffic at all.</p>
 */

'use strict';

const { EmbedBuilder, ChannelType } = require('discord.js');
const db = require('./db');

const COLOUR = 0xe2b24a;          // the same gold as the giveaways and the dashboard
/** Discord's boost levels. Nought means "not boosted", so only three of them are worth a message. */
const TIERS = [1, 2, 3];
/** Where the note lives that says the first look has already happened. */
const SEEDED = 'milestone:seeded';
/**
 * Whether the first look has been mentioned in the log yet. Only the log line: a bot with no book
 * genuinely does take that first look again every time, and must, or it would start announcing the
 * back catalogue - but saying so every ten minutes for ever is noise nobody needs.
 */
let saidFirstLook = false;

/** A number out of the environment, or the default when somebody has typed "ten". */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "25,50,100" as numbers, smallest first. Anything unreadable leaves the defaults alone. */
function readMarks(text, fallback) {
  const found = String(text ?? '').split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return found.length ? [...new Set(found)].sort((a, b) => a - b) : fallback;
}

const CONF = {
  channel: process.env.MILESTONE_CHANNEL || 'general',            // a channel name or an id
  members: readMarks(process.env.MILESTONE_MEMBERS, [25, 50, 100, 250, 500, 1000, 2500, 5000]),
  boosts: readMarks(process.env.MILESTONE_BOOSTS, [1, 2, 5, 10, 15, 25]),
  mention: process.env.MILESTONE_MENTION || '',                   // @everyone, a role, or nothing
  checkMinutes: num(process.env.MILESTONE_CHECK_MINUTES, 10),
  enabled: (process.env.MILESTONE_ENABLED || '1') !== '0',
};

// ---- the pure half, so the test can check it without Discord anywhere near it -------------------

/** 1000 -> "1,000". Written out rather than toLocaleString, which depends on where the bot runs. */
function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Where a milestone's note lives. The shape is deliberate: the book can be read by eye. */
function key(kind, value) {
  return `milestone:${kind}:${value}`;
}

/**
 * Which of these marks the value has reached and nobody has written down yet, smallest first.
 *
 * <p>Reached, not "just passed". The value is compared with the marks and with what is already in
 * the book, and never with what the value was last time - which is what makes a server that drops
 * under a hundred and climbs back to it quiet the second time round.</p>
 *
 * @param value the count as it is now
 * @param marks the numbers worth announcing, in any order
 * @param done  the marks already announced, as a Set or a plain list
 */
function crossed(value, marks, done = []) {
  const n = Number(value);
  if (!Number.isFinite(n)) return [];
  const already = new Set([...(done || [])].map(Number));
  const list = [...(marks || [])].map(Number).filter((m) => Number.isFinite(m));
  return [...new Set(list)]
    .filter((m) => n >= m && !already.has(m))
    .sort((a, b) => a - b);
}

/**
 * The wording, one milestone at a time.
 *
 * <p>Written out rather than generated because the interesting ones deserve their own sentence -
 * the first boost is the one that unlocks the boosted channels for everybody, and saying "1 boosts"
 * about it would be a waste of the moment. Numbers with no line of their own get the plain one.</p>
 */
const LINES = {
  members: {
    25: '**25 members.** Small, and everyone here on purpose.',
    50: '**50 members.** Half a hundred. The channels talk back now.',
    100: '**100 members.** Thank you, all hundred of you.',
    250: '**250 members.** A quarter of the way to a thousand, and still a room rather than a crowd.',
    500: '**500 members.** Five hundred people found their way here and stayed.',
    1000: '**1,000 members.** A thousand. That is a strange number to be able to write down.',
    2500: '**2,500 members.** Two and a half thousand of you. Make yourselves at home.',
    5000: '**5,000 members.** Five thousand, and it is still a decent place to be. That is down to you.',
  },
  boosts: {
    1: '**The first boost.** Somebody has just unlocked the boosted channels for everyone. Thank you, whoever you are.',
    2: '**Two boosts.** Somebody else has joined in.',
    5: '**Five boosts.** The perks are properly paid for now.',
    10: '**Ten boosts.** Ten people quietly paying for the rest of us.',
    15: '**Fifteen boosts.** A generous lot, this server.',
    25: '**Twenty-five boosts.** That is a great deal of goodwill in one place.',
  },
  tier: {
    1: '**Level 1.** More emoji, better audio, and a banner of our own.',
    2: '**Level 2.** Bigger uploads and better streams for everybody.',
    3: '**Level 3.** The top of the ladder. There is nothing left to unlock, so: thank you.',
  },
};

/** What to say about one milestone. Never empty, whatever it is handed. */
function line(kind, value) {
  const n = Number(value) || 0;
  const special = LINES[kind] && LINES[kind][n];
  if (special) return special;
  if (kind === 'members') return `**${commas(n)} members.** Thank you for being here.`;
  if (kind === 'boosts') return `**${commas(n)} boosts.** Thank you to everyone chipping in.`;
  if (kind === 'tier') return `**Level ${commas(n)}.** The server has gone up a boost level.`;
  return `**${commas(n)}.** A round number, and worth noticing.`;
}

/** How each kind reads in a log line. */
const LABEL = {
  members: (n) => `${commas(n)} members`,
  boosts: (n) => `${commas(n)} boost${Number(n) === 1 ? '' : 's'}`,
  tier: (n) => `level ${n}`,
};

// ---- the running part ----------------------------------------------------------------------------

/** One line of text, no title, no fields: a milestone is not a report. */
function card(kind, value) {
  return new EmbedBuilder().setColor(COLOUR).setDescription(line(kind, value));
}

/** The whole message. The mention only pings when one was configured; otherwise nothing is parsed. */
function message(kind, value) {
  return {
    content: CONF.mention || undefined,
    embeds: [card(kind, value)],
    allowedMentions: CONF.mention ? undefined : { parse: [] },
  };
}

function findChannel(guild, name) {
  const want = String(name || '').replace(/^#/, '').toLowerCase();
  if (!want || !guild) return null;
  return guild.channels.cache.find(
    (c) => (c.id === want || String(c.name || '').toLowerCase() === want)
      && typeof c.send === 'function' && c.type !== ChannelType.GuildCategory) || null;
}

function members(guild) {
  const n = Number(guild?.memberCount);
  return Number.isFinite(n) ? n : 0;
}

function boosts(guild) {
  const n = Number(guild?.premiumSubscriptionCount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The boost level as a plain number.
 *
 * <p>discord.js hands back its enum, which is already 0-3, but the raw gateway spells the same
 * thing "TIER_2" and a partial guild has no level at all; all three are read the same way here so
 * that nothing downstream has to care which one it got.</p>
 */
function tier(guild) {
  const raw = guild?.premiumTier;
  const n = typeof raw === 'string' ? Number(raw.replace(/\D+/g, '')) : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 3) : 0;
}

/** The three numbers this watches, in the order they would be announced. */
function readings(guild) {
  return [
    ['members', members(guild), CONF.members],
    ['boosts', boosts(guild), CONF.boosts],
    ['tier', tier(guild), TIERS],
  ];
}

/** Which of these marks the book already has a note for. */
function noted(kind, marks) {
  const out = new Set();
  for (const m of marks) if (db.get(key(kind, m))) out.add(Number(m));
  return out;
}

/**
 * Write a milestone down.
 *
 * <p>This happens before the message is sent, on purpose. A send that fails should be a line in the
 * log, not a milestone that comes round again on every pass for the rest of the week.</p>
 */
function note(kind, value, now) {
  db.set(key(kind, value), String(now));
}

/**
 * The first look at a server: everything already passed, written down without a word.
 *
 * <p>Otherwise switching this on for the first time would post the entire back catalogue at once,
 * which is both a wall of messages and a lie - nobody reached a hundred members this afternoon.
 * Guarded by its own note in the book, so it happens once and then never again.</p>
 *
 * @returns what it wrote down, or null if this server has been seeded before
 */
function seed(guild, { log = () => {}, now = Date.now() } = {}) {
  if (db.get(SEEDED)) return null;
  const past = [];
  for (const [kind, value, marks] of readings(guild)) {
    for (const mark of crossed(value, marks, noted(kind, marks))) {
      note(kind, mark, now);
      past.push(LABEL[kind](mark));
    }
  }
  db.set(SEEDED, String(now));
  if (!saidFirstLook) {
    saidFirstLook = true;
    log(past.length
      ? `[milestones] first look at this server: ${past.length} already passed`
        + ` (${past.join(', ')}), noted without a word`
      : '[milestones] first look at this server: nothing passed yet, so nothing to note');
  }
  return past;
}

/**
 * One pass: read the three numbers, say anything new, write down what was said.
 *
 * @returns the milestones announced, as { kind, value }
 */
async function check(guild, channel, { log = console.log, now = Date.now() } = {}) {
  if (!CONF.enabled || !guild || !channel) return [];

  // The very first look only writes the past down. A bot with no book is always on its first look,
  // because the note that would say otherwise has nowhere to go - so it stays quiet for good, which
  // is the only honest thing to do when "once each" cannot be promised.
  const seeding = seed(guild, { log, now });

  const said = [];
  for (const [kind, value, marks] of readings(guild)) {
    for (const mark of crossed(value, marks, noted(kind, marks))) {
      note(kind, mark, now);
      if (seeding) continue;
      try {
        await channel.send(message(kind, mark));
      } catch (e) {
        log(`[milestones] could not announce ${LABEL[kind](mark)}: ${e.message}`);
        continue;
      }
      db.event('milestone', kind, mark);
      db.bump('milestones');
      log(`[milestones] ${LABEL[kind](mark)} announced in #${channel.name}`);
      said.push({ kind, value: mark });
    }
  }
  return said;
}

/** The nearest numbers still to come, for the one line in the log at startup. */
function ahead(guild) {
  const out = [];
  for (const [kind, value, marks] of readings(guild)) {
    const soon = [...marks].map(Number)
      .filter((m) => Number.isFinite(m) && m > value)
      .sort((a, b) => a - b)[0];
    if (soon != null) out.push(LABEL[kind](soon));
  }
  return out.join(', ');
}

/**
 * Find the channel, take the first look, and then keep looking.
 *
 * <p>The interval is the whole mechanism: there is no event handler to wire, because no single
 * Discord event covers all three numbers and the bot would miss the ones that moved while it was
 * off anyway.</p>
 */
function start(client, { log = console.log, guildId } = {}) {
  const say = log;
  if (!CONF.enabled) { say('[milestones] off (MILESTONE_ENABLED=0)'); return null; }
  const guild = guildId ? client?.guilds?.cache?.get(guildId) : client?.guilds?.cache?.first();
  if (!guild) { say('[milestones] no guild - nothing to count'); return null; }
  const channel = findChannel(guild, CONF.channel);
  if (!channel) { say(`[milestones] no #${CONF.channel} - nothing to announce in`); return null; }

  seed(guild, { log: say });

  const every = Math.max(1, CONF.checkMinutes);
  const next = ahead(guild);
  say(`[milestones] #${channel.name}: ${LABEL.members(members(guild))},`
    + ` ${LABEL.boosts(boosts(guild))}, ${LABEL.tier(tier(guild))}`
    + `; looking every ${every}m${next ? `, next up: ${next}` : ', nothing left to reach'}`);

  const run = () => check(guild, channel, { log: say })
    .catch((e) => say(`[milestones] ${e.message}`));
  run();
  const timer = setInterval(run, every * 60 * 1000);
  timer.unref?.();
  return {
    check: (opts) => check(guild, channel, { log: say, ...opts }),
    stop: () => clearInterval(timer),
  };
}

module.exports = { start, check, crossed, line, CONF };
