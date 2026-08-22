const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const videoId = 'dQw4w9WgXcQ';
const firstBase = 'https://first-piped.example';
const secondBase = 'https://second-piped.example';
const dom = new JSDOM(`<!doctype html><body>
  <div id="yt-player-wrap"><div id="yt-player"></div><div id="yt-placeholder"></div></div>
  <div id="yt-speed-bar"></div>
  <button id="yt-ronflix-toggle"></button>
</body>`, { url: 'https://studyplanner.example/app.html' });
const { window } = dom;
const iframe = window.document.getElementById('yt-player');
const calls = [];
const streamCalls = [];
const sourceAttempts = [];
let mode = 'candidate-retry';

window.ytDoLoad = function (type, id) {
  calls.push({ type, id });
  iframe.style.display = 'block';
};
window.ytCurrentVideoId = videoId;
window.ytCurrentVideoTitle = 'Test video';
window.ytPlayerReady = false;
window.ytPlayer = null;
window.YT = {};
window.ytBuildEmbedUrl = (type, id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
window.ytTurboGetState = () => ({ enabled: false });
window.ytSpeedCurrent = 1;
window.ytSetSpeed = () => {};
window.ytPiP = () => {};
window.showToast = () => {};
window.onPageActivated = (page, callback) => callback();
window.saveProgress = () => {};
window.creditVideoWatchTime = () => {};
window.ytResumeSeconds = () => 0;
window.ytUpdateVideoWatchLabel = () => {};
window.ytAutoMarkOnComplete = () => {};
window.ytAutoCueNext = false;
window.appState = {};
window.RonflixStream = {
  instances: [firstBase, secondBase],
  getVideoStream: async () => ({ url: 'https://media.example/video.mp4', title: 'Test video' }),
  getVideoStreams: async (_id, options) => {
    streamCalls.push({ mode, options });
    if (mode === 'candidate-retry') {
      return {
        source: firstBase,
        title: 'Test video',
        streams: [
          { url: 'https://media.example/broken.mp4', quality: '720p', format: 'MPEG_4', mimeType: 'video/mp4' },
          { url: 'https://media.example/working.mp4', quality: '360p', format: 'MPEG_4', mimeType: 'video/mp4' },
        ],
      };
    }
    if (streamCalls.filter((call) => call.mode === 'server-failover').length === 1) {
      return {
        source: firstBase,
        title: 'Test video',
        streams: [{ url: 'https://media.example/broken-again.mp4', quality: '720p', format: 'MPEG_4', mimeType: 'video/mp4' }],
      };
    }
    return {
      source: secondBase,
      title: 'Test video',
      streams: [{ url: 'https://media.example/working-after-failover.mp4', quality: '360p', format: 'MPEG_4', mimeType: 'video/mp4' }],
    };
  },
};
window.HTMLMediaElement.prototype.load = function () {
  if (!this.src) return;
  sourceAttempts.push(this.src);
  const event = this.src.includes('broken') ? new window.Event('error') : new window.Event('loadedmetadata');
  this.dispatchEvent(event);
};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

const context = vm.createContext({
  window,
  document: window.document,
  console,
  AbortController,
  DOMException,
  Date,
  Number,
  String,
  Math,
  setTimeout,
  clearTimeout,
});
Object.assign(context, window);
context.window = window;
vm.runInContext(fs.readFileSync('js/features/ronflix-player.js', 'utf8'), context);

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 75));
  const toggle = window.document.getElementById('yt-ronflix-toggle');
  assert.equal(typeof toggle.onclick, 'function', 'visible RonFlix button must have a click handler');

  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.ytRonflixGetState().active, true, 'a second muxed candidate must recover from a media error');
  assert.deepEqual(sourceAttempts.slice(0, 2), [
    'https://media.example/broken.mp4',
    'https://media.example/working.mp4',
  ]);
  assert.equal(streamCalls.length, 1, 'candidate retry should not refetch stream metadata');

  toggle.click();
  assert.equal(window.ytRonflixGetState().enabled, false);
  mode = 'server-failover';
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.ytRonflixGetState().active, true, 'a second Piped mirror must recover after all first-mirror media candidates fail');
  assert.equal(streamCalls.length, 3, 'server failover should perform two new stream metadata requests');
  assert.deepEqual(Array.from(streamCalls[2].options.excludeBases), [firstBase]);
  assert.equal(sourceAttempts.at(-2), 'https://media.example/broken-again.mp4');
  assert.equal(sourceAttempts.at(-1), 'https://media.example/working-after-failover.mp4');
  console.log('ronflix playback retry harness passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
