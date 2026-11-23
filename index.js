// GD音乐台 音源插件（纯 JS，无辅助程序）。
// 开发者 API 与国内、国际网页线路。出处：GD音乐台 (music.gdstudio.xyz)。
// 站方曾公布每 5 分钟 50 次。窗口计数用于降低辅助请求量，播放按服务端响应重试。
//
// 喜欢、歌单、历史保存在 host.storage，MyGo Music Plus 可同步这些数据。
// 离线播放交给 App 自身的歌曲缓存与下载管理器，插件不再自有离线层。

// GD Studio's public webpage checksum, inspected on 2026-11-23.
// https://music.gdstudio.org/js/crc32.min.js?v=20261123
// The site uses MD5 rounds with a different constant in round 58.
// Signature input is ASCII: time, hostname, version and URL-encoded text.
const shifts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
constants[57] = 0x67b94013;

function siteDigest(text) {
  const length = Math.ceil((text.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  bytes[text.length] = 0x80;
  const words = new DataView(bytes.buffer);
  words.setUint32(length - 8, text.length * 8, true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let block = 0; block < length; block += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      let mixed, word;
      if (i < 16) {
        mixed = (b & c) | (~b & d);
        word = i;
      } else if (i < 32) {
        mixed = (d & b) | (~d & c);
        word = (5 * i + 1) % 16;
      } else if (i < 48) {
        mixed = b ^ c ^ d;
        word = (3 * i + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        word = (7 * i) % 16;
      }
      const sum = (a + mixed + constants[i] + words.getUint32(block + word * 4, true)) | 0;
      const rotated = (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }
  return state.flatMap(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0'))).join('');
}

function siteSignature(encoded, hostname, version, seconds) {
  const release = version.split('.').map(part => part.padStart(2, '0')).join('');
  return siteDigest(`${String(Math.floor(seconds)).slice(0, 9)}|${hostname}|${release}|${encoded}`).slice(-8).toUpperCase();
}

const API = "https://music-api.gdstudio.xyz/api.php";
const SITES = { domestic: 'https://music.gdstudio.org', international: 'https://music.gdstudio.xyz' };
const siteConfigs = new Map();
const COUNT = 20;

// 音质 → API 码率（128/192/320/740/999；999 为 24bit 无损）。
const BR = { standard: 128, high: 320, lossless: 999 };

// 辅助请求使用 5 分钟预算，播放地址由服务端决定是否限流。
const RATE_WINDOW = 300000;
const COVER_LIMIT = 35;
const FOREGROUND_LIMIT = 45;
const COVER_BUDGET = 2500;
const COVER_TTL = 24 * 60 * 60 * 1000;

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

const load = (key, fallback) => host.storage.get(key) ?? fallback;
const save = (key, value) => host.storage.set(key, value);
const requests = new Map();
const searches = new Map();
const rate = load("requestCache", { stamps: [], until: 0, status: 0 });

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));
const siteEncode = (s) => enc(s).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

function serviceLine() {
  const line = host.setting('service') || '';
  if (line && !SITES[line]) throw fail('setup', '请在服务线路中选择开发者 API、国内网页或国际网页');
  return line;
}

function rateError(until, status) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  let message = `GD音乐台请求额度暂时用尽，请 ${seconds} 秒后重试`;
  if (status === 403) message = `GD音乐台拒绝访问（HTTP 403，可能触发限流或站点访问限制），请 ${seconds} 秒后重试`;
  if (status === 429) message = `GD音乐台请求过于频繁（HTTP 429），请 ${seconds} 秒后重试`;
  const error = fail("rateLimit", message);
  error.retryAt = until;
  return error;
}

// Reserve synchronously before fetch so concurrent requests share one budget.
function reserve(type) {
  const now = Date.now();
  rate.stamps = rate.stamps.filter((at) => now - at < RATE_WINDOW);
  if (rate.until > now) throw rateError(rate.until, rate.status);
  const limit = type === "pic" ? COVER_LIMIT : FOREGROUND_LIMIT;
  if (type !== "url" && rate.stamps.length >= limit) throw rateError(rate.stamps[rate.stamps.length - limit] + RATE_WINDOW, 0);
  rate.stamps.push(now);
  save("requestCache", rate);
}

async function fetchBody(url, type, deadline, text = false) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw fail('timeout', 'GD音乐台请求超时，请稍后重试');
  reserve(type);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (r.status === 403 || r.status === 429) {
      const retry = r.headers.get("Retry-After");
      let wait = r.status === 429 ? RATE_WINDOW : 60000;
      if (retry) {
        const seconds = Number(retry);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        if (Number.isFinite(delay) && delay > 0) wait = delay;
      }
      rate.until = Math.max(rate.until, Date.now() + wait);
      rate.status = r.status;
      save("requestCache", rate);
      throw rateError(rate.until, r.status);
    }
    if (!r.ok) {
      const error = new Error("GD音乐台接口返回 HTTP " + r.status);
      error.status = r.status;
      throw error;
    }
    return text ? await r.text() : await r.json();
  } catch (error) {
    if (controller.signal.aborted) throw fail("timeout", "GD音乐台请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function siteConfig(line, type, deadline) {
  const cached = siteConfigs.get(line);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const base = SITES[line];
  const pending = Promise.all([
    fetchBody(base + '/js/player.js', type, deadline, true),
    fetchBody(base + '/time', type, deadline, true).then(text => ({ seconds: Number(text.trim()), received: Date.now() })),
  ]).then(([script, clock]) => {
    const version = script.match(/\bversion\s*:\s*["'](\d{4}\.\d{1,2}\.\d{1,2})["']/)?.[1];
    if (!version || !Number.isFinite(clock.seconds) || clock.seconds < 1000000000 || clock.seconds > 10000000000) {
      throw fail('unavailable', 'GD音乐台网页协议信息读取失败，请切换服务线路后重试');
    }
    return { version, offset: clock.seconds * 1000 - clock.received };
  });
  const entry = { pending, expiresAt: Date.now() + 600000 };
  siteConfigs.set(line, entry);
  try {
    return await pending;
  } catch (error) {
    if (siteConfigs.get(line) === entry) siteConfigs.delete(line);
    throw error;
  }
}

async function request(params, timeout, line) {
  const deadline = Date.now() + timeout;
  const encode = line ? siteEncode : enc;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encode(v)}`).join('&');
  if (!line) return fetchBody(`${API}?${qs}`, params.types, deadline);
  const base = SITES[line];
  for (let attempt = 0; attempt < 2; attempt++) {
    const config = await siteConfig(line, params.types, deadline);
    const sign = siteSignature(encode(params.name ?? params.id), new URL(base).hostname, config.version, (Date.now() + config.offset) / 1000);
    try {
      const result = await fetchBody(`${base}/api.php?${qs}&s=${sign}`, params.types, deadline);
      if (result?.url && !/^https?:\/\//i.test(result.url) && result.url !== 'err') {
        result.url = new URL(result.url, base + '/').href;
      }
      return result;
    } catch (error) {
      if (error.status !== 401) throw error;
      siteConfigs.delete(line);
      if (attempt === 1) throw fail('unavailable', 'GD音乐台网页校验失败，请切换至开发者 API 或更新插件');
    }
  }
}

async function api(params, timeout = 15000, line = serviceLine()) {
  const key = JSON.stringify([line, params]);
  if (requests.has(key)) return requests.get(key);
  const pending = request(params, timeout, line);
  requests.set(key, pending);
  try {
    return await pending;
  } finally {
    requests.delete(key);
  }
}

const encodeId = (parts) => parts.map((p) => enc(p)).join("|");
const decodeId = (id) => id.split("|").map(decodeURIComponent);

const coversPending = new Map();
const coverCache = () => load("coverCache", {});

function cachedCover(source, picId, cache = coverCache(), legacy = load("covers", {}), line = serviceLine()) {
  const key = source + ":" + picId;
  if (line) return cache[line + ':' + key] || { url: '', expiresAt: 0, retryAt: 0 };
  return cache[key] || { url: legacy[key] || "", expiresAt: 0, retryAt: 0 };
}

function saveCover(key, entry) {
  const cache = coverCache();
  cache[key] = entry;
  save("coverCache", cache);
}

async function fetchCover(source, picId, deadline, previous, line) {
  const key = (line ? line + ':' : '') + source + ":" + picId;
  try {
    for (const size of [500, 300]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const r = await api({ types: "pic", source, id: picId, size }, remaining, line);
      const u = (r && r.url) || "";
      if (/^https?:\/\//i.test(u)) {
        saveCover(key, { url: u, expiresAt: Date.now() + COVER_TTL, retryAt: 0 });
        return u;
      }
    }
  } catch (error) {
    saveCover(key, { ...previous, retryAt: error.retryAt || Date.now() + 60000 });
    return previous.url;
  }
  saveCover(key, { ...previous, retryAt: Date.now() + 60000 });
  return previous.url;
}

async function resolveCover(source, picId, deadline, line) {
  const key = (line ? line + ':' : '') + source + ":" + picId;
  const entry = cachedCover(source, picId, coverCache(), load('covers', {}), line);
  if (entry.expiresAt > Date.now() || entry.retryAt > Date.now()) return entry.url;
  if (coversPending.has(key)) return coversPending.get(key);
  const pending = fetchCover(source, picId, deadline, entry, line);
  coversPending.set(key, pending);
  try {
    return await pending;
  } finally {
    coversPending.delete(key);
  }
}

function durationOf(raw) {
  const ms = Number(raw.duration_ms || (raw.extra_data || {}).duration * 1000);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

const toTrack = (t, source) => {
  const names = Array.isArray(t.artist) ? t.artist : String(t.artist || "").split(",");
  const src = t.source || source;
  const id = encodeId([src, t.id, t.pic_id || "", t.lyric_id || t.id]);
  const extra = t.extra_data || {};
  return {
    id,
    name: String(t.name || ""),
    artists: names.map((n, i) => ({ id: String((extra.artist_ids || [])[i] || n), name: String(n).trim() })),
    album: { id: String(extra.album_id || ""), name: String(t.album || ""), imageUrl: "" },
    duration: durationOf(t),
    unavailable: extra.is_available === false,
  };
};

// The host has no incremental result callback. Bound the entire cover pass,
// then retry missing/stale artwork when a list is opened again.
async function fillCovers(tracks, line = serviceLine()) {
  const cache = coverCache();
  const legacy = load("covers", {});
  const todo = [];
  tracks.forEach((tr) => {
    const [src, , pic] = decodeId(tr.id);
    if (!pic) return;
    const entry = cachedCover(src, pic, cache, legacy, line);
    tr.album.imageUrl = entry.url;
    if (entry.expiresAt <= Date.now() && entry.retryAt <= Date.now()) todo.push({ tr, src, pic });
  });
  if (!todo.length) return;
  const deadline = Date.now() + COVER_BUDGET;
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length && Date.now() < deadline) {
      const { tr, src, pic } = todo[idx++];
      try {
        const u = await resolveCover(src, pic, deadline, line);
        if (u) tr.album.imageUrl = u;
      } catch (e) {
        // 封面失败不影响列表。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
}

// 歌曲库：搜索见过的歌存下来，喜欢/歌单/历史只存 id，渲染时据此还原。
function referenced() {
  const s = new Set(load("liked", []));
  for (const p of load("playlists", [])) for (const id of p.trackIds || []) s.add(id);
  for (const id of load("history", [])) s.add(id);
  return s;
}

function remember(tracks) {
  const songs = load("songs", {});
  for (const t of tracks) {
    const [src, , picId] = decodeId(t.id);
    const previous = songs[t.id];
    if (!t.duration && previous && previous.durationVerified) t.duration = previous.t.duration;
    songs[t.id] = { t, src, pic: picId, durationVerified: t.duration > 0 };
  }
  const ref = referenced();
  const keys = Object.keys(songs);
  if (keys.length > 2000) {
    for (const k of keys) {
      if (Object.keys(songs).length <= 1500) break;
      if (!ref.has(k)) delete songs[k];
    }
  }
  save("songs", songs);
}

function songsByIds(ids) {
  const songs = load("songs", {});
  const cache = coverCache();
  const legacy = load("covers", {});
  const out = [];
  for (const id of ids) {
    const rec = songs[id];
    if (!rec) continue;
    const t = { ...rec.t, album: { ...rec.t.album } };
    t.album.imageUrl = rec.pic ? cachedCover(rec.src, rec.pic, cache, legacy).url : "";
    t.duration = rec.durationVerified ? t.duration : 0;
    out.push(t);
  }
  return out;
}

async function hydratedSongs(ids) {
  const tracks = songsByIds(ids);
  await fillCovers(tracks);
  return tracks;
}

export async function search({ query, kind, offset }) {
  if (kind !== "tracks") throw fail("unsupported", "GD音乐台只支持搜索歌曲");
  const source = host.setting("source") || "netease";
  const line = serviceLine();
  const page = Math.floor((offset || 0) / COUNT) + 1;
  const key = JSON.stringify([line, source, query, page]);
  const cached = searches.get(key);
  let items;
  if (cached && cached.expiresAt > Date.now()) items = cached.items;
  else {
    items = await api({ types: "search", source, name: query, count: COUNT, pages: page }, 15000, line);
    if (!Array.isArray(items)) throw new Error("GD音乐台返回了异常的搜索结果，请稍后重试");
    searches.delete(key);
    searches.set(key, { items, expiresAt: Date.now() + 120000 });
    if (searches.size > 10) searches.delete(searches.keys().next().value);
  }
  const valid = items.filter((t) => t && t.id);
  const tracks = valid.map((t) => toTrack(t, source));
  await fillCovers(tracks, line);
  remember(tracks);
  return { tracks, more: valid.length === COUNT };
}

// 从 CDN URL 猜音频格式；猜不出按码率定 flac/mp3。
const extOf = (url, br) => {
  const m = String(url).split("?")[0].match(/\.(mp3|flac|ogg|wav|m4a|aac)$/i);
  return m ? m[1].toLowerCase() : (parseInt(br, 10) || 0) > 320 ? "flac" : "mp3";
};

export async function stream({ id, quality }) {
  const br = BR[quality] || 320;
  const [source, urlId] = decodeId(id);
  const r = await api({ types: "url", source, id: urlId, br });
  if (!r || !r.url || r.url === "err") throw fail("unavailable", "这首歌暂时无法播放");
  // Only explicitly byte-denominated sizes are passed to the app. The legacy
  // size field has an uncertain unit; HTTP supplies the actual transfer length.
  const bytes = Number(r.size_bytes);
  const result = { url: r.url, type: extOf(r.url, r.br || br), size: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0 };
  if (Number(r.br) > 0) result.quality = Number(r.br) >= 740 ? "lossless" : Number(r.br) >= 320 ? "high" : "standard";
  return result;
}

export async function lyrics({ id }) {
  const [source, , , lyricId] = decodeId(id);
  const r = await api({ types: "lyric", source, id: lyricId });
  return { lrc: (r && r.lyric) || "", translation: (r && r.tlyric) || "" };
}

// 我喜欢（本机）。
export function like({ id, on }) {
  const set = new Set(load("liked", []));
  if (on) set.add(id);
  else set.delete(id);
  const ids = [...set];
  if (on) {
    ids.splice(ids.indexOf(id), 1);
    ids.unshift(id);
  }
  save("liked", ids);
}

export function isLiked({ ids }) {
  const set = new Set(load("liked", []));
  return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
}

export async function liked({ offset }) {
  const ids = load("liked", []);
  const start = offset || 0;
  return {
    tracks: await hydratedSongs(ids.slice(start, start + COUNT)),
    more: start + COUNT < ids.length,
  };
}

// 本地歌单（本机）。
const playlistsNow = () => load("playlists", []);

function changePlaylist(id, change) {
  const all = playlistsNow();
  const p = all.find((p) => p.id === id);
  if (!p) throw fail("unavailable", "歌单不存在");
  change(p);
  save("playlists", all);
}

export async function playlists() {
  const lists = playlistsNow();
  const first = await hydratedSongs(lists.map((p) => (p.trackIds || [])[0]).filter(Boolean));
  const covers = new Map(first.map((t) => [t.id, t.album.imageUrl]));
  return lists.map((p) => ({
    id: p.id,
    name: p.name,
    mine: true,
    trackCount: (p.trackIds || []).length,
    imageUrl: covers.get((p.trackIds || [])[0]) || "",
  }));
}

export async function playlist({ id }) {
  const p = playlistsNow().find((p) => p.id === id);
  if (!p) throw fail("unavailable", "歌单不存在");
  const tracks = await hydratedSongs(p.trackIds || []);
  return { ...p, tracks, trackCount: (p.trackIds || []).length, imageUrl: tracks[0]?.album.imageUrl || "" };
}

export function createPlaylist({ name }) {
  const made = { id: "gd" + Date.now(), name: String(name || "新歌单"), mine: true, trackIds: [] };
  save("playlists", [...playlistsNow(), made]);
  return { ...made, tracks: [], trackCount: 0 };
}

export function renamePlaylist({ id, name }) {
  changePlaylist(id, (p) => (p.name = String(name)));
}

export function deletePlaylist({ id }) {
  save("playlists", playlistsNow().filter((p) => p.id !== id));
}

export function addToPlaylist({ id, trackIds }) {
  changePlaylist(id, (p) => {
    const have = new Set(p.trackIds || []);
    const add = [];
    for (const t of trackIds || []) {
      if (!have.has(t)) {
        have.add(t);
        add.push(t);
      }
    }
    p.trackIds = [...(p.trackIds || []), ...add];
  });
}

export function removeFromPlaylist({ id, trackIds }) {
  const drop = new Set(trackIds || []);
  changePlaylist(id, (p) => (p.trackIds = (p.trackIds || []).filter((t) => !drop.has(t))));
}

export function movePlaylistTrack({ id, from, to }) {
  changePlaylist(id, (p) => {
    const ids = p.trackIds || [];
    if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    p.trackIds = ids;
  });
}

// 听歌历史（本机）。
const HISTORY_MAX = 300;

export function played({ id }) {
  const ids = load("history", []).filter((x) => x !== id);
  ids.unshift(id);
  save("history", ids.slice(0, HISTORY_MAX));
}

export async function recent() {
  return hydratedSongs(load("history", []).slice(0, COUNT));
}

export async function browse({ page }) {
  if (page === "history") {
    const ids = load("history", []);
    return {
      title: "听歌历史",
      subtitle: ids.length ? `${ids.length} 首` : "",
      sections: [{ tracks: await hydratedSongs(ids), empty: "还没有播放记录，去搜首歌听听吧" }],
    };
  }
  throw fail("unavailable", "没有这个页面");
}
