// GD音乐台 音源插件（纯 JS，无辅助程序）。
// 走 GD Studio 官方开发者 API：https://music-api.gdstudio.xyz/api.php
// 纯 HTTP GET、无签名、无需浏览器。出处：GD音乐台 (music.gdstudio.xyz)。
// 该 API 限频 5 分钟 50 次，故所有请求经令牌桶节流，封面解析结果持久缓存。
//
// 喜欢、歌单、历史都存在本机（host.storage）：GD 无账号/写入接口，换机不同步。
// 离线播放交给 App 自身的歌曲缓存与下载管理器，插件不再自有离线层。

const API = "https://music-api.gdstudio.xyz/api.php";
const COUNT = 20;

// 音质 → API 码率（128/192/320/740/999；999 为 24bit 无损）。
const BR = { standard: 128, high: 320, lossless: 999 };

// 开发者 API 限频：5 分钟 50 次。
const RATE_MAX = 50;
const RATE_WINDOW = 300000;
let stamps = [];

async function slot() {
  for (;;) {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < RATE_WINDOW);
    if (stamps.length < RATE_MAX) {
      stamps.push(now);
      return;
    }
    const wait = RATE_WINDOW - (now - stamps[0]) + 50;
    await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
  }
}

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

const load = (key, fallback) => host.storage.get(key) ?? fallback;
const save = (key, value) => host.storage.set(key, value);

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

async function api(params) {
  await slot();
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join("&");
  const r = await fetch(`${API}?${qs}`);
  if (!r.ok) throw new Error("GD音乐台: 接口返回 " + r.status);
  return await r.json();
}

const encodeId = (parts) => parts.map((p) => enc(p)).join("|");
const decodeId = (id) => id.split("|").map(decodeURIComponent);

// 封面：pic_id → CDN 地址，持久缓存，避免重复消耗限频额度。
const coverCache = () => load("covers", {});

async function resolveCover(source, picId) {
  const key = source + ":" + picId;
  const cache = coverCache();
  if (cache[key]) return cache[key];
  const r = await api({ types: "pic", source, id: picId, size: 500 });
  const u = (r && r.url) || "";
  if (u) {
    const c = coverCache();
    c[key] = u;
    save("covers", c);
  }
  return u;
}

const toTrack = (t, source) => {
  const names = Array.isArray(t.artist) ? t.artist : String(t.artist || "").split(",");
  const src = t.source || source;
  return {
    id: encodeId([src, t.id, t.pic_id || "", t.lyric_id || t.id]),
    name: String(t.name || ""),
    artists: names.map((n) => ({ id: String(n), name: String(n).trim() })),
    album: { id: "", name: String(t.album || ""), imageUrl: "" },
    // 开发者 API 的搜索不返回时长，行内时长暂显未知。
    duration: 0,
    unavailable: false,
  };
};

// 搜索先回列表；封面用缓存即时填，未缓存的并发解析、限时补齐，
// 超时未解出的留空（App 显示默认封面），下次渲染再补。
async function fillCovers(tracks, raw, source) {
  const cache = coverCache();
  const todo = [];
  tracks.forEach((tr, i) => {
    const src = raw[i].source || source;
    const pic = raw[i].pic_id;
    tr.album.imageUrl = (pic && cache[src + ":" + pic]) || "";
    if (pic && !tr.album.imageUrl) todo.push({ tr, src, pic });
  });
  if (!todo.length) return;
  const deadline = Date.now() + 3000;
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length && Date.now() < deadline) {
      const { tr, src, pic } = todo[idx++];
      try {
        const u = await resolveCover(src, pic);
        if (u) tr.album.imageUrl = u;
      } catch (e) {
        // 封面失败不影响列表。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
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
    songs[t.id] = { t, src, pic: picId };
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
  const out = [];
  for (const id of ids) {
    const rec = songs[id];
    if (!rec) continue;
    const t = { ...rec.t, album: { ...rec.t.album } };
    t.album.imageUrl = (rec.pic && cache[rec.src + ":" + rec.pic]) || "";
    out.push(t);
  }
  return out;
}

export async function search({ query, kind, offset }) {
  if (kind !== "tracks") throw fail("unsupported", "GD音乐台只支持搜索歌曲");
  const source = host.setting("source") || "netease";
  const page = Math.floor((offset || 0) / COUNT) + 1;
  const items = await api({ types: "search", source, name: query, count: COUNT, pages: page });
  if (!Array.isArray(items)) return { tracks: [], more: false };
  const valid = items.filter((t) => t && t.id);
  const tracks = valid.map((t) => toTrack(t, source));
  await fillCovers(tracks, valid, source);
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
  return { url: r.url, type: extOf(r.url, r.br || br), size: r.size || 0 };
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
    tracks: songsByIds(ids.slice(start, start + COUNT)),
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

const withTracks = (p) => ({
  ...p,
  tracks: songsByIds(p.trackIds || []),
  trackCount: (p.trackIds || []).length,
});

const playlistCover = (p) => {
  const first = songsByIds((p.trackIds || []).slice(0, 1))[0];
  return first ? first.album.imageUrl : "";
};

export async function playlists() {
  return playlistsNow().map((p) => ({
    id: p.id,
    name: p.name,
    mine: true,
    trackCount: (p.trackIds || []).length,
    imageUrl: playlistCover(p),
  }));
}

export async function playlist({ id }) {
  const p = playlistsNow().find((p) => p.id === id);
  if (!p) throw fail("unavailable", "歌单不存在");
  return { ...withTracks(p), imageUrl: playlistCover(p) };
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
  return songsByIds(load("history", []).slice(0, COUNT));
}

export async function browse({ page }) {
  if (page === "history") {
    const ids = load("history", []);
    return {
      title: "听歌历史",
      subtitle: ids.length ? `${ids.length} 首` : "",
      sections: [{ tracks: songsByIds(ids), empty: "还没有播放记录，去搜首歌听听吧" }],
    };
  }
  throw fail("unavailable", "没有这个页面");
}