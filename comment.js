const URL_PATTERN = /(\d+)\.([a-zA-Z0-9]+)/;

const TYPE = {
  STREAMER: 0,
  VIEWER: 1,
  LIKE: 2,
  GIFT: 3,
  FOLLOW: 4,
  SHARE: 5,
  SOFT: 6,
  WEARING: 7,
  ENTER: 8,
  SYSTEM: 9,
  AVATARGIFT: 10,
  MODERATOR_ADD: 11,
  MODERATOR_REMOVE: 12,
  MODERATION_LOG: 13,
  SUPPORTER_LEVEL_UP: 14,
  SUPPORTER_RANK_UP: 15,
  CLOSE: 100,
  HIDE: 101,
  COMMENT_BANNED: 102,
  COMMENT_UNBANNED: 103,
};

const TEXT = {
  supporter: '\u30b5\u30dd\u30fc\u30bf\u30fc',
  moderator: '\u30e2\u30c7\u30ec\u30fc\u30bf\u30fc',
  system: '\u30b7\u30b9\u30c6\u30e0',
  gave: '\u3092\u3042\u3052\u307e\u3057\u305f',
  coin: '\u30b3\u30a4\u30f3',
};

function parseMediaId(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const matched = text.match(URL_PATTERN);
  if (matched) return matched[1];
  if (/^\d+$/.test(text)) return text;
  return '';
}

function kindOf(type) {
  if (type === TYPE.STREAMER || type === TYPE.VIEWER) return 'comment';
  if (type === TYPE.GIFT || type === TYPE.AVATARGIFT) return 'gift';
  if (type === TYPE.LIKE) return 'like';
  if (type === TYPE.FOLLOW) return 'follow';
  if (type === TYPE.SHARE) return 'share';
  if (type === TYPE.ENTER) return 'enter';
  if (
    type === TYPE.SOFT
    || type === TYPE.WEARING
    || type === TYPE.SYSTEM
    || type === TYPE.MODERATOR_ADD
    || type === TYPE.MODERATOR_REMOVE
    || type === TYPE.MODERATION_LOG
    || type === TYPE.SUPPORTER_LEVEL_UP
    || type === TYPE.SUPPORTER_RANK_UP
  ) return 'system';
  return '';
}

const GACHA_TICKET = '\u30ac\u30c1\u30e3\u30c1\u30b1';

function isGachaTicketName(value) {
  return String(value || '').trim().startsWith(GACHA_TICKET);
}

function isGachaTicket(message) {
  const detail = message && message.gift_detail;
  if (detail && isGachaTicketName(detail.name)) return true;
  const parts = String((message && message.content) || '').split(',');
  return parts.length >= 2 && isGachaTicketName(parts[1]);
}

function parseGift(message) {
  const detail = message && message.gift_detail;
  let text = '';
  let price = 0;
  if (detail && (detail.comment || detail.name || detail.consumption != null)) {
    const parsed = Number(detail.consumption);
    const fallback = detail.name ? `${detail.name}${TEXT.gave}` : '';
    text = String(detail.comment || fallback);
    price = Number.isFinite(parsed) ? parsed : 0;
  } else {
    const parts = String((message && message.content) || '').split(',');
    if (parts.length < 4) {
      text = String((message && message.content) || '');
    } else {
      const parsed = Number(parts[2]);
      text = parts.slice(3).join(',');
      price = Number.isFinite(parsed) ? parsed : 0;
    }
  }
  if (isGachaTicket(message) || isGachaTicketName(text)) price = 0;
  return { text, price };
}

function displayText(message, kind) {
  if (message.comment_operation && message.comment_operation.operator_message) {
    return { text: String(message.comment_operation.operator_message), price: 0 };
  }
  if (kind === 'gift') return parseGift(message);
  return { text: String(message.content || ''), price: 0 };
}

function allowed(kind, settings) {
  if (kind === 'comment') return true;
  if (kind === 'gift') return settings.includeGift !== false;
  if (kind === 'like') return !!settings.includeLike;
  if (kind === 'enter') return !!settings.includeEnter;
  if (kind === 'follow') return !!settings.includeFollow;
  if (kind === 'share') return !!settings.includeShare;
  if (kind === 'system') return settings.includeSystem !== false;
  return false;
}

const BADGE_BASE = 'http://localhost:11180/plugins/com.reality.onecomme.comments/badges';

const HIGHLIGHT = {
  like: '#ffe08a',
  enter: '#c8e6ff',
};

function highlightColors(kind) {
  const background = HIGHLIGHT[kind];
  if (!background) return null;
  return {
    bodyBackgroundColor: background,
    bodyTextColor: '#111111',
    headerBackgroundColor: background,
    headerTextColor: '#111111',
    authorNameTextColor: '#111111',
  };
}

function supporterBadgeUrl(rank) {
  if (rank >= 1 && rank <= 7) return `${BADGE_BASE}/supporter-${rank}.png`;
  return `https://reality.app/img/comment/supporter_rank${rank}.png`;
}

function badgesOf(message) {
  const badges = [];
  const rank = message.revised_supporter_badge && message.revised_supporter_badge.supporterRank;
  if (rank > 0) {
    badges.push({
      label: `${TEXT.supporter}${rank}`,
      url: supporterBadgeUrl(rank),
    });
  }
  if (message.show_moderator_icon) {
    badges.push({
      label: TEXT.moderator,
      url: 'https://reality.app/img/comment/moderator.png',
    });
  }
  return badges;
}

function toOneCommeComment(message, settings) {
  if (!message || typeof message !== 'object') return null;
  if (message.hidden) return null;
  if (message.is_resent && !settings.includeHistory) return null;

  const type = Number(message.content_type);
  if (type === TYPE.HIDE || type === TYPE.COMMENT_BANNED || type === TYPE.COMMENT_UNBANNED) return null;
  if (type === TYPE.CLOSE) return null;

  const kind = kindOf(type);
  if (!kind || !allowed(kind, settings)) return null;

  const shown = displayText(message, kind);
  const text = String(shown.text || '').trim();
  if (!text) return null;

  const comment = {
    id: String(message.comment_id || ''),
    userId: String(message.vlive_id || 'reality-system'),
    name: String(message.nickname || (kind === 'system' ? TEXT.system : 'REALITY')),
    comment: text,
    profileImage: String(message.icon_url || ''),
    isOwner: type === TYPE.STREAMER || message.is_self === true,
    hasGift: kind === 'gift',
    badges: badgesOf(message),
    timestamp: message.created_at || undefined,
  };
  if (kind === 'gift') {
    comment.price = shown.price;
    comment.unit = TEXT.coin;
  }
  const colors = highlightColors(kind);
  if (colors) comment.colors = colors;
  return comment;
}

function giftCoins(message) {
  if (!message || message.hidden) return null;
  const type = Number(message.content_type);
  if (type !== TYPE.GIFT && type !== TYPE.AVATARGIFT) return null;
  const price = parseGift(message).price;
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function giftRecord(message, mediaId) {
  const coins = giftCoins(message);
  if (coins == null || coins <= 0) return null;
  const id = String(message.comment_id || '');
  if (!id) return null;
  return {
    id,
    mediaId: String(message.media_id || mediaId || ''),
    userId: String(message.vlive_id || ''),
    name: String(message.nickname || ''),
    coins,
    at: message.created_at || new Date().toISOString(),
    gift: String(parseGift(message).text || ''),
  };
}

module.exports = {
  TYPE,
  parseMediaId,
  toOneCommeComment,
  giftCoins,
  giftRecord,
  isGachaTicketName,
};
