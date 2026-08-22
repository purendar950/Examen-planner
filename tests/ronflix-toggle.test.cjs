const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const videoId = 'dQw4w9WgXcQ';
const dom = new JSDOM(`<!doctype html><body>
  <div id="yt-player-wrap"><div id="yt-player"></div><div id="yt-placeholder"></div></div>
  <div id="yt-speed-bar"></div>
  <button id="yt-turbo-toggle"></button>
  <button id="yt-ronflix-toggle"></button>
</body>`, { url: 'https://studyplanner.example/app.html' });
const { window } = dom;
const calls = [];
let streamCalls = 0;

const iframe = window.document.getElementById('yt-player');
const originalLoad = function (type, id) {
  calls.push({ type, id });
  iframe.style.display = 'block';
};
window.ytDoLoad = originalLoad;
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
window.RonflixStream = {
  getVideoStream: async () => {
    streamCalls += 1;
    return { url: 'https://media.example/video.mp4', title: 'Test video' };
  },
};
window.showToast = () => {};
window.onPageActivated = (page, callback) => callback();
window.saveProgress = () => {};
window.creditVideoWatchTime = () => {};
window.ytResumeSeconds = () => 0;
window.ytUpdateVideoWatchLabel = () => {};
window.ytAutoMarkOnComplete = () => {};
window.ytAutoCueNext = false;
window.appState = {};
window.HTMLMediaElement.prototype.load = function () {
  this.dispatchEvent(new window.Event('loadedmetadata'));
};
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

const context = vm.createContext({
  window,
  document: window.document,
  console,
  AbortController,
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
  assert.equal(window.ytRonflixGetState().enabled, true);
  assert.equal(streamCalls, 1, 'enabling RonFlix must fetch the selected video from RonFlix');
  assert.equal(window.ytRonflixGetState().active, true, 'enabling RonFlix must activate native playback');
  assert.equal(toggle.textContent, '◈ RonFlix ON');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  const nativeVideo = window.document.getElementById('yt-ronflix-video');
  assert.ok(nativeVideo, 'Ronflix should create its native video element');
  assert.equal(nativeVideo.style.display, 'block');
  iframe.style.display = 'none';
  toggle.click();

  assert.equal(window.ytRonflixGetState().enabled, false);
  assert.equal(toggle.textContent, '◈ RonFlix');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(calls.at(-1), { type: 'video', id: videoId }, 'turning RonFlix off must call the normal loader');
  assert.equal(iframe.style.display, 'block', 'turning RonFlix off must restore the iframe surface');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const restoredIframe = iframe.querySelector('iframe');
  assert.ok(restoredIframe, 'normal mode must restore an iframe when the API player is not ready');
  assert.match(restoredIframe.src, new RegExp(videoId));

  // A playlist item is stored as playlist_<id>, but the IFrame API exposes the
  // actual video currently playing through getVideoData(). RonFlix must use
  // that video ID instead of rejecting the toggle as a non-video playlist ID.
  window.ytCurrentVideoId = 'playlist_PL123456789';
  window.ytCurrentVideoTitle = 'Playlist';
  window.ytPlayerReady = true;
  window.ytPlayer = {
    getVideoData: () => ({ video_id: videoId, title: 'Playlist item' }),
    pauseVideo: () => {},
  };
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(streamCalls, 2, 'a playlist item must be playable through RonFlix');
  assert.equal(window.ytRonflixGetState().active, true);
  assert.equal(toggle.textContent, '◈ RonFlix ON');

  toggle.click();
  assert.equal(toggle.textContent, '◈ RonFlix');
  assert.deepEqual(calls.at(-1), { type: 'video', id: videoId }, 'playlist item must return to the same normal video');
  console.log('ronflix toggle harness passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
