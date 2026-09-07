/** No network, no Discord: the feed parser, the link reader and the "is this new" rule. */
'use strict';
const yt = require('./youtube');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

// ---- the feed --------------------------------------------------------------------------------
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
 <title>Lovkar</title>
 <author><name>Lovkar</name><uri>https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa</uri></author>
 <entry>
  <id>yt:video:K47KIgOEuzc</id>
  <yt:videoId>K47KIgOEuzc</yt:videoId>
  <yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId>
  <title>The Waking World &amp; the Colossi - 0.2 trailer</title>
  <author><name>Lovkar</name></author>
  <published>2026-09-07T10:00:00+00:00</published>
  <updated>2026-09-07T11:00:00+00:00</updated>
 </entry>
 <entry>
  <id>yt:video:PniTn4ldStY</id>
  <yt:videoId>PniTn4ldStY</yt:videoId>
  <title>An older devlog</title>
  <author><name>Lovkar</name></author>
  <published>2026-08-01T10:00:00+00:00</published>
  <updated>2026-08-01T10:00:00+00:00</updated>
 </entry>
</feed>`;

const entries = yt.parseFeed(FEED);
if (entries.length !== 2) fail(`two entries expected, got ${entries.length}`);
if (entries[0].id !== 'K47KIgOEuzc') fail('the first video id is wrong: ' + entries[0].id);
if (entries[0].title !== 'The Waking World & the Colossi - 0.2 trailer') fail('the ampersand was not unescaped: ' + entries[0].title);
if (entries[0].url !== 'https://youtu.be/K47KIgOEuzc') fail('the link is wrong: ' + entries[0].url);
if (entries[0].author !== 'Lovkar') fail('the author is wrong: ' + entries[0].author);
if (!yt.parseFeed('not xml at all').length === false) fail('rubbish should parse to nothing');
if (yt.parseFeed(null).length !== 0) fail('null should parse to nothing');
if (yt.parseFeed('<feed><entry><title>no id</title></entry></feed>').length !== 0) fail('an entry with no video id should be skipped');

// ---- reading links back out of Discord --------------------------------------------------------
const shapes = [
  ['https://youtu.be/K47KIgOEuzc', 'K47KIgOEuzc'],
  ['watch this https://www.youtube.com/watch?v=K47KIgOEuzc please', 'K47KIgOEuzc'],
  ['https://www.youtube.com/watch?t=30&v=K47KIgOEuzc', 'K47KIgOEuzc'],
  ['https://www.youtube.com/shorts/K47KIgOEuzc', 'K47KIgOEuzc'],
  ['https://www.youtube.com/live/K47KIgOEuzc', 'K47KIgOEuzc'],
  ['https://www.youtube.com/embed/K47KIgOEuzc?rel=0', 'K47KIgOEuzc'],
  ['https://youtu.be/K47KIgOEuzc?si=abc', 'K47KIgOEuzc'],
];
for (const [text, want] of shapes) {
  if (!yt.idsIn(text).has(want)) fail(`did not find ${want} in: ${text}`);
}
if (yt.idsIn('https://www.youtube.com/@Lovkar').size !== 0) fail('a channel link is not a video');
if (yt.idsIn('').size !== 0) fail('empty text has no ids');

// ---- what counts as new -----------------------------------------------------------------------
const NOW = Date.parse('2026-09-07T12:00:00Z');
const DAY = 24 * 3600 * 1000;

let out = yt.fresh(entries, { seen: new Set(), maxAgeMs: 2 * DAY, now: NOW });
if (out.length !== 1 || out[0].id !== 'K47KIgOEuzc') fail('only the recent one should post');

out = yt.fresh(entries, { seen: new Set(['K47KIgOEuzc']), maxAgeMs: 2 * DAY, now: NOW });
if (out.length !== 0) fail('a video already in the channel must not be posted again');

out = yt.fresh(entries, { seen: new Set(), maxAgeMs: 365 * DAY, now: NOW });
if (out.length !== 2) fail('a long cutoff should let both through');
if (out[0].id !== 'PniTn4ldStY') fail('they must come out oldest first, got ' + out[0].id);

out = yt.fresh(entries, { seen: new Set(), maxAgeMs: 1 * 3600 * 1000, now: NOW });
if (out.length !== 0) fail('nothing is fresh within an hour here');

// a re-uploaded title bumps `updated`, never `published` - it must not re-post
const edited = yt.parseFeed(FEED.replace('<updated>2026-09-07T11:00:00+00:00</updated>',
                                         '<updated>2026-09-07T11:59:00+00:00</updated>'));
if (yt.fresh(edited, { seen: new Set(['K47KIgOEuzc']), maxAgeMs: 2 * DAY, now: NOW }).length !== 0) {
  fail('an edited title must not look like a new video');
}

// ---- the two feeds ----------------------------------------------------------------------------
// A channel's uploads playlist is its id with UC swapped for UU. The watcher reads that one first
// because the channel feed leaves out anything made public after it was uploaded.
if (yt.uploadsPlaylist('UCuM9jBc53Gt1EQtDnUAsCeg') !== 'UUuM9jBc53Gt1EQtDnUAsCeg') {
  fail('the uploads playlist id is wrong: ' + yt.uploadsPlaylist('UCuM9jBc53Gt1EQtDnUAsCeg'));
}

// ---- the message ------------------------------------------------------------------------------
const line = yt.render('{mention}**New on YouTube: {title}**\\n{url}', entries[0], '');
if (line !== '**New on YouTube: The Waking World & the Colossi - 0.2 trailer**\nhttps://youtu.be/K47KIgOEuzc') {
  fail('the rendered message is wrong:\n' + JSON.stringify(line));
}
if (!yt.render('{mention} {title}', entries[0], '@everyone').startsWith('@everyone')) fail('the mention was dropped');

// ---- the channel id --------------------------------------------------------------------------
if (yt.channelIdFrom('UCaaaaaaaaaaaaaaaaaaaaaa') !== 'UCaaaaaaaaaaaaaaaaaaaaaa') fail('a bare id should pass through');
if (yt.channelIdFrom('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/videos') !== 'UCaaaaaaaaaaaaaaaaaaaaaa') fail('an id in a URL should be found');
if (yt.channelIdFrom('{"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa","x":1}') !== 'UCaaaaaaaaaaaaaaaaaaaaaa') fail('an id in page HTML should be found');
if (yt.channelIdFrom('@Lovkar') !== null) fail('a handle is not a channel id');
if (yt.channelIdFrom('') !== null) fail('nothing is not a channel id');

console.log(bad ? `\n${bad} failing` : 'all youtube cases pass');
process.exit(bad ? 1 : 0);
