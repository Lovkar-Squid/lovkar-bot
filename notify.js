/**
 * notify.js - tell Lovkar the moment a bug is reported.
 *
 * Triage tags the post and answers the reporter; this is the other half - Lovkar hears about it
 * without watching the forum. Two ways, both on by default: a DM to the server owner (that is what
 * reaches a phone) and a mention in the moderators' channel (that is the record, and what a second
 * moderator sees). Either one failing is logged and never stops the other, and neither can stop the
 * triage that runs before it.
 *
 * Settings (environment, all optional):
 *   BUG_NOTIFY          dm | channel | both | off   (default both)
 *   BUG_NOTIFY_CHANNEL  name of the moderators' channel      (default moderator-only)
 *   BUG_NOTIFY_USER     Discord user id to tell; default: the server's owner
 *
 * The DM and the mention carry the same card: severity, title, reporter, project, whether a log is
 * still needed, the first line of the report, and the link to the post. Only the one person named
 * is ever pinged - allowedMentions is pinned to that id whatever the report text contains.
 */

const db = require('./db');

const CONF = {
  mode: (process.env.BUG_NOTIFY || 'both').trim().toLowerCase(),
  channel: (process.env.BUG_NOTIFY_CHANNEL || 'moderator-only').trim(),
  userId: (process.env.BUG_NOTIFY_USER || '').trim(),
};

const SEVERITY = { critical: '🔴 Critical', major: '🟠 Major', minor: '🟡 Minor' };

/** The first line of the report, trimmed to fit a card. */
function firstLine(body, max = 240) {
  const line = String(body || '').split('\n').map((l) => l.trim()).find((l) => l) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/**
 * The text of the notice. Pure, so the test can read it: `thread` needs name/url, `verdict`
 * severity/project/needsLog, `starter` is the starter message (author, content) or null.
 */
function card(thread, verdict, starter, { mention = '' } = {}) {
  const sev = SEVERITY[verdict?.severity] || verdict?.severity || 'unrated';
  const who = starter?.author?.tag || starter?.author?.username || 'somebody';
  const lines = [];
  lines.push(`${mention ? mention + ' ' : ''}🐛 **New bug report** - ${sev}`);
  lines.push(`**${thread.name}** by ${who}`);
  const meta = [];
  if (verdict?.project) meta.push(`project: ${verdict.project}`);
  meta.push(verdict?.needsLog ? 'log: still needed' : 'log: attached or not needed');
  lines.push(meta.join(' · '));
  const line = firstLine(starter?.content);
  if (line) lines.push(`> ${line}`);
  lines.push(thread.url || `https://discord.com/channels/${thread.guildId}/${thread.id}`);
  return lines.join('\n');
}

function wants(what) {
  return CONF.mode === 'both' || CONF.mode === what;
}

function findChannel(guild, name) {
  if (!guild || !name) return null;
  const wanted = name.toLowerCase().replace(/^#/, '');
  for (const c of guild.channels.cache.values()) {
    if (c && c.isTextBased?.() && !c.isThread?.() && String(c.name).toLowerCase() === wanted) return c;
  }
  return null;
}

/**
 * Notify about one triaged post. Returns { dm, channel } - true where the notice went out.
 * Never throws: a closed DM inbox or a channel the bot cannot see is logged and that is all.
 */
async function bugReport(thread, verdict, starter, { log = console.log } = {}) {
  const out = { dm: false, channel: false };
  if (CONF.mode === 'off') return out;
  const guild = thread?.guild;
  const client = thread?.client;
  if (!guild || !client) return out;
  const userId = CONF.userId || guild.ownerId;

  if (wants('dm') && userId) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ content: card(thread, verdict, starter), allowedMentions: { parse: [] } });
      out.dm = true;
      log(`[notify] DM about "${thread.name}" sent to ${user.tag}`);
    } catch (e) {
      log(`[notify] could not DM ${userId} about "${thread.name}": ${e.message}`);
    }
  }

  if (wants('channel')) {
    const channel = findChannel(guild, CONF.channel);
    if (!channel) {
      log(`[notify] no #${CONF.channel} in ${guild.name} - nobody was mentioned`);
    } else {
      try {
        const mention = userId ? `<@${userId}>` : '';
        await channel.send({
          content: card(thread, verdict, starter, { mention }),
          allowedMentions: { users: userId ? [userId] : [] },
        });
        out.channel = true;
        log(`[notify] "${thread.name}" mentioned in #${channel.name}`);
      } catch (e) {
        log(`[notify] could not post in #${channel.name}: ${e.message}`);
      }
    }
  }

  if (out.dm || out.channel) {
    db.event('notify', starter?.author?.tag || thread.name, `${verdict?.severity || '?'} - dm ${out.dm ? 'yes' : 'no'}, channel ${out.channel ? 'yes' : 'no'}`);
  }
  return out;
}

module.exports = { bugReport, card, firstLine, findChannel, CONF };
