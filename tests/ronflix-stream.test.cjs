const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/features/ronflix-stream.js'), 'utf8');
const firstBase = 'https://api.piped.private.coffee';
const secondBase = 'https://pipedapi.kavin.rocks';
const videoId = 'dQw4w9WgXcQ';
const requests = [];
const storage = new Map();
let call = 0;

const context = {
  console,
  Promise,
  URLSearchParams,
  AbortController,
  DOMException,
  setTimeout,
  clearTimeout,
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  fetch: async (url) => {
    requests.push(url);
    call += 1;
    if (call === 1) throw new Error('first mirror unavailable');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          title: 'Test video',
          videoStreams: [
            { quality: '1080p', videoOnly: true, url: 'https://video-only.example/1080' },
            { quality: '720p', videoOnly: false, url: 'https://googlevideo.example/720' },
            { quality: '360p', videoOnly: false, url: 'https://googlevideo.example/360' },
          ],
        };
      },
    };
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context);

(async () => {
  const result = await context.window.RonflixStream.getVideoStream(videoId, { timeoutMs: 1000 });
  assert.equal(result.url, 'https://googlevideo.example/720');
  assert.equal(result.title, 'Test video');
  assert.equal(requests[0], `${firstBase}/streams/${videoId}`);
  assert.equal(requests[1], `${secondBase}/streams/${videoId}`);
  assert.equal(storage.get('ronflix_youtube_piped_base_v1'), secondBase);

  const noMuxed = context.window.RonflixStream.pickBestStream({
    videoStreams: [{ quality: '1080p', videoOnly: true, url: 'https://video-only.example/1080' }],
  });
  assert.equal(noMuxed, null, 'video-only DASH entries must not be assigned to a plain video element');

  const browserCompatible = context.window.RonflixStream.pickBestStream({
    videoStreams: [
      { quality: '1080p', format: 'WEBM', mimeType: 'video/webm', codec: 'vp9', videoOnly: false, url: 'https://proxy.example/1080.webm' },
      { quality: '720p', format: 'MPEG_4', mimeType: 'video/mp4', codec: 'avc1.64001f', videoOnly: false, url: 'https://proxy.example/720.mp4' },
      { quality: '1440p', format: 'HLS', mimeType: 'application/x-mpegurl', videoOnly: false, url: 'https://proxy.example/master.m3u8' },
    ],
  });
  assert.equal(browserCompatible.url, 'https://proxy.example/720.mp4', 'native playback should prefer muxed MP4/H.264 over higher WebM/HLS entries');

  const page = fs.readFileSync('pages/yt-search.html', 'utf8');
  const search = fs.readFileSync('js/tabs/yt-search.js', 'utf8');
  const app = fs.readFileSync('app.html', 'utf8');
  const player = fs.readFileSync('js/features/ronflix-player.js', 'utf8');
  assert.match(page, /id="ytSearchRonflixVideo"/);
  assert.match(page, /Search and playback use the RonFlix server/);
  assert.doesNotMatch(page, /youtubeApiSetup|youtubeApiKey|data-yt-search-mode|id="youtubePlayer"/);
  assert.match(search, /window\.RonflixStream\.request/);
  assert.match(search, /startSearchRonflix\(id,title\)/);
  assert.doesNotMatch(search, /youtubeApi|YOUTUBE_API|youtube\.com\/embed|youtubeApiSetup/);
  assert.match(app, /js\/features\/ronflix-stream\.js/);
  assert.match(app, /js\/features\/ronflix-player\.js/);
  assert.ok(app.indexOf('js/features/ronflix-stream.js') < app.indexOf('js/tabs/yt-search.js'), 'shared client must load before YT Search');
  assert.ok(app.indexOf('js/features/turbo-player.js') < app.indexOf('js/features/ronflix-player.js'), 'main Ronflix wrapper must load after Turbo');
  assert.match(player, /ytToggleRonflix/);
  assert.match(player, /ytTurboGetState/);
  assert.match(player, /ronflixPreviousLoad/);
  console.log('ronflix stream harness passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
