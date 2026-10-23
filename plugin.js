const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectSocket } = require('./socket');
const { parseMediaId, toOneCommeComment, giftRecord, isGachaTicketName } = require('./comment');
const { summarizeUsers, buildExport, dayKey } = require('./stats');

const UID = 'com.reality.onecomme.comments';
const ONECOMME_PORT = 11180;
const REFRESH_MS = 45 * 60 * 1000;
const PING_MS = 20000;
const SEEN_LIMIT = 4000;

const TEXT = {
  badUrl: '\u30b3\u30e1\u30f3\u30c8URL\u306e\u5f62\u5f0f\u304c\u9055\u3044\u307e\u3059',
  noUrl: '\u30b3\u30e1\u30f3\u30c8URL\u304c\u672a\u8a2d\u5b9a\u3067\u3059',
  noService: '\u53d6\u308a\u8fbc\u307f\u5148\u306e\u67a0\u304c\u672a\u9078\u629e\u3067\u3059',
  connecting: '\u63a5\u7d9a\u3057\u307e\u3059',
  connected: '\u63a5\u7d9a\u3057\u307e\u3057\u305f',
  refresh: '\u63a5\u7d9a\u3092\u66f4\u65b0\u3057\u307e\u3059',
  closed: '\u5207\u65ad\u3055\u308c\u307e\u3057\u305f',
  retry: '\u5f8c\u306b\u518d\u63a5\u7d9a\u3057\u307e\u3059',
  postError: '\u9001\u4fe1\u30a8\u30e9\u30fc',
  postFailed: '\u308f\u3093\u30b3\u30e1\u3078\u306e\u9001\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
};

const DEFAULTS = {
  commentUrl: '',
  serviceId: '',
  includeHistory: false,
  includeLike: false,
  includeEnter: false,
  includeFollow: false,
  includeShare: false,
  includeSystem: true,
  includeGift: true,
};

const SETTING_KEYS = Object.keys(DEFAULTS);

function readBody(body) {
  if (body == null || body === '') return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch (error) { return {}; }
  }
  return body;
}

function queryString(req) {
  const raw = req && req.url ? String(req.url) : '';
  return raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
}

function queryParam(req, name) {
  if (req && req.params && req.params[name] != null && req.params[name] !== '') return String(req.params[name]);
  return new URLSearchParams(queryString(req)).get(name) || '';
}

function actionOf(req) {
  return queryParam(req, 'action');
}

function flag(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function safeFileName(value) {
  const text = String(value || 'unknown').replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 80);
  return text || 'unknown';
}

function atomicWrite(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
}

function postJson(path, payload) {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: ONECOMME_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const plugin = {
  name: 'REALITY\u30b3\u30e1\u30f3\u30c8',
  uid: UID,
  version: '1.3.3',
  author: 'local',
  url: `http://localhost:${ONECOMME_PORT}/plugins/${UID}/index.html`,
  permissions: [],
  defaultState: { ...DEFAULTS },

  store: null,
  dir: '',
  gifts: null,
  coinIds: null,
  stopped: false,
  generation: 0,
  socket: null,
  pingTimer: null,
  refreshTimer: null,
  retryTimer: null,
  stableTimer: null,
  exportTimer: null,
  openedAt: 0,
  retryDelay: 2000,
  seen: null,
  seenOrder: null,
  queue: null,
  draining: false,
  status: null,

  init({ store, dir }) {
    this.store = store;
    this.dir = dir || '';
    this.stopped = false;
    this.seen = new Set();
    this.seenOrder = [];
    this.gifts = [];
    this.coinIds = new Set();
    this.queue = [];
    this.draining = false;
    this.status = {
      connected: false,
      mediaId: '',
      lastError: '',
      posted: 0,
      received: 0,
      coins: 0,
      giftCount: 0,
      users: [],
      coinMediaId: '',
      coinFile: this.dir ? path.join(this.dir, 'coins.txt') : '',
      usersFile: this.dir ? path.join(this.dir, 'users.txt') : '',
      exportDir: this.dir ? path.join(this.dir, 'export') : '',
    };
    this.loadGifts();
    this.writeCoinFiles();
    this.writeExports();
    this.connect();
  },

  destroy() {
    this.stopped = true;
    if (this.exportTimer) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
      try { this.writeExports(); } catch (error) { /* shutting down */ }
    }
    this.disconnect();
  },

  readSettings() {
    const settings = { ...DEFAULTS };
    if (!this.store) return settings;
    for (const key of SETTING_KEYS) {
      const value = this.store.get(key);
      if (value !== undefined) settings[key] = value;
    }
    return settings;
  },

  writeSettings(partial) {
    const current = this.readSettings();
    const settings = {
      commentUrl: partial.commentUrl != null ? String(partial.commentUrl) : current.commentUrl,
      serviceId: partial.serviceId != null ? String(partial.serviceId) : current.serviceId,
      includeHistory: flag(partial.includeHistory, current.includeHistory),
      includeLike: flag(partial.includeLike, current.includeLike),
      includeEnter: flag(partial.includeEnter, current.includeEnter),
      includeFollow: flag(partial.includeFollow, current.includeFollow),
      includeShare: flag(partial.includeShare, current.includeShare),
      includeSystem: flag(partial.includeSystem, current.includeSystem),
      includeGift: flag(partial.includeGift, current.includeGift),
    };
    if (this.store) {
      for (const key of SETTING_KEYS) this.store.set(key, settings[key]);
    }
    return settings;
  },

  snapshot() {
    return {
      settings: this.readSettings(),
      status: { ...(this.status || {}) },
    };
  },

  remember(id) {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const dropped = this.seenOrder.splice(0, 1000);
      for (const oldId of dropped) this.seen.delete(oldId);
    }
    return true;
  },

  giftsPath() {
    return this.dir ? path.join(this.dir, 'gifts.json') : '';
  },

  loadGifts() {
    this.gifts = [];
    this.coinIds = new Set();
    const file = this.giftsPath();
    if (!file || !fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : (parsed && parsed.gifts);
      if (!Array.isArray(list)) return;
      let dropped = false;
      for (const gift of list) {
        if (!gift || !gift.id || this.coinIds.has(gift.id)) continue;
        if (isGachaTicketName(gift.gift)) {
          dropped = true;
          continue;
        }
        this.coinIds.add(String(gift.id));
        this.gifts.push(gift);
      }
      if (dropped) this.saveGifts();
    } catch (error) {
      console.error('[REALITY] gifts.json', error && error.message ? error.message : error);
    }
  },

  saveGifts() {
    const file = this.giftsPath();
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ gifts: this.gifts }), 'utf8');
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  },

  currentGifts() {
    const mediaId = this.status && this.status.coinMediaId;
    if (!mediaId) return [];
    return this.gifts.filter((gift) => gift.mediaId === mediaId);
  },

  refreshSummary() {
    const summary = summarizeUsers(this.currentGifts());
    this.status.coins = summary.coins;
    this.status.giftCount = summary.count;
    this.status.users = summary.users;
    this.writeCoinFiles();
    this.scheduleExport();
  },

  scheduleExport() {
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.exportTimer = setTimeout(() => {
      this.exportTimer = null;
      this.writeExports();
    }, 1500);
  },

  writeExports() {
    const dir = this.status && this.status.exportDir;
    if (!dir || !Array.isArray(this.gifts)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const kind of ['users', 'streams', 'days', 'gifts']) {
        const built = buildExport(this.gifts, kind);
        if (!built) continue;
        atomicWrite(path.join(dir, built.filename), built.csv);
      }
      const byStream = new Map();
      const byDay = new Map();
      for (const gift of this.gifts) {
        const stream = gift.mediaId || 'unknown';
        const day = dayKey(gift.at) || 'unknown';
        if (!byStream.has(stream)) byStream.set(stream, []);
        if (!byDay.has(day)) byDay.set(day, []);
        byStream.get(stream).push(gift);
        byDay.get(day).push(gift);
      }
      const current = this.status.coinMediaId;
      if (current && !byStream.has(current)) byStream.set(current, []);
      this.writeGrouped(path.join(dir, 'streams'), byStream);
      this.writeGrouped(path.join(dir, 'days'), byDay);
    } catch (error) {
      console.error('[REALITY] export', error && error.message ? error.message : error);
    }
  },

  writeGrouped(dir, groups) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [key, gifts] of groups) {
      const built = buildExport(gifts, 'users');
      if (!built) continue;
      atomicWrite(path.join(dir, `${safeFileName(key)}.csv`), built.csv);
    }
  },

  writeCoinFiles() {
    const coins = Number(this.status.coins || 0).toLocaleString('ja-JP');
    const users = Array.isArray(this.status.users) ? this.status.users : [];
    try {
      if (this.status.coinFile) fs.writeFileSync(this.status.coinFile, `${coins}\n`, 'utf8');
      if (this.status.usersFile) {
        const lines = [`\u5408\u8a08 ${coins}`];
        for (const user of users) lines.push(`${user.name || user.userId}\t${Number(user.coins).toLocaleString('ja-JP')}`);
        fs.writeFileSync(this.status.usersFile, `${lines.join('\n')}\n`, 'utf8');
      }
    } catch (error) {
      console.error('[REALITY] coins.txt', error && error.message ? error.message : error);
    }
  },

  ensureCoinMedia(mediaId) {
    if (!mediaId) return;
    this.status.coinMediaId = mediaId;
    this.refreshSummary();
  },

  resetCoins() {
    const mediaId = this.status.coinMediaId;
    if (!mediaId) return;
    this.gifts = this.gifts.filter((gift) => {
      if (gift.mediaId !== mediaId) return true;
      this.coinIds.delete(gift.id);
      return false;
    });
    this.saveGifts();
    this.refreshSummary();
  },

  addCoins(message) {
    const record = giftRecord(message, this.status.mediaId || this.status.coinMediaId);
    if (!record || this.coinIds.has(record.id)) return;
    this.coinIds.add(record.id);
    this.gifts.push(record);
    try {
      this.saveGifts();
    } catch (error) {
      console.error('[REALITY] gifts.json', error && error.message ? error.message : error);
    }
    if (!this.status.coinMediaId || record.mediaId === this.status.coinMediaId) {
      if (!this.status.coinMediaId) this.status.coinMediaId = record.mediaId;
      this.refreshSummary();
    }
  },

  exportCoins(kind) {
    const built = buildExport(this.gifts, kind);
    if (!built) return null;
    if (this.status.exportDir) {
      fs.mkdirSync(this.status.exportDir, { recursive: true });
      fs.writeFileSync(path.join(this.status.exportDir, built.filename), built.csv, 'utf8');
    }
    return built;
  },

  disconnect() {
    this.generation += 1;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.pingTimer = null;
    this.refreshTimer = null;
    this.retryTimer = null;
    this.stableTimer = null;
    if (this.socket) {
      const current = this.socket;
      this.socket = null;
      try { current.close(); } catch (error) { /* already closed */ }
    }
    if (this.status) this.status.connected = false;
  },

  connect() {
    if (this.stopped) return;
    const settings = this.readSettings();
    const mediaId = parseMediaId(settings.commentUrl);
    this.disconnect();
    const generation = this.generation;

    if (!mediaId) {
      this.status.mediaId = '';
      this.status.lastError = settings.commentUrl ? TEXT.badUrl : TEXT.noUrl;
      return;
    }
    if (!settings.serviceId) {
      this.status.mediaId = mediaId;
      this.status.lastError = TEXT.noService;
      return;
    }

    this.status.mediaId = mediaId;
    this.status.lastError = '';
    this.openedAt = 0;
    this.ensureCoinMedia(mediaId);
    console.info(`[REALITY] ${TEXT.connecting} media_id=${mediaId}`);

    this.socket = connectSocket(mediaId, {
      onOpen: () => {
        if (generation !== this.generation) return;
        this.status.connected = true;
        this.openedAt = Date.now();
        console.info(`[REALITY] ${TEXT.connected}`);
        this.stableTimer = setTimeout(() => {
          if (generation !== this.generation) return;
          this.retryDelay = 2000;
        }, 10000);
        this.pingTimer = setInterval(() => {
          if (generation !== this.generation || !this.socket) return;
          this.socket.ping();
        }, PING_MS);
        this.refreshTimer = setTimeout(() => {
          if (generation !== this.generation || this.stopped) return;
          console.info(`[REALITY] ${TEXT.refresh}`);
          this.connect();
        }, REFRESH_MS);
      },
      onMessage: (text) => {
        if (generation !== this.generation) return;
        this.onMessage(text);
      },
      onError: (error) => {
        if (generation !== this.generation) return;
        this.status.lastError = error && error.message ? error.message : String(error);
        console.error('[REALITY]', this.status.lastError);
      },
      onClose: (code, reason) => {
        if (generation !== this.generation || this.stopped) return;
        this.status.connected = false;
        this.socket = null;
        if (this.stableTimer) {
          clearTimeout(this.stableTimer);
          this.stableTimer = null;
        }
        const lived = this.openedAt ? Date.now() - this.openedAt : 0;
        const previous = this.retryDelay || 2000;
        const wait = lived > 0 && lived < 3000 ? Math.max(previous, 15000) : previous;
        this.retryDelay = Math.min(lived >= 10000 ? 2000 : previous * 2, 60000);
        const detail = code ? ` code=${code}${reason ? ` ${reason}` : ''}` : '';
        console.info(`[REALITY] ${TEXT.closed}${detail}\u3002${wait}ms${TEXT.retry}`);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (generation !== this.generation || this.stopped) return;
          this.connect();
        }, wait);
      },
    });
  },

  onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return;
    }
    this.status.received += 1;
    const id = message && message.comment_id ? String(message.comment_id) : '';
    if (!this.remember(id)) return;
    this.addCoins(message);

    const settings = this.readSettings();
    const comment = toOneCommeComment(message, settings);
    if (!comment) return;
    this.queue.push({ serviceId: settings.serviceId, comment });
    this.drain();
  },

  async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      try {
        await this.postComment(item.serviceId, item.comment);
      } catch (error) {
        this.status.lastError = error && error.message ? error.message : String(error);
        console.error(`[REALITY] ${TEXT.postError}`, this.status.lastError);
      }
    }
    this.draining = false;
  },

  async postComment(serviceId, comment) {
    const result = await postJson('/api/comments', {
      service: { id: serviceId },
      comment,
    });
    if (result.status >= 400) {
      this.status.lastError = `${TEXT.postFailed} (${result.status})`;
      console.error('[REALITY]', this.status.lastError, result.body.slice(0, 300));
      return;
    }
    this.status.posted += 1;
    if (this.status.lastError.startsWith(TEXT.postFailed)) this.status.lastError = '';
  },

  async request(req) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    const action = actionOf(req) || (method === 'GET' ? 'state' : 'save');

    if (method === 'GET' && action === 'state') {
      return { code: 200, response: this.snapshot() };
    }

    if (method === 'GET' && action === 'export') {
      const kind = queryParam(req, 'kind');
      const built = this.exportCoins(kind);
      if (!built) return { code: 404, response: { error: 'unknown export' } };
      return { code: 200, response: built };
    }

    if (method === 'POST' && action === 'save') {
      const body = readBody(req && req.body);
      const previous = this.readSettings();
      const settings = this.writeSettings(body);
      const urlChanged = settings.commentUrl !== previous.commentUrl;
      const historyTurnedOn = settings.includeHistory && !previous.includeHistory;
      if (urlChanged || historyTurnedOn) {
        this.seen = new Set();
        this.seenOrder = [];
      }
      this.connect();
      return { code: 200, response: this.snapshot() };
    }

    if (method === 'POST' && action === 'reconnect') {
      this.connect();
      return { code: 200, response: this.snapshot() };
    }

    if (method === 'POST' && action === 'reset-coins') {
      this.resetCoins();
      return { code: 200, response: this.snapshot() };
    }

    return { code: 404, response: { error: 'not found' } };
  },
};

module.exports = plugin;
