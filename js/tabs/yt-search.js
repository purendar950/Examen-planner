(()=>{
  const YOUTUBE_SUGGESTION_HISTORY_KEY="ronflix_youtube_suggestion_history_v1";
  const YOUTUBE_WATCH_HISTORY_KEY="ronflix_youtube_watch_history_v1";
  const YOUTUBE_SUGGESTION_BATCH=16;
  let popularPool=[];
  let currentItems=[];
  let currentQuery="";
  let currentSearchFilter="all";
  let nextPageToken="";
  let searchPlayId="";
  let searchPlayTitle="";
  let searchPlayKind="video";
  let hasActivePlayer=false;
  const localNoHttpReferer=["content:","file:"].includes(location.protocol);

  function shuffled(list){
    const out=[...list];
    for(let i=out.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [out[i],out[j]]=[out[j],out[i]];
    }
    return out;
  }

  function suggestionHistory(){
    try{
      const saved=JSON.parse(localStorage.getItem(YOUTUBE_SUGGESTION_HISTORY_KEY)||"[]");
      return Array.isArray(saved)?saved.filter(Boolean):[];
    }catch(_){ return []; }
  }

  function rememberSuggestions(items){
    try{
      const ids=items.map(x=>x.id).filter(Boolean);
      const merged=[...ids,...suggestionHistory().filter(id=>!ids.includes(id))].slice(0,80);
      localStorage.setItem(YOUTUBE_SUGGESTION_HISTORY_KEY,JSON.stringify(merged));
    }catch(_){ }
  }

  function freshSuggestionBatch(pool,count=YOUTUBE_SUGGESTION_BATCH){
    const unique=[...new Map((pool||[]).filter(x=>x?.id).map(x=>[x.id,x])).values()];
    if(!unique.length)return [];
    const seen=new Set(suggestionHistory());
    const fresh=shuffled(unique.filter(x=>!seen.has(x.id)));
    const used=new Set(fresh.map(x=>x.id));
    const older=shuffled(unique.filter(x=>!used.has(x.id)));
    const picked=[...fresh,...older].slice(0,Math.min(count,unique.length));
    rememberSuggestions(picked);
    return picked;
  }

  function rotatePopularSuggestions(){
    if(!popularPool.length)return false;
    const picked=freshSuggestionBatch(popularPool);
    render(picked);
    setMore(false);
    ytHint.textContent="Fresh trending suggestions — or search for anything above.";
    return true;
  }

  const ytGrid=document.getElementById("youtubeGrid");
  const ytEmpty=document.getElementById("youtubeEmpty");
  const ytInput=document.getElementById("youtubeSearch");
  const ytBtn=document.getElementById("youtubeSearchBtn");
  const ytSearchFilters=[...document.querySelectorAll("[data-youtube-search-filter]")];
  const ytPlayerCard=document.getElementById("youtubePlayerCard");
  const ytLocalFallback=document.getElementById("youtubeLocalFallback");
  const ytNow=document.getElementById("youtubeNowTitle");
  const ytHint=document.getElementById("youtubeHint");
  const moreWrap=document.getElementById("youtubeMoreWrap");
  const moreBtn=document.getElementById("youtubeMoreBtn");
  const recentSection=document.getElementById("youtubeRecent");
  const recentRow=document.getElementById("youtubeRecentRow");
  const recentClear=document.getElementById("youtubeRecentClear");
  const ytPlayer=document.getElementById("youtubePlayer");

  function esc(value){
    return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }

  function youtubeWatchHistory(){
    try{
      const saved=JSON.parse(localStorage.getItem(YOUTUBE_WATCH_HISTORY_KEY)||"[]");
      return Array.isArray(saved)?saved.filter(x=>x&&x.id):[];
    }catch(_){ return []; }
  }

  function renderRecent(){
    const items=youtubeWatchHistory().slice(0,10);
    recentSection.classList.toggle("show",items.length>0);
    recentRow.innerHTML=items.map(v=>`<button class="youtube-recent-card" type="button" data-youtube-recent-id="${esc(v.id)}" data-youtube-recent-kind="${esc(v.kind||"video")}" data-youtube-recent-title="${esc(v.title)}">
      <div class="youtube-recent-thumb"><img src="${esc(v.thumb||`https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>
      <div class="youtube-recent-card-title">${esc(v.title)}</div>
    </button>`).join("");
  }

  function rememberWatched(id,title,kind,thumb){
    try{
      const item={id,title:title||"YouTube video",kind:kind||"video",thumb:thumb||"",ts:Date.now()};
      const old=youtubeWatchHistory().filter(x=>x.id!==id);
      localStorage.setItem(YOUTUBE_WATCH_HISTORY_KEY,JSON.stringify([item,...old].slice(0,20)));
    }catch(_){ }
    renderRecent();
  }

  function parseYouTubeListId(value){
    const raw=String(value||"").trim();
    if(/^[A-Za-z0-9_-]{34}$/.test(raw))return raw;
    try{
      const u=new URL(raw);
      if(u.hostname.replace(/^www\./,"").endsWith("youtube.com")){
        const list=u.searchParams.get("list");
        if(/^[A-Za-z0-9_-]{10,}$/.test(list||""))return list;
      }
    }catch(_){ }
    return null;
  }

  function parseYouTubeId(value){
    const raw=String(value||"").trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(raw))return raw;
    try{
      const u=new URL(raw);
      const host=u.hostname.replace(/^www\./,"");
      if(host==="youtu.be"){
        const id=u.pathname.split("/").filter(Boolean)[0];
        return /^[A-Za-z0-9_-]{11}$/.test(id||"")?id:null;
      }
      if(host.endsWith("youtube.com")){
        const v=u.searchParams.get("v");
        if(/^[A-Za-z0-9_-]{11}$/.test(v||""))return v;
        const parts=u.pathname.split("/").filter(Boolean);
        const markerIndex=parts.findIndex(x=>["embed","shorts","live"].includes(x));
        if(markerIndex>=0 && /^[A-Za-z0-9_-]{11}$/.test(parts[markerIndex+1]||""))return parts[markerIndex+1];
      }
    }catch(_){ }
    return null;
  }

  function render(items,append=false){
    currentItems=append?[...currentItems,...items]:items;
    const html=items.map(v=>{
      const isList=v.kind==="list";
      const attr=isList?`data-youtube-list="${esc(v.id)}"`:`data-youtube-id="${esc(v.id)}"`;
      return `<button class="youtube-card" type="button" ${attr} data-youtube-title="${esc(v.title)}">
      <div class="youtube-thumb">
        <img src="${esc(v.thumb||"")}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="youtube-play-badge">${isList?"▶ Playlist":"▶ Play"}</span>
      </div>
      <div class="youtube-card-title">${esc(v.title)}</div>
      <div class="youtube-card-meta">${esc(v.meta||"YouTube")}</div>
    </button>`;
    }).join("");
    if(append) ytGrid.insertAdjacentHTML("beforeend",html); else ytGrid.innerHTML=html;
    ytEmpty.classList.toggle("show",currentItems.length===0);
  }


  function setMore(show){
    moreWrap.classList.toggle("show",!!show);
  }

  function setSearchFilter(mode){
    currentSearchFilter=mode==="playlists"?"playlists":(mode==="live"?"live":"all");
    ytSearchFilters.forEach(btn=>{
      const active=btn.dataset.youtubeSearchFilter===currentSearchFilter;
      btn.classList.toggle("active",active);
      btn.setAttribute("aria-pressed",String(active));
    });
  }

  function playYouTubeEmbed(id,title,isList=false){
    if(!ytPlayer)return;
    hasActivePlayer=true;
    ytNow.textContent=title;
    ytPlayerCard.classList.add("show");

    if(localNoHttpReferer){
      ytPlayer.removeAttribute("src");
      ytPlayer.style.display="none";
      ytLocalFallback.classList.add("show");
      ytLocalFallback.innerHTML=`<div class="youtube-local-box">
        <img src="${isList?PLAYLIST_THUMB:`https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`}" alt="">
        <div class="youtube-local-title">${esc(title)}</div>
        <div class="youtube-local-text">YouTube embeds need an HTTP Referer. Open the deployed site or use an http://localhost preview.</div>
        <button class="youtube-local-open" type="button" data-open-youtube="${esc(id)}" data-open-kind="${isList?"list":"video"}">Open on YouTube</button>
      </div>`;
      ytHint.textContent="Local file detected — playback needs HTTPS or localhost.";
    }else{
      ytLocalFallback.classList.remove("show");
      ytLocalFallback.innerHTML="";
      ytPlayer.style.display="block";
      ytPlayer.src=isList
        ?`https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0&autoplay=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`
        :`https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0&autoplay=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
    }

    const top=ytPlayerCard.getBoundingClientRect().top+window.scrollY-12;
    window.scrollTo({top,behavior:(window.innerWidth>=769?"auto":"smooth")});
  }

  function play(id,title="YouTube video"){
    if(!/^[A-Za-z0-9_-]{11}$/.test(id||""))return;
    searchPlayId=id; searchPlayTitle=title; searchPlayKind="video";
    rememberWatched(id,title,"video");
    playYouTubeEmbed(id,title,false);
  }

  function playPlaylist(id,title="YouTube playlist"){
    if(!/^[A-Za-z0-9_-]{10,}$/.test(id||""))return;
    searchPlayId=id; searchPlayTitle=title; searchPlayKind="list";
    rememberWatched(id,title,"list");
    playYouTubeEmbed(id,title,true);
  }

  async function pipedRequest(path,params={}){
    if(!window.RonflixStream || typeof window.RonflixStream.request!=="function"){
      throw new Error("RonFlix server client is unavailable");
    }
    return window.RonflixStream.request(path,params,{timeoutMs:9000});
  }

  const PLAYLIST_THUMB="data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#111319"/><text x="50%" y="50%" fill="#8f96a3" font-family="Arial" font-size="30" font-weight="700" text-anchor="middle" dominant-baseline="middle">Playlist</text></svg>`);
  function pipedItem(x,tag){
    const lm=(x.url||"").match(/[?&]list=([A-Za-z0-9_-]{10,})/);
    if(x.type==="playlist" || lm){
      if(!lm) return null;
      return {
        id:lm[1],kind:"list",
        title:x.name||x.title||"YouTube playlist",
        meta:[x.uploaderName||"YouTube",x.videos?`${x.videos} videos`:null].filter(Boolean).join(" · "),
        tags:tag||"",
        thumb:x.thumbnail||PLAYLIST_THUMB,
        live:false
      };
    }
    const m=(x.url||"").match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if(!m) return null;
    const live=x.duration===-1 || x.type==="livestream";
    return {
      id:m[1],kind:"video",
      title:x.title||"YouTube video",
      meta:x.uploaderName||"YouTube",
      tags:tag||"",
      thumb:x.thumbnail||`https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
      live
    };
  }

  async function pipedTrending(){
    const data=await pipedRequest("/trending",{region:"IN"});
    const arr=Array.isArray(data)?data:(data.items||[]);
    return arr.map(x=>pipedItem(x,"trending")).filter(Boolean);
  }

  async function loadPopular(){
    currentQuery="";
    try{
      ytHint.textContent="Loading from RonFlix server…";
      const items=await pipedTrending();
      if(!items.length) throw new Error("RonFlix returned no suggestions");
      popularPool=items;
      rotatePopularSuggestions();
    }catch(err){
      console.warn("RonFlix trending:",err);
      popularPool=[];
      render([]);
      setMore(false);
      ytHint.textContent="RonFlix server is unavailable right now. Retry in a minute or paste a YouTube video link.";
    }
  }

  async function pipedKeywordSearch(q,pageToken,append){
    const live=currentSearchFilter==="live";
    const isList=currentSearchFilter==="playlists";
    try{
      ytHint.textContent=append?"Loading more…":"Searching via RonFlix server…";
      const params={q,region:"IN",filter:isList?"playlists":(live?"all":"videos")};
      if(pageToken) params.nextpage=pageToken;
      const data=await pipedRequest("/search",params);
      let items=(data.items||[]).map(x=>pipedItem(x,q)).filter(Boolean);
      if(isList) items=items.filter(x=>x.kind==="list");
      if(live) items=items.filter(x=>x.live);
      render(items,append);
      nextPageToken=data.nextpage||"";
      setMore(!!nextPageToken);
      ytHint.textContent=currentItems.length
        ?(live?"Live now results — tap any active stream to play it here."
          :isList?"Playlist results — tap any playlist to play it here."
          :"Results — tap any video to play it here.")
        :(live?"No live streams found — try adding “live” to the search."
          :isList?"No playlists found for that search."
          :"No videos found for that search.");
    }catch(err){
      console.warn("Piped search:",err);
      nextPageToken="";
      setMore(false);
      render([]);
      ytHint.textContent="RonFlix server is busy right now. Retry in a minute.";
    }
  }

  async function keywordSearch(q,pageToken="",append=false){
    currentQuery=q;
    await pipedKeywordSearch(q,pageToken,append);
  }

  async function submit(){
    const q=ytInput.value.trim();
    if(!q){
      if(currentSearchFilter==="live"){
        ytHint.textContent="Live filter is on — type what you want to watch, for example news or music.";
        return;
      }
      if(currentSearchFilter==="playlists"){
        ytHint.textContent="Playlists filter is on — type a topic, for example rrb alp maths.";
        return;
      }
      await loadPopular();
      return;
    }
    const listId=parseYouTubeListId(q);
    if(listId){playPlaylist(listId,"YouTube playlist");return;}
    const id=parseYouTubeId(q);
    if(id){play(id,"YouTube video");return;}
    await keywordSearch(q);
  }

  function stopPlayer(){
    hasActivePlayer=false;
    if(ytPlayer){
      ytPlayer.removeAttribute("src");
      ytPlayer.style.display="none";
    }
    ytPlayerCard.classList.remove("show");
    searchPlayId="";
  }

  ytGrid.addEventListener("click",e=>{
    const card=e.target.closest("[data-youtube-id],[data-youtube-list]");
    if(!card)return;
    if(card.dataset.youtubeList) playPlaylist(card.dataset.youtubeList,card.dataset.youtubeTitle||"YouTube playlist");
    else play(card.dataset.youtubeId,card.dataset.youtubeTitle||"YouTube video");
  });
  ytLocalFallback?.addEventListener("click",e=>{
    const btn=e.target.closest("[data-open-youtube]");
    if(!btn)return;
    const id=btn.dataset.openYoutube;
    const kind=btn.dataset.openKind||"video";
    window.open(kind==="list"?`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`:`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,"_blank");
  });
  recentRow?.addEventListener("click",e=>{
    const card=e.target.closest("[data-youtube-recent-id]");
    if(!card)return;
    if(card.dataset.youtubeRecentKind==="list") playPlaylist(card.dataset.youtubeRecentId,card.dataset.youtubeRecentTitle||"YouTube playlist");
    else play(card.dataset.youtubeRecentId,card.dataset.youtubeRecentTitle||"YouTube video");
  });
  recentClear?.addEventListener("click",()=>{
    localStorage.removeItem(YOUTUBE_WATCH_HISTORY_KEY);
    renderRecent();
  });

  ytBtn.addEventListener("click",submit);
  ytInput.addEventListener("keydown",e=>{if(e.key==="Enter")submit();});
  ytSearchFilters.forEach(btn=>btn.addEventListener("click",async()=>{
    setSearchFilter(btn.dataset.youtubeSearchFilter);
    const q=ytInput.value.trim();
    if(q && !parseYouTubeId(q)) await keywordSearch(q);
    else if(currentSearchFilter==="live") ytHint.textContent="Live filter is on — search for currently live streams, such as news live.";
    else if(currentSearchFilter==="playlists") ytHint.textContent="Playlists filter is on — search full courses or topic playlists, e.g. rrb alp maths.";
    else ytHint.textContent="Search through RonFlix server — tap any video to play it here.";
  }));

  moreBtn.addEventListener("click",()=>{if(currentQuery&&nextPageToken)keywordSearch(currentQuery,nextPageToken,true);});

  setSearchFilter("all");
  renderRecent();
  loadPopular();
})()
