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
    'https://pipedapi.leptons.xyz',
    /* Additional public API mirrors from the official Piped instance list. */
    'https://pipedapi.nosebs.ru',
    'https://pipedapi-libre.kavin.rocks',
    'https://api.piped.yt',
    'https://pipedapi.drgns.space',
    'https://piped-api.codespace.cz',
    'https://pipedapi.darkness.services',
    'https://pipedapi.orangenet.cc'
  ];
  var base = '';
  try { base = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}

  function orderedBases(options) {
    var opts = options || {};
    var excluded = opts.excludeBases || [];
    if (opts.excludeBase) excluded = excluded.concat([opts.excludeBase]);
    var list = INSTANCES.filter(function (candidate) {
      return excluded.indexOf(candidate) < 0;
    });
    if (base && list.indexOf(base) >= 0) {
      list.sort(function (a, b) { return a === base ? -1 : (b === base ? 1 : 0); });
    }
    return list;
  }

  function withQuery(path, params) {
    var query = new URLSearchParams(params || {}).toString();
    return path + (query ? '?' + query : '');
  }

  function compactMessage(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 280);
  }

  function serverError(status, data) {
    var raw = data && (data.error || data.message || data.reason);
    var detail = compactMessage(raw);
    var error = new Error('HTTP ' + status + (detail ? ': ' + detail : ''));
    error.status = Number(status) || 0;
    error.serverMessage = detail;
    return error;
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
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw serverError(response.status, data);
          if (data && data.error) throw serverError(response.status || 200, data);
          return data;
        });
      })
      .finally(function () {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      });
  }

  function request(path, params, options) {
    var lastError = null;
    var informativeError = null;
    var attempted = [];
    var list = orderedBases(options);
    var opts = options || {};
    var chain = Promise.reject(new Error('not-started'));
    list.forEach(function (candidate) {
      chain = chain.catch(function () {
        if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        attempted.push(candidate);
        return fetchJson(candidate + withQuery(path, params), opts).then(function (data) {
          if (typeof opts.validate === 'function' && !opts.validate(data)) {
            var invalid = new Error('No usable response returned by Piped server');
            invalid.kind = 'invalid-response';
            throw invalid;
          }
          base = candidate;
          try { localStorage.setItem(STORAGE_KEY, candidate); } catch (e) {}
          return data;
        }).catch(function (error) {
          error.base = candidate;
          lastError = error;
          if (!informativeError || error.serverMessage ||
            (Number(error.status || 0) >= 500 && Number(informativeError.status || 0) < 500)) {
            informativeError = error;
          }
          throw error;
        });
      });
    });
    return chain.catch(function (error) {
      var finalError = informativeError || lastError || error;
      if (!finalError || finalError.message === 'not-started') {
        finalError = new Error('No RonFlix/Piped server available');
      }
      finalError.attemptedBases = attempted.slice();
      throw finalError;
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

  function isNativeVideoStream(stream) {
    var mime = String((stream && stream.mimeType) || '').toLowerCase();
    var format = String((stream && stream.format) || '').toLowerCase();
    if (/mpegurl|x-mpegurl|vnd\.apple\.mpegurl/.test(mime + ' ' + format)) return false;
    if (/^(audio|application)\//.test(mime)) return false;
    return true;
  }

  function nativeVideoStreams(data) {
    return playableVideoStreams(data).filter(isNativeVideoStream);
  }

  function qualityNumber(stream) {
    var quality = String((stream && (stream.quality || stream.resolution)) || '');
    var match = quality.match(/(\d{3,4})/);
    return match ? Number(match[1]) : 0;
  }

  function streamScore(stream) {
    var mime = String((stream && stream.mimeType) || '').toLowerCase();
    var format = String((stream && stream.format) || '').toLowerCase();
    var codec = String((stream && stream.codec) || '').toLowerCase();
    var url = String((stream && stream.url) || '');
    var score = qualityNumber(stream) * 10;
    if (mime === 'video/mp4' || /(^|[^a-z])mp4([^a-z]|$)|mpeg_?4/.test(format)) score += 10000;
    if (/avc1|h264/.test(codec)) score += 800;
    if (/webm/.test(mime + ' ' + format)) score += 100;
    if (/proxy|googlevideo|videoplayback/i.test(url)) score += 1000;
    return score;
  }

  function streamCandidates(data) {
    return nativeVideoStreams(data).slice().sort(function (a, b) {
      return streamScore(b) - streamScore(a);
    });
  }

  function pickBestStream(data) {
    return streamCandidates(data)[0] || null;
  }

  function requestStreamData(videoId, options) {
    var opts = Object.assign({}, options || {});
    opts.validate = function (data) { return streamCandidates(data).length > 0; };
    return request('/streams/' + encodeURIComponent(videoId), {}, opts);
  }

  function getVideoStreams(videoId, options) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
      return Promise.reject(new Error('Invalid YouTube video ID'));
    }
    return requestStreamData(videoId, options).then(function (data) {
      var candidates = streamCandidates(data);
      if (!candidates.length) throw new Error('No browser-compatible RonFlix stream returned');
      return {
        streams: candidates.map(function (stream) {
          return {
            url: stream.url,
            quality: stream.quality || stream.resolution || '',
            format: stream.format || '',
            mimeType: stream.mimeType || '',
            codec: stream.codec || ''
          };
        }),
        title: data.title || 'YouTube video',
        source: base
      };
    });
  }

  function getVideoStream(videoId, options) {
    return getVideoStreams(videoId, options).then(function (result) {
      var selected = result.streams[0];
      return {
        url: selected.url,
        quality: selected.quality,
        title: result.title,
        source: result.source
      };
    });
  }

  window.RonflixStream = Object.freeze({
    instances: INSTANCES.slice(),
    request: request,
    getVideoStreams: getVideoStreams,
    getVideoStream: getVideoStream,
    pickBestStream: pickBestStream,
    getBase: function () { return base; }
  });
})();
