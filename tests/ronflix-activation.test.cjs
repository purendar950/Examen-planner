const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><body>
  <div id="yt-player-wrap"><div id="yt-player"></div><div id="yt-placeholder"></div><div id="yt-tap-resume" style="display:none"></div></div>
  <div class="yt-speed-bar" id="yt-speed-bar"></div>
</body>`, { url: 'https://example.app/app.html' });
const { window } = dom;
const doc = window.document;

window.ytCurrentVideoId = null;
window.ytCurrentVideoTitle = null;
window.ytPlayer = null;
window.ytPlayerReady = false;
window.ytDoLoad = function(){};
window.ytTurboGetState = () => ({ enabled: false });
window.ytToggleTurbo = () => {};
window.ytResumeSeconds = () => 0;
window.ytSpeedCurrent = 1;
window.ytSetSpeed = () => {};
window.ytPiP = () => {};
window.showToast = () => {};
window.saveProgress = () => {};
window.creditVideoWatchTime = () => {};
window.ytUpdateVideoWatchLabel = () => {};
window.ytAutoMarkOnComplete = () => {};
window.appState = {};
window.HTMLMediaElement.prototype.load = function(){ this.dispatchEvent(new window.Event('loadedmetadata')); };
window.HTMLMediaElement.prototype.pause = function(){};
window.HTMLMediaElement.prototype.play = function(){ return Promise.resolve(); };

let streamCalls = 0;
window.RonflixStream = {
  getAllVideoStreams: async () => { streamCalls++; return { streams: [{ url: 'https://media.test/v.mp4', quality: '720p' }], title: 'V' }; },
};

const ctx = vm.createContext(window);
vm.runInContext(fs.readFileSync('js/features/ronflix-player.js', 'utf8'), ctx);

(async () => {
  // initUi runs immediately via the boot polling timer
  await new Promise(r => setTimeout(r, 700));
  const btn = doc.getElementById('yt-ronflix-toggle');
  assert.ok(btn, 'RonFlix button must be created by the self-contained boot');
  assert.equal(typeof btn.onclick, 'function', 'RonFlix button must be clickable');
  // No video loaded yet -> disabled "(load video)" state
  assert.equal(btn.textContent, '◈ RonFlix (load video)', 'button must show load-video prompt when no video');
  assert.equal(btn.disabled, true, 'button must be disabled with no video');

  // Click with no video: should NOT enable, should remember intent
  btn.click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(window.ytRonflixGetState().enabled, false, 'clicking without a video must not enable');
  assert.equal(streamCalls, 0, 'no stream fetch until a video is available');

  // Now a video loads
  window.ytCurrentVideoId = 'dQw4w9WgXcQ';
  // wait for the 1s watcher to auto-enable
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(window.ytRonflixGetState().enabled, true, 'RonFlix must auto-enable once a video loads');
  assert.equal(streamCalls, 1, 'auto-enable must fetch the stream');
  const video = doc.getElementById('yt-ronflix-video');
  assert.ok(video && video.style.display === 'block', 'native video must be shown after auto-enable');
  console.log('ronflix activation harness passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
