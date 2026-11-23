import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const json = (value, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const song = (id, pic = '') => ({ id, name: 'Song ' + id, artist: ['Artist'], album: 'Album', pic_id: pic });
const trackID = (id, pic = '') => `netease|${id}|${pic}|${id}`;

async function fixture(respond, initial = {}) {
  let clock = 1000000;
  let sequence = 0;
  const timers = new Map();
  const storage = new Map(Object.entries(structuredClone(initial)));
  const calls = [];
  let selectedSource = 'netease';
  let service = '';
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({
    Date: Clock, AbortController, console, URL,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    host: {
      setting: key => key === 'service' ? service : selectedSource,
      storage: {
        get: key => structuredClone(storage.get(key)),
        set: (key, value) => storage.set(key, structuredClone(value)),
      },
    },
    fetch: async (url, options) => {
      const params = Object.fromEntries(new URL(url).searchParams);
      calls.push(params);
      return respond(params, options, new URL(url));
    },
  });
  const mod = new vm.SourceTextModule(source + '\nexport { siteDigest, siteSignature };', { context });
  await mod.link(() => { throw new Error('Unexpected dependency'); });
  await mod.evaluate();
  async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
  return {
    plugin: mod.namespace, calls, storage,
    source(value) { selectedSource = value; },
    service(value) { service = value; },
    async advance(milliseconds) {
      await flush();
      const target = clock + milliseconds;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        clock = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      clock = target;
      await flush();
    },
  };
}

const search = (f, query = 'song', offset = 0) => f.plugin.search({ query, kind: 'tracks', offset });

// Parallel searches and shared album artwork used to send the same requests repeatedly.
test('coalesces concurrent search and cover requests and caches the search page', async () => {
  const f = await fixture(p => json(p.types === 'search' ? Array.from({length:20}, (_,i) => song(String(i), 'shared')) : { url:'https://example.test/cover.jpg' }));
  const [a, b] = await Promise.all([search(f), search(f)]);
  assert.equal(f.calls.length, 2);
  assert.equal(a.tracks.length, 20);
  assert.ok(b.tracks.every(t => t.album.imageUrl === 'https://example.test/cover.jpg'));
  await search(f);
  assert.equal(f.calls.length, 2);
  await f.advance(120001);
  await search(f);
  assert.equal(f.calls.filter(c => c.types === 'search').length, 2);
});

// A cover that stalled used to hold a search past the advertised budget and host timeout.
test('aborts a stalled cover within the whole-list budget and backs off', async () => {
  let aborted = 0;
  const f = await fixture((p, {signal}) => {
    if (p.types === 'search') return json([song('1', 'pic')]);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }));
  });
  const pending = search(f);
  await f.advance(2500);
  assert.equal((await pending).tracks[0].album.imageUrl, '');
  assert.equal(aborted, 1);
  await search(f);
  assert.equal(f.calls.length, 2);
});

// The cover deadline must include response-body parsing, not only receipt of HTTP headers.
test('aborts a stalled JSON body', async () => {
  const f = await fixture((p, {signal}) => {
    if (p.types === 'search') return json([song('1','pic')]);
    return { ...json(null), json: () => new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
  });
  const pending = search(f);
  await f.advance(2500);
  assert.equal((await pending).tracks.length, 1);
});

// Missing covers in local lists used to have no opportunity to recover after search failed.
test('recovers missing artwork in liked, playlist, history and recent pages', async () => {
  for (const page of ['liked','playlist','browse','recent','playlists']) {
    const id = trackID('1','pic');
    const f = await fixture(() => json({url:'https://example.test/recovered.jpg'}), {
      songs:{[id]:{t:{id,name:'Song',artists:[],album:{name:'Album'},duration:320},src:'netease',pic:'pic'}},
      durations:{[id]:320},liked:[id],history:[id],playlists:[{id:'p',name:'List',trackIds:[id]}],
    });
    const result = await f.plugin[page]({offset:0,id:'p',page:'history'});
    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes('https://example.test/recovered.jpg'), page);
    assert.ok(!serialized.includes('"duration":320'), page);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.storage.get('liked'), [id]);
  }
});

// An old cover is usable while refreshing, and expiry must not trigger a request for every row.
test('refreshes legacy and expired artwork while retaining the URL on temporary failure', async () => {
  let requests = 0;
  const f = await fixture(p => {
    if (p.types === 'search') return json([song('1','pic')]);
    requests++;
    if (requests === 2) return json({}, 503);
    return json({url:`https://example.test/${requests}.jpg`});
  }, {covers:{'netease:pic':'https://example.test/legacy.jpg'}});
  assert.equal((await search(f)).tracks[0].album.imageUrl,'https://example.test/1.jpg');
  await f.advance(86400001);
  assert.equal((await search(f)).tracks[0].album.imageUrl,'https://example.test/1.jpg');
  await search(f);
  assert.equal(requests,2);
  await f.advance(60001);
  assert.equal((await search(f)).tracks[0].album.imageUrl,'https://example.test/3.jpg');
});

// Only an empty successful cover response should try a second size; HTTP failures consume one request.
test('falls back to 300 only for an empty successful cover response', async () => {
  const f = await fixture(p => json(p.types === 'search' ? [song('1','pic')] : p.size === '500' ? {} : {url:'https://example.test/small.jpg'}));
  assert.equal((await search(f)).tracks[0].album.imageUrl, 'https://example.test/small.jpg');
  assert.deepEqual(f.calls.filter(p=>p.types==='pic').map(p=>p.size), ['500','300']);
});

// The server can raise its quota, so the local budget must leave playback eligible beyond 50 requests.
test('limits auxiliary requests while allowing playback beyond 50 and after reload', async () => {
  const respond = p => json(p.types === 'search' ? Array.from({length:20},(_,i)=>song(p.name+i,p.name+i)) : p.types === 'pic' ? {url:'https://example.test/cover.jpg'} : {url:'https://example.test/song.mp3',br:320});
  const f = await fixture(respond);
  await search(f,'a');
  await search(f,'b');
  assert.equal(f.calls.length, 35);
  for(let i=0;i<10;i++) await search(f,'q'+i);
  await assert.rejects(search(f,'over'), /请求额度/);
  for(let i=0;i<5;i++) await f.plugin.stream({id:trackID('s'+i),quality:'high'});
  assert.equal(f.calls.length,50);
  await f.plugin.stream({id:trackID('over'),quality:'high'});
  assert.equal(f.calls.length,51);
  const reloaded = await fixture(respond,Object.fromEntries(f.storage));
  await assert.rejects(search(reloaded,'still-limited'), /请求额度/);
  await reloaded.plugin.stream({id:trackID('reload'),quality:'high'});
  assert.equal(reloaded.calls.length,1);
  await f.advance(300001);
  await search(f,'after');
  assert.equal(f.calls.filter(p=>p.types==='search').length,13);
});

// A 429 with Retry-After must stop other calls and remain actionable without waiting for the host timeout.
test('honors Retry-After and resumes after its deadline', async () => {
  let count=0;
  const f = await fixture(() => ++count===1 ? json({},429,{'Retry-After':'90'}) : json([]));
  await assert.rejects(search(f),/HTTP 429.*90 秒/);
  await assert.rejects(search(f,'second'),/HTTP 429/);
  await assert.rejects(f.plugin.stream({id:trackID('playing'),quality:'high'}),/HTTP 429/);
  assert.equal(f.calls.length,1);
  await f.advance(90001);
  await search(f);
  assert.equal(f.calls.length,2);
});

// A 403 can have multiple causes; its actual status remains visible and all cover retries pause.
test('backs off on 403 without classifying it as confirmed rate limiting', async () => {
  const f = await fixture(p => p.types==='search' ? json([song('1','pic')]) : json({},403));
  assert.equal((await search(f)).tracks.length,1);
  await assert.rejects(f.plugin.stream({id:trackID('1','pic'),quality:'high'}),/HTTP 403.*可能/);
  assert.equal(f.calls.length,2);
});

// A successful HTTP response with an error object must not masquerade as an empty search result.
test('reports malformed search results and retries them on the next request', async () => {
  let count=0;
  const f=await fixture(()=>json(++count===1?{error:'unavailable'}:[]));
  await assert.rejects(search(f),/异常的搜索结果/);
  assert.equal((await search(f)).tracks.length,0);
  assert.equal(f.calls.length,2);
});

// Real metadata is preserved, while unknown size units and quality codes no longer create fake durations.
test('uses explicit metadata, actual quality and byte sizes without estimating duration', async () => {
  const f=await fixture(p=>json(p.types==='search'
    ? [song('1'), {...song('2'),extra_data:{duration:180,album_id:'album',artist_ids:['artist'],is_available:false}}]
    : {url:'https://example.test/song.flac',br:740,size:40000}));
  const result=await search(f);
  assert.equal(result.tracks[0].duration,0);
  assert.equal(result.tracks[1].duration,180000);
  assert.equal(result.tracks[1].album.id,'album');
  assert.equal(result.tracks[1].artists[0].id,'artist');
  assert.equal(result.tracks[1].unavailable,true);
  const stream=await f.plugin.stream({id:trackID('1'),quality:'lossless'});
  assert.equal(stream.size,0);
  assert.equal(stream.quality,'lossless');
  assert.equal(f.storage.has('durations'),false);
  const bytes=await fixture(()=>json({url:'https://example.test/song.mp3',br:128,size_bytes:12345}));
  assert.equal((await bytes.plugin.stream({id:trackID('1')})).size,12345);
});

// Search cache keys must include source and page so switching sources does not reuse unrelated tracks.
test('keeps cached sources and pages separate',async()=>{
  const f=await fixture(p=>json([song(p.source+p.pages)]));
  assert.equal((await search(f)).tracks[0].name,'Song netease1');
  assert.equal((await search(f,'song',20)).tracks[0].name,'Song netease2');
  f.source('joox');
  assert.equal((await search(f)).tracks[0].name,'Song joox1');
  assert.equal(f.calls.length,3);
});

// Website hash vectors include padding boundaries and multi-block requests.
test('matches the website checksum across digest block boundaries', async () => {
  const f = await fixture(() => json([]));
  for (const [length, expected] of [
    [0, 'a7dbeeca588aa82afb4799ae898842ad'],
    [1, '92308d9b11a169f989f787c507afef6a'],
    [55, 'ce9d64b93922b6c96372c47a3e6c3f05'],
    [56, '339dca43f52297d05e559229d04109a3'],
    [64, 'f7d0abd14bf991d63dac807850796834'],
    [100, 'c18607ad0b16d35992e0f24f89d580d4'],
  ]) assert.equal(f.plugin.siteDigest('a'.repeat(length)), expected);
});

// Changing service must preserve song identity while using that service's metadata and artwork.
test('switches all API operations and isolates line caches while retaining user data', async () => {
  const endpoints = [];
  const f = await fixture((p, options, url) => {
    endpoints.push(url);
    if (url.pathname === '/js/player.js') return json('var mkPlayer={version:"2026.11.22"}');
    if (url.pathname === '/time') return json('1795430000');
    if (p.types === 'search') return json([song('1', 'pic')]);
    if (p.types === 'pic') return json({url:`https://${url.hostname}/cover.jpg`});
    if (p.types === 'lyric') return json({lyric:'line',tlyric:'translation'});
    return json({url:'cache/song.flac',br:999});
  });
  const original = (await search(f)).tracks[0];
  f.plugin.like({id:original.id,on:true});
  const playlist = f.plugin.createPlaylist({name:'Keep'});
  f.plugin.addToPlaylist({id:playlist.id,trackIds:[original.id]});
  for (const [line, domain] of [['domestic','music.gdstudio.org'],['international','music.gdstudio.xyz']]) {
    f.service(line);
    const current = (await search(f, "晴天!'()*")).tracks[0];
    assert.equal(current.id, original.id);
    assert.equal(current.album.imageUrl, `https://${domain}/cover.jpg`);
    const request = endpoints.filter(u=>u.hostname===domain && u.searchParams.get('types')==='search').at(-1);
    const encoded = encodeURIComponent("晴天!'()*").replace(/[!'()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
    assert.equal(request.searchParams.get('s'), f.plugin.siteSignature(encoded,domain,'2026.11.22',1795430000));
    assert.equal((await f.plugin.stream({id:original.id})).url, `https://${domain}/cache/song.flac`);
    assert.equal((await f.plugin.lyrics({id:original.id})).lrc, 'line');
    assert.equal((await f.plugin.liked({offset:0})).tracks[0].id,original.id);
    assert.equal((await f.plugin.playlist({id:playlist.id})).tracks[0].album.imageUrl,`https://${domain}/cover.jpg`);
  }
  const before = endpoints.length;
  f.service('');
  assert.equal((await search(f)).tracks[0].album.imageUrl,'https://music-api.gdstudio.xyz/cover.jpg');
  assert.equal(endpoints.length,before);
});

// Version or server clock changes recover once, and a persistent rejection has a bounded retry.
test('refreshes website metadata once on 401 and surfaces persistent rejection', async () => {
  let requests = 0;
  let revisions = 0;
  const f = await fixture((p, options, url) => {
    if (url.pathname === '/js/player.js') return json(`var mkPlayer={version:"2026.11.${22 + revisions++}"}`);
    if (url.pathname === '/time') return json('1795430000');
    return json(++requests === 2 ? [] : {}, requests === 2 ? 200 : 401);
  });
  f.service('domestic');
  await search(f);
  assert.equal(requests,2);
  assert.equal(revisions,2);
  await assert.rejects(search(f,'again'),/网页校验失败/);
  assert.equal(requests,4);
  assert.equal(revisions,3);
});

// A service switch during a slow search must not move its cover requests to the other host.
test('pins in-flight results and artwork to their initiating service', async () => {
  let release;
  const endpoints = [];
  const f = await fixture((p, options, url) => {
    endpoints.push(url);
    if (url.pathname === '/js/player.js') return json('var mkPlayer={version:"2026.11.22"}');
    if (url.pathname === '/time') return json('1795430000');
    if (p.types === 'search') return new Promise(resolve => { release=()=>resolve(json([song('1','pic')])); });
    return json({url:`https://${url.hostname}/cover.jpg`});
  });
  f.service('domestic');
  const pending = search(f);
  await f.advance(0);
  f.service('international');
  release();
  assert.equal((await pending).tracks[0].album.imageUrl,'https://music.gdstudio.org/cover.jpg');
  assert.ok(endpoints.every(u=>u.hostname==='music.gdstudio.org'));
});

// Webpage setup is part of the request deadline and failed setup can be attempted again.
test('bounds website initialization and keeps explicit service choices', async () => {
  const f = await fixture((p,{signal}) => new Promise((resolve,reject) => {
    signal.addEventListener('abort',()=>reject(new Error('aborted')));
  }));
  f.service('domestic');
  const pending = assert.rejects(search(f),/请求超时/);
  await f.advance(15000);
  await pending;
  assert.equal(f.calls.length,2);
  f.service('unknown');
  await assert.rejects(search(f),/服务线路/);
  assert.equal(f.calls.length,2);
});

// Switching endpoints must honor the shared server cooldown rather than multiply refused requests.
test('retains server backoff across service switches', async () => {
  const f=await fixture(()=>json({},429,{'Retry-After':'120'}));
  await assert.rejects(search(f),/HTTP 429/);
  f.service('domestic');
  await assert.rejects(search(f),/HTTP 429/);
  assert.equal(f.calls.length,1);
});
