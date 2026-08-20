import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/core/persistence.js', import.meta.url), 'utf8');
const start = source.indexOf('function _firestoreSafeFocusMarks');
const end = source.indexOf('async function saveProgressNow', start);
assert.ok(start >= 0 && end > start, 'persistence sanitizers should remain available');

const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.safeAppState = _firestoreSafeAppState;`, context);

const state = {
  ytoLibrary: {
    playlistA: {
      id: 'playlistA',
      thumb: 'https://img.example/course.jpg',
      videos: [
        { id: 'video-1', title: 'One', thumb: 'https://img.example/video-1.jpg', dur: 60 },
        { id: 'video-2', title: 'Two', thumb: 'https://img.example/video-2.jpg', dur: 120 }
      ]
    }
  },
  focusMarks: {
    'playlistA:video-1': {
      strokes: [{ points: [[1, 2], [3, 4]] }]
    }
  },
  activePage: 'yt-organiser'
};

const sanitized = context.safeAppState(state);

assert.equal(sanitized.ytoLibrary.playlistA.thumb, state.ytoLibrary.playlistA.thumb);
assert.equal('thumb' in sanitized.ytoLibrary.playlistA.videos[0], false);
assert.equal('thumb' in sanitized.ytoLibrary.playlistA.videos[1], false);
assert.equal(
  JSON.stringify(sanitized.ytoLibrary.playlistA.videos.map((video) => video.id)),
  JSON.stringify(['video-1', 'video-2'])
);
assert.equal(
  JSON.stringify(sanitized.focusMarks['playlistA:video-1'].strokes[0].points),
  JSON.stringify([{ x: 1, y: 2 }, { x: 3, y: 4 }])
);
assert.equal('thumb' in state.ytoLibrary.playlistA.videos[0], true, 'local state remains rich and editable');
assert.deepEqual(state.focusMarks['playlistA:video-1'].strokes[0].points, [[1, 2], [3, 4]]);

console.log('Library sync regression checks passed');
