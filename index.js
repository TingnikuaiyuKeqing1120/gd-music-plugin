// GD音乐台 音源插件（纯 JS，无辅助程序）。
// 走 GD Studio 官方开发者 API：https://music-api.gdstudio.xyz/api.php
// 纯 HTTP GET、无签名、无需浏览器。出处：GD音乐台 (music.gdstudio.xyz)。
// 该 API 限频 5 分钟 50 次，使用滚动窗口计数，并为搜索和播放预留额度。
//
// 喜欢、歌单、历史保存在 host.storage，MyGo Music Plus 可同步这些数据。
// 离线播放交给 App 自身的歌曲缓存与下载管理器，插件不再自有离线层。

const API = "https://music-api.gdstudio.xyz/api.php";
const COUNT = 20;

// 音质 → API 码率（128/192/320/740/999；999 为 24bit 无损）。
const BR = { standard: 128, high: 320, lossless: 999 };

// 开发者 API 限频：5 分钟 50 次。
const RATE_MAX = 50;
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
  let limit = FOREGROUND_LIMIT;
  if (type === "pic") limit = COVER_LIMIT;
  if (type === "url") limit = RATE_MAX;
  if (rate.stamps.length >= limit) throw rateError(rate.stamps[rate.stamps.length - limit] + RATE_WINDOW, 0);
  rate.stamps.push(now);
  save("requestCache", rate);
}

async function request(params, timeout) {
  reserve(params.types);
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join("&");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(`${API}?${qs}`, { signal: controller.signal });
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
    if (!r.ok) throw new Error("GD音乐台接口返回 HTTP " + r.status);
    return await r.json();
  } catch (error) {
    if (controller.signal.aborted) throw fail("timeout", "GD音乐台请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function api(params, timeout = 15000) {
  const key = JSON.stringify(params);
  if (requests.has(key)) return requests.get(key);
  const pending = request(params, timeout);
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

function cachedCover(source, picId, cache = coverCache(), legacy = load("covers", {})) {
  const key = source + ":" + picId;
  return cache[key] || { url: legacy[key] || "", expiresAt: 0, retryAt: 0 };
}

function saveCover(key, entry) {
  const cache = coverCache();
  cache[key] = entry;
  save("coverCache", cache);
}

async function fetchCover(source, picId, deadline, previous) {
  const key = source + ":" + picId;
  try {
    for (const size of [500, 300]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const r = await api({ types: "pic", source, id: picId, size }, remaining);
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

async function resolveCover(source, picId, deadline) {
  const key = source + ":" + picId;
  const entry = cachedCover(source, picId);
  if (entry.expiresAt > Date.now() || entry.retryAt > Date.now()) return entry.url;
  if (coversPending.has(key)) return coversPending.get(key);
  const pending = fetchCover(source, picId, deadline, entry);
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
async function fillCovers(tracks) {
  const cache = coverCache();
  const legacy = load("covers", {});
  const todo = [];
  tracks.forEach((tr) => {
    const [src, , pic] = decodeId(tr.id);
    if (!pic) return;
    const entry = cachedCover(src, pic, cache, legacy);
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
        const u = await resolveCover(src, pic, deadline);
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
  const page = Math.floor((offset || 0) / COUNT) + 1;
  const key = JSON.stringify([source, query, page]);
  const cached = searches.get(key);
  let items;
  if (cached && cached.expiresAt > Date.now()) items = cached.items;
  else {
    items = await api({ types: "search", source, name: query, count: COUNT, pages: page });
    if (!Array.isArray(items)) throw new Error("GD音乐台返回了异常的搜索结果，请稍后重试");
    searches.delete(key);
    searches.set(key, { items, expiresAt: Date.now() + 120000 });
    if (searches.size > 10) searches.delete(searches.keys().next().value);
  }
  const valid = items.filter((t) => t && t.id);
  const tracks = valid.map((t) => toTrack(t, source));
  await fillCovers(tracks);
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
