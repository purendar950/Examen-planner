/*
   RONFLIX STREAM CLIENT
   Shared Piped-compatible client for the RonFlix playback mode in both the
   YT Search tab and the main YouTube study player. The public RonFlix site is
   a frontend; its archived YouTube player uses Piped's /streams/:id response,
   so this module keeps that contract in one place.
*/
(function () {
  'use strict';

  var STORAGE_KEY = 'ronflix_youtube_piped_base_v1';
  var INSTANCES = [
    'https://api.piped.private.coffee',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.ducks.party',
    'https://pipedapi.leptons.xyz'
  ];
  var base = '';
  try { base = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}

  function orderedBases() {
    var list = INSTANCES.slice();
    if (base && list.indexOf(base) >= 0) {
      list.sort(function (a, b) { return a === base ? -1 : (b === base ? 1 : 0); });
    }
    return list;
  }

  function withQuery(path, params) {
    var query = new URLSearchParams(params || {}).toString();
    return path + (query ? '?' + query : '');
  }

  function fetchJson(url, options) {
    var opts = options || {};
    var timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 9000;
    var externalSignal = opts.signal;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout);
    var onAbort = function () { try { ctrl.abort(); } catch (e) {} };
    if (externalSignal) {
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    return fetch(url, { signal: ctrl.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .finally(function () {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      });
  }

  function request(path, params, options) {
    var lastError = null;
    var list = orderedBases();
    var opts = options || {};
    var chain = Promise.reject(new Error('not-started'));
    list.forEach(function (candidate) {
      chain = chain.catch(function () {
        if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return fetchJson(candidate + withQuery(path, params), opts).then(function (data) {
          base = candidate;
          try { localStorage.setItem(STORAGE_KEY, candidate); } catch (e) {}
          return data;
        }).catch(function (error) {
          lastError = error;
          throw error;
        });
      });
    });
    return chain.catch(function (error) {
      throw lastError || error || new Error('No RonFlix/Piped server available');
    });
  }

  function playableVideoStreams(data) {
    var streams = data && Array.isArray(data.videoStreams) ? data.videoStreams : [];
    return streams.filter(function (stream) {
      /* Piped may return video-only DASH entries. A plain <video> element needs
         a muxed stream with both audio and video, so do not select those. */
      return stream && stream.url && stream.videoOnly !== true && stream.videoOnly !== 'true';
    });
  }

  function qualityNumber(stream) {
    var quality = String((stream && (stream.quality || stream.resolution)) || '');
    var match = quality.match(/(\d{3,4})/);
    return match ? Number(match[1]) : 0;
  }

  function pickBestStream(data) {
    var streams = playableVideoStreams(data);
    if (!streams.length) return null;
    var proxyFirst = streams.filter(function (stream) {
      return /proxy|googlevideo|videoplayback/i.test(String(stream.url || ''));
    });
    var pool = proxyFirst.length ? proxyFirst : streams;
    return pool.slice().sort(function (a, b) {
      return qualityNumber(b) - qualityNumber(a);
    })[0] || null;
  }

  function allPlayableStreams(data) {
    var streams = playableVideoStreams(data);
    if (!streams.length) return [];
    var proxyFirst = streams.filter(function (stream) {
      return /proxy|googlevideo|videoplayback/i.test(String(stream.url || ''));
    });
    var pool = proxyFirst.length ? proxyFirst : streams;
    return pool.slice().sort(function (a, b) {
      return qualityNumber(b) - qualityNumber(a);
    });
  }

  function getVideoStream(videoId, options) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
      return Promise.reject(new Error('Invalid YouTube video ID'));
    }
    return request('/streams/' + encodeURIComponent(videoId), {}, options).then(function (data) {
      var selected = pickBestStream(data);
      if (!selected) throw new Error('No playable RonFlix stream returned');
      return {
        url: selected.url,
        quality: selected.quality || selected.resolution || '',
        title: data.title || 'YouTube video',
        source: base
      };
    });
  }

  function getAllVideoStreams(videoId, options) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
      return Promise.reject(new Error('Invalid YouTube video ID'));
    }
    return request('/streams/' + encodeURIComponent(videoId), {}, options).then(function (data) {
      var candidates = allPlayableStreams(data);
      if (!candidates.length) throw new Error('No playable RonFlix stream returned');
      return {
        streams: candidates.map(function (stream) {
          return {
            url: stream.url,
            quality: stream.quality || stream.resolution || '',
            format: stream.mimeType || stream.format || ''
          };
        }),
        title: data.title || 'YouTube video',
        source: base
      };
    });
  }

  window.RonflixStream = Object.freeze({
    instances: INSTANCES.slice(),
    request: request,
    getVideoStream: getVideoStream,
    getAllVideoStreams: getAllVideoStreams,
    pickBestStream: pickBestStream,
    allPlayableStreams: allPlayableStreams,
    getBase: function () { return base; }
  });
})();
