const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function dayKey(iso) {
  const date = jstDate(iso);
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function formatJst(iso) {
  const date = jstDate(iso);
  if (!date) return '';
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function summarizeUsers(gifts) {
  const map = new Map();
  let coins = 0;
  let count = 0;
  const ordered = gifts.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const gift of ordered) {
    const amount = Number(gift.coins) || 0;
    coins += amount;
    count += 1;
    const key = gift.userId || gift.name || 'unknown';
    const row = map.get(key) || {
      userId: gift.userId || '',
      name: gift.name || '',
      coins: 0,
      count: 0,
    };
    row.coins += amount;
    row.count += 1;
    if (gift.name) row.name = gift.name;
    map.set(key, row);
  }
  const users = [...map.values()].sort((a, b) => b.coins - a.coins || String(a.name).localeCompare(String(b.name), 'ja'));
  return { coins, count, users };
}

function bounds(gifts) {
  const times = gifts.map((gift) => gift.at).filter(Boolean).sort();
  return {
    startedAt: times[0] || '',
    endedAt: times[times.length - 1] || '',
  };
}

function groupBy(gifts, keyOf) {
  const groups = new Map();
  for (const gift of gifts) {
    const key = keyOf(gift);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(gift);
  }
  return [...groups.entries()].map(([key, items]) => {
    const summary = summarizeUsers(items);
    const range = bounds(items);
    return { key, ...summary, ...range };
  }).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function buildExport(gifts, kind) {
  if (kind === 'gifts') {
    const rows = gifts.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).map((gift) => [
      formatJst(gift.at),
      dayKey(gift.at),
      gift.mediaId,
      gift.userId,
      gift.name,
      gift.gift,
      gift.coins,
    ]);
    return {
      filename: 'reality-gifts.csv',
      csv: toCsv(['\u65e5\u6642', '\u65e5\u4ed8', '\u914d\u4fe1ID', '\u30e6\u30fc\u30b6\u30fcID', '\u30e6\u30fc\u30b6\u30fc\u540d', '\u30ae\u30d5\u30c8', '\u30b3\u30a4\u30f3'], rows),
    };
  }

  if (kind === 'users') {
    const summary = summarizeUsers(gifts);
    const rows = summary.users.map((user) => [user.userId, user.name, user.count, user.coins]);
    rows.push(['', '\u7dcf\u8a08', summary.count, summary.coins]);
    return {
      filename: 'reality-users.csv',
      csv: toCsv(['\u30e6\u30fc\u30b6\u30fcID', '\u30e6\u30fc\u30b6\u30fc\u540d', '\u56de\u6570', '\u30b3\u30a4\u30f3'], rows),
    };
  }

  if (kind === 'streams') {
    const rows = [];
    for (const stream of groupBy(gifts, (gift) => gift.mediaId || '')) {
      rows.push(['\u914d\u4fe1\u5408\u8a08', stream.key, formatJst(stream.startedAt), formatJst(stream.endedAt), '', '', stream.users.length, stream.count, stream.coins]);
      for (const user of stream.users) {
        rows.push(['\u30e6\u30fc\u30b6\u30fc', stream.key, '', '', user.userId, user.name, '', user.count, user.coins]);
      }
    }
    return {
      filename: 'reality-by-stream.csv',
      csv: toCsv(['\u533a\u5206', '\u914d\u4fe1ID', '\u958b\u59cb', '\u7d42\u4e86', '\u30e6\u30fc\u30b6\u30fcID', '\u30e6\u30fc\u30b6\u30fc\u540d', '\u4eba\u6570', '\u56de\u6570', '\u30b3\u30a4\u30f3'], rows),
    };
  }

  if (kind === 'days') {
    const rows = [];
    for (const day of groupBy(gifts, (gift) => dayKey(gift.at))) {
      rows.push(['\u65e5\u5408\u8a08', day.key, '', '', day.users.length, day.count, day.coins]);
      for (const user of day.users) {
        rows.push(['\u30e6\u30fc\u30b6\u30fc', day.key, user.userId, user.name, '', user.count, user.coins]);
      }
    }
    return {
      filename: 'reality-by-day.csv',
      csv: toCsv(['\u533a\u5206', '\u65e5\u4ed8', '\u30e6\u30fc\u30b6\u30fcID', '\u30e6\u30fc\u30b6\u30fc\u540d', '\u4eba\u6570', '\u56de\u6570', '\u30b3\u30a4\u30f3'], rows),
    };
  }

  return null;
}

module.exports = {
  dayKey,
  formatJst,
  summarizeUsers,
  buildExport,
};
