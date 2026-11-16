// GD音乐台 (music.gdstudio.xyz) 音源插件。
// 站点的 api.php 有 Cloudflare 指纹校验，普通 HTTP 客户端无法通过，
// 所以请求经由 bin/gd-helper（无头 Chrome/Edge）在站点页面上下文内发出，
// 签名直接用页面自己的 crc32，站点更新算法或版本号时无需改插件。
//
// 封面渐进加载：搜索约 1 秒即返回，封面 URL 指向 helper 的本地服务
// (http://127.0.0.1:<port>/cover)。App 自己并发去抓，helper 收到请求才去
// GD 解析封面（站点串行、较慢），解析出就 302 跳到 CDN——于是列表先出，
// 封面一张张补上。helper 内缓存解析结果，App 也按 URL 缓存，重复秒回。
//
// 喜欢和歌单都存在本机（host.storage）：GD 没有账号/写入接口，
// 所以收藏与歌单是设备本地的，换机不会同步。

const COUNT = 20;

// 音质 → GD 码率。离线缓存与播放共用。
const BR = { standard: 128, high: 320, lossless: 999 };

const urlEncode = (s) =>
  encodeURIComponent(s)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/!/g, "%21");

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

const load = (key, fallback) => host.storage.get(key) ?? fallback;
const save = (key, value) => host.storage.set(key, value);

let helper = null;
let nextId = 1;
const pending = new Map();
let helperBase = "";
let readyPromise = null;
let readyResolve = null;
let readyReject = null;

const helperPath = () =>
  host.platform === "win32" ? "bin/gd-helper.exe" : "bin/gd-helper";

function ensureHelper() {
  if (helper) return helper;
  let proc;
  try {
    proc = host.spawn(helperPath());
  } catch (e) {
    throw fail("setup", "请在设置中允许 GD音乐台 启动辅助程序（需要本机装有 Chrome 或 Edge）");
  }
  helper = proc;
  // 告知 helper 离线库目录（插件自己的 dataDir/offline），下载与供流都用它。
  try {
    proc.write(JSON.stringify({ id: nextId++, op: "config", dir: host.dataDir + "/offline" }) + "\n");
  } catch (e) {
    // 起不来时下面的读取循环会收拾。
  }
  readyPromise = new Promise((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  (async () => {
    for (;;) {
      const line = await proc.readLine();
      if (line === null) break;
      let r;
      try {
        r = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (r.port) {
        helperBase = `http://127.0.0.1:${r.port}`;
        if (readyResolve) {
          readyResolve(helperBase);
          readyResolve = null;
          readyReject = null;
        }
        continue;
      }
      const settle = pending.get(r.id);
      if (settle) {
        pending.delete(r.id);
        settle(r);
      }
    }
    if (helper === proc) helper = null;
    helperBase = "";
    if (readyReject) {
      readyReject(new Error("辅助程序已退出"));
      readyResolve = null;
      readyReject = null;
    }
    for (const settle of pending.values()) settle({ error: "辅助程序已退出" });
    pending.clear();
  })();
  return proc;
}

// 等 helper 起好、浏览器初始化完、本地服务端口就绪。
async function ready() {
  ensureHelper();
  if (!helperBase) await readyPromise;
  return helperBase;
}

// 给 helper 发一条请求并等它的回复（按 id 配对）。下载较慢，超时可调。
async function callHelper(payload, timeout = 25000) {
  await ready();
  const proc = helper;
  const id = nextId++;
  return await new Promise((resolve) => {
    pending.set(id, resolve);
    try {
      proc.write(JSON.stringify({ id, ...payload }) + "\n");
    } catch (e) {
      pending.delete(id);
      resolve({ error: String(e) });
      return;
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: "请求超时" });
      }
    }, timeout);
  });
}

async function api(query, sign) {
  const resp = await callHelper({ query, sign });
  if (resp.error) throw new Error("GD音乐台: " + resp.error);
  if (resp.status === 401) throw new Error("GD音乐台: 站点校验失败，请重试");
  if (resp.status !== 200) throw new Error("GD音乐台: 接口返回 " + resp.status);
  return JSON.parse(resp.body);
}

const encodeId = (parts) => parts.map((p) => encodeURIComponent(String(p == null ? "" : p))).join("|");
const decodeId = (id) => id.split("|").map(decodeURIComponent);

// 封面 URL 指向 helper 本地服务，App 抓它时才懒解析。
const coverURL = (base, source, picId) =>
  picId ? `${base}/cover?source=${encodeURIComponent(source)}&id=${encodeURIComponent(String(picId))}` : "";

const toTrack = (t, source, base) => {
  const ed = t.extra_data || {};
  const names = Array.isArray(t.artist) ? t.artist : String(t.artist || "").split(",");
  const ids = ed.artist_ids || [];
  const src = t.source || source;
  return {
    id: encodeId([src, t.url_id || t.id, t.pic_id || "", t.lyric_id || t.id]),
    name: String(t.name || ""),
    artists: names.map((n, i) => ({ id: String(ids[i] || n), name: String(n).trim() })),
    album: {
      id: String(ed.album_id || ""),
      name: String(t.album || ""),
      imageUrl: coverURL(base, src, t.pic_id),
    },
    duration: (parseInt(ed.duration, 10) || 0) * 1000,
    unavailable: ed.is_available === false,
  };
};

// 歌曲库：把搜索见过的歌存下来，喜欢/歌单只存 id，渲染时据此还原。
// addToPlaylist 只拿到 id，所以这里必须先记住歌曲元数据。
// 封面端口每次启动会变，所以只存 source/pic_id，渲染时按当前端口重建 URL。
function referenced() {
  const s = new Set(load("liked", []));
  for (const p of load("playlists", [])) for (const id of p.trackIds || []) s.add(id);
  for (const id of load("history", [])) s.add(id);
  for (const id of Object.keys(load("offline", {}))) s.add(id);
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

function songsByIds(base, ids) {
  const songs = load("songs", {});
  const out = [];
  for (const id of ids) {
    const rec = songs[id];
    if (!rec) continue;
    const t = { ...rec.t, album: { ...rec.t.album } };
    t.album.imageUrl = coverURL(base, rec.src, rec.pic);
    out.push(t);
  }
  return out;
}

// 渲染收藏/歌单时拿封面端口；helper 起不来就降级为无封面，列表照常显示。
async function coverBase() {
  try {
    return await ready();
  } catch (e) {
    return "";
  }
}

export async function search({ query, kind, offset }) {
  if (kind !== "tracks") throw fail("unsupported", "GD音乐台只支持搜索歌曲");
  const source = host.setting("source") || "netease";
  const base = await ready();
  const page = Math.floor((offset || 0) / COUNT) + 1;
  const enc = urlEncode(query);
  const items = await api(
    `types=search&count=${COUNT}&source=${source}&pages=${page}&name=${enc}`,
    enc
  );
  if (!Array.isArray(items)) return { tracks: [], more: false };
  const valid = items.filter((t) => t && t.id);
  const tracks = valid.map((t) => toTrack(t, source, base));
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
  // 离线优先：已缓存且音质不低于所求，就由 helper 本地供流，断网也能播。
  const rec = load("offline", {})[id];
  if (rec && (rec.br || 0) >= br) {
    try {
      const base = await ready();
      return { url: `${base}/audio?f=${encodeURIComponent(rec.name)}`, type: rec.ext, size: rec.size || 0 };
    } catch (e) {
      // helper 起不来就退回在线。
    }
  }
  const [source, urlId] = decodeId(id);
  const enc = urlEncode(String(urlId));
  const r = await api(`types=url&id=${enc}&source=${source}&br=${br}`, enc);
  if (!r || !r.url || r.url === "err") throw fail("unavailable", "这首歌暂时无法播放");
  return { url: r.url, type: extOf(r.url, r.br || br), size: r.size || 0 };
}

export async function lyrics({ id }) {
  const [source, , , lyricId] = decodeId(id);
  const enc = urlEncode(String(lyricId));
  const r = await api(`types=lyric&id=${enc}&source=${source}`, enc);
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
  const base = await coverBase();
  const ids = load("liked", []);
  const start = offset || 0;
  return {
    tracks: songsByIds(base, ids.slice(start, start + COUNT)),
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

const withTracks = (p, base) => ({
  ...p,
  tracks: songsByIds(base, p.trackIds || []),
  trackCount: (p.trackIds || []).length,
});

// 歌单封面用第一首歌的封面（懒加载 URL），App 各处以异步封面显示。
const playlistCover = (base, p) => {
  const first = songsByIds(base, (p.trackIds || []).slice(0, 1))[0];
  return first ? first.album.imageUrl : "";
};

// 侧栏列表：拿封面端口（helper 随之预热），封面 URL 交给 App 渐进加载。
export async function playlists() {
  const base = await coverBase();
  return playlistsNow().map((p) => ({
    id: p.id,
    name: p.name,
    mine: true,
    trackCount: (p.trackIds || []).length,
    imageUrl: playlistCover(base, p),
  }));
}

export async function playlist({ id }) {
  const p = playlistsNow().find((p) => p.id === id);
  if (!p) throw fail("unavailable", "歌单不存在");
  const base = await coverBase();
  return { ...withTracks(p, base), imageUrl: playlistCover(base, p) };
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
  let added = [];
  changePlaylist(id, (p) => {
    const have = new Set(p.trackIds || []);
    // 查重：已在歌单里的、以及本批内重复的，都不重复添加。
    const add = [];
    for (const t of trackIds || []) {
      if (!have.has(t)) {
        have.add(t);
        add.push(t);
      }
    }
    p.trackIds = [...(p.trackIds || []), ...add];
    added = add;
  });
  // 加入歌单即后台离线缓存（可在设置关闭）。不阻塞添加本身。
  if (autoOffline()) for (const t of added) cacheSong(t);
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

// 听歌历史（本机）：App 每次开始播放回调 played({id})，把它记到最前、
// 去掉旧的重复，最多留 HISTORY_MAX 条。recent 供 Home"最近播放"，
// browse 的 history 页供侧栏"听歌历史"。歌曲元数据复用搜索记下的歌曲库。
const HISTORY_MAX = 300;

export function played({ id }) {
  const ids = load("history", []).filter((x) => x !== id);
  ids.unshift(id);
  save("history", ids.slice(0, HISTORY_MAX));
}

export async function recent() {
  const base = await coverBase();
  return songsByIds(base, load("history", []).slice(0, COUNT));
}

export async function browse({ page }) {
  maybeClearOffline();
  const base = await coverBase();
  if (page === "history") {
    const ids = load("history", []);
    return {
      title: "听歌历史",
      subtitle: ids.length ? `${ids.length} 首` : "",
      sections: [{ tracks: songsByIds(base, ids), empty: "还没有播放记录，去搜首歌听听吧" }],
    };
  }
  if (page === "offline") {
    const off = load("offline", {});
    const ids = Object.keys(off);
    let bytes = 0;
    for (const id of ids) bytes += off[id].size || 0;
    const size = bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
    return {
      title: "离线缓存",
      subtitle: ids.length ? `${ids.length} 首 · ${size}` : "",
      sections: [{
        tracks: songsByIds(base, ids),
        empty: "还没有离线缓存的歌。把歌加入歌单就会自动缓存到本机（可在插件设置关闭）。",
      }],
    };
  }
  throw fail("unavailable", "没有这个页面");
}

// 离线缓存（本机）：加入歌单时后台把歌下载到插件自有目录，断网时由 helper
// 本地供流播放。只存 id → 文件信息，歌曲元数据复用搜索记下的歌曲库。
const autoOffline = () => host.setting("autoOffline") !== "false";
const offlineQuality = () => host.setting("offlineQuality") || "high";

// 清空离线缓存：开关打开后，下次进浏览页清一次（删文件 + 清记录）。
// 插件改不了设置值，所以用边沿检测——再清需先把开关关掉再打开。
function maybeClearOffline() {
  const want = host.setting("clearOffline") === "true";
  const seen = load("offlineCleared", false);
  if (want && !seen) {
    try {
      host.removeDataDir("offline");
    } catch (e) {
      console.error("clear offline:", e);
    }
    save("offline", {});
    save("offlineCleared", true);
  } else if (!want && seen) {
    save("offlineCleared", false);
  }
}

async function cacheSong(id) {
  try {
    const off = load("offline", {});
    const br = BR[offlineQuality()] || 320;
    const rec = off[id];
    if (rec && (rec.br || 0) >= br) return; // 查重：已有不低于此音质的缓存
    const [source, urlId] = decodeId(id);
    const enc = urlEncode(String(urlId));
    const r = await api(`types=url&id=${enc}&source=${source}&br=${br}`, enc);
    if (!r || !r.url || r.url === "err") return;
    const ext = extOf(r.url, r.br || br);
    const name = host.crypto.md5(id) + "." + ext;
    const resp = await callHelper({ op: "dl", url: r.url, name }, 180000);
    if (resp.error || resp.status !== 200) return;
    const got = JSON.parse(resp.body);
    const now = load("offline", {});
    now[id] = { name, ext, size: got.size || 0, br: parseInt(r.br, 10) || br, ts: Date.now() };
    save("offline", now);
  } catch (e) {
    console.error("offline cache:", e);
  }
}