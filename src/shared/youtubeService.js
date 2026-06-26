export function parseYouTubeUrl(input) {
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input.trim() : `https://${String(input || '').trim()}`);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) return { type: null, id: null };
    const playlistId = url.searchParams.get('list');
    if (playlistId) return { type: 'playlist', id: playlistId };
    if (url.hostname.includes('youtu.be')) return { type: 'video', id: url.pathname.slice(1, 12) || null };
    const videoId = url.searchParams.get('v') || url.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/)?.[2];
    return videoId ? { type: 'video', id: videoId } : { type: null, id: null };
  } catch {
    return { type: null, id: null };
  }
}

export function toEmbedUrl({ type, id }) {
  const base = 'rel=0&modestbranding=1&playsinline=1';
  if (type === 'playlist') return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&${base}`;
  if (type === 'video') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${base}`;
  return '';
}

export function createYouTubeService({ apiKey, fetchImpl = fetch } = {}) {
  const endpoint = 'https://www.googleapis.com/youtube/v3';

  async function getVideoDetails(videoIds) {
    const ids = Array.isArray(videoIds) ? videoIds.join(',') : videoIds;
    if (!apiKey) throw new Error('YouTube API key is required');
    const res = await fetchImpl(`${endpoint}/videos?part=snippet,contentDetails&id=${encodeURIComponent(ids)}&key=${apiKey}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'YouTube video fetch failed');
    return data.items || [];
  }

  async function getPlaylistItems(playlistId, pageToken = '') {
    if (!apiKey) throw new Error('YouTube API key is required');
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchImpl(`${endpoint}/playlistItems?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'YouTube playlist fetch failed');
    return data;
  }

  return { getVideoDetails, getPlaylistItems };
}
