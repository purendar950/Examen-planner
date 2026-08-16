(()=>{
  const API_STORAGE_KEY="ronflix_youtube_api_key_v1";
  const PIPED_BASE_KEY="ronflix_youtube_piped_base_v1";
  const BUILTIN_YOUTUBE_API_KEY="AIzaSyDLoI3dxX2IJOkYMDNZuNM2WBSdNA22BlM";
  const PIPED_INSTANCES=[
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.ducks.party",
    "https://pipedapi.leptons.xyz"
  ];
  const sampleVideos=[
    {id:"sEBbMyp8lKY",title:"YouTube Embed Test",meta:"Sample video",tags:"sample test embed"},
    {id:"M7lc1UVf-VE",title:"YouTube Player Demo",meta:"Player test",tags:"demo developer player"},
    {id:"dQw4w9WgXcQ",title:"Rick Astley — Never Gonna Give You Up",meta:"Music",tags:"music pop classic"},
    {id:"9bZkp7q19f0",title:"PSY — GANGNAM STYLE",meta:"Music",tags:"music kpop popular"},
    {id:"kJQP7kiw5Fk",title:"Luis Fonsi — Despacito",meta:"Music",tags:"music latin popular"},
    {id:"JGwWNGJdvx8",title:"Ed Sheeran — Shape of You",meta:"Music",tags:"music pop popular"},
    {id:"CevxZvSJLk8",title:"Katy Perry — Roar",meta:"Music",tags:"music pop"},
    {id:"YQHsXMglC9A",title:"Adele — Hello",meta:"Music",tags:"music ballad"}
  ];
  const YOUTUBE_SUGGESTION_HISTORY_KEY="ronflix_youtube_suggestion_history_v1";
  const YOUTUBE_WATCH_HISTORY_KEY="ronflix_youtube_watch_history_v1";
  const YOUTUBE_SUGGESTION_BATCH=16;
  const hasUserKey=()=>!!localStorage.getItem(API_STORAGE_KEY);
  let YOUTUBE_API_KEY=hasUserKey()?localStorage.getItem(API_STORAGE_KEY):BUILTIN_YOUTUBE_API_KEY;
  let apiMode=hasUserKey()?"user":"builtin";
  let pipedBase=localStorage.getItem(PIPED_BASE_KEY)||"";
  let popularPool=[];
  let currentItems=[...sampleVideos];
  let currentQuery="";
  let currentSearchFilter="all";
  let nextPageToken="";

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
  const ytPlayer=document.getElementById("youtubePlayer");
  const ytPlayerCard=document.getElementById("youtubePlayerCard");
  const ytLocalFallback=document.getElementById("youtubeLocalFallback");
  const ytNow=document.getElementById("youtubeNowTitle");
  const ytHint=document.getElementById("youtubeHint");
  const apiToggle=document.getElementById("youtubeApiToggle");
  const apiPanel=document.getElementById("youtubeApiPanel");
  const apiKeyInput=document.getElementById("youtubeApiKey");
  const apiSave=document.getElementById("youtubeApiSave");
  const apiClear=document.getElementById("youtubeApiClear");
  const moreWrap=document.getElementById("youtubeMoreWrap");
  const moreBtn=document.getElementById("youtubeMoreBtn");
  const recentSection=document.getElementById("youtubeRecent");
  const recentRow=document.getElementById("youtubeRecentRow");
  const recentClear=document.getElementById("youtubeRecentClear");
  const localNoHttpReferer=["content:","file:"].includes(location.protocol);

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

  function updateApiUi(){
    const userKey=localStorage.getItem(API_STORAGE_KEY);
    apiToggle.textContent=userKey?"✓ Full search enabled":"Enable full search";
    apiToggle.classList.toggle("ready",!!userKey);
    if(userKey){
      apiPanel.classList.remove("show");
      apiKeyInput.value="";
      ytHint.textContent="Search YouTube — tap any result to play it here.";
    }
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

  function play(id,title="YouTube video"){
    if(!/^[A-Za-z0-9_-]{11}$/.test(id||""))return;
    ytNow.textContent=title;
    ytPlayerCard.classList.add("show");
    rememberWatched(id,title,"video");

    if(localNoHttpReferer){
      ytPlayer.removeAttribute("src");
      ytPlayer.style.display="none";
      ytLocalFallback.classList.add("show");
      ytLocalFallback.innerHTML=`<div class="youtube-local-box">
        <img src="https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg" alt="">
        <div class="youtube-local-title">${esc(title)}</div>
        <div class="youtube-local-text">YouTube embeds need an HTTP Referer. Serve this page over HTTPS (or http://localhost) for in-page playback.</div>
        <button class="youtube-local-open" type="button" data-open-youtube="${esc(id)}" data-open-kind="video">Open on YouTube</button>
      </div>`;
      ytHint.textContent="Local file preview detected — UI/search works here; embedded playback needs HTTPS or localhost.";
    }else{
      ytLocalFallback.classList.remove("show");
      ytLocalFallback.innerHTML="";
      ytPlayer.style.display="block";
      ytPlayer.src=`https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0&autoplay=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
    }

    const top=ytPlayerCard.getBoundingClientRect().top+window.scrollY-12;
    window.scrollTo({top,behavior:(window.innerWidth>=769?"auto":"smooth")});
  }

  function playPlaylist(id,title="YouTube playlist"){
    if(!/^[A-Za-z0-9_-]{10,}$/.test(id||""))return;
    ytNow.textContent=title;
    ytPlayerCard.classList.add("show");
    rememberWatched(id,title,"list",PLAYLIST_THUMB);

    if(localNoHttpReferer){
      ytPlayer.removeAttribute("src");
      ytPlayer.style.display="none";
      ytLocalFallback.classList.add("show");
      ytLocalFallback.innerHTML=`<div class="youtube-local-box">
        <img src="${PLAYLIST_THUMB}" alt="">
        <div class="youtube-local-title">${esc(title)}</div>
        <div class="youtube-local-text">YouTube playlist embeds need an HTTP Referer. Serve this page over HTTPS (or http://localhost) for in-page playback.</div>
        <button class="youtube-local-open" type="button" data-open-youtube="${esc(id)}" data-open-kind="list">Open on YouTube</button>
      </div>`;
      ytHint.textContent="Local file preview detected — UI/search works here; embedded playback needs HTTPS or localhost.";
    }else{
      ytLocalFallback.classList.remove("show");
      ytLocalFallback.innerHTML="";
      ytPlayer.style.display="block";
      ytPlayer.src=`https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(id)}&autoplay=1&playsinline=1&origin=${encodeURIComponent(location.origin)}`;
    }

    const top=ytPlayerCard.getBoundingClientRect().top+window.scrollY-12;
    window.scrollTo({top,behavior:(window.innerWidth>=769?"auto":"smooth")});
  }

  async function youtubeApi(path,params){
    if(!YOUTUBE_API_KEY) throw new Error("API_KEY_REQUIRED");
    const url=new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    Object.entries(params||{}).forEach(([k,v])=>{ if(v!==undefined && v!==null && v!=="") url.searchParams.set(k,String(v)); });
    url.searchParams.set("key",YOUTUBE_API_KEY);
    const r=await fetch(url);
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data?.error?.message||`YouTube ${r.status}`);
    return data;
  }

  async function fetchTimeout(url,ms=6000){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),ms);
    try{
      const r=await fetch(url,{signal:ctrl.signal});
      if(!r.ok) throw new Error("HTTP "+r.status);
      return await r.json();
    }finally{
      clearTimeout(timer);
    }
  }

  async function pipedRequest(path,params={}){
    const qs=new URLSearchParams(params).toString();
    let ordered=[...PIPED_INSTANCES];
    if(pipedBase && ordered.includes(pipedBase)){
      ordered.sort((a,b)=>a===pipedBase?-1:b===pipedBase?1:0);
    }
    let lastErr;
    for(const base of ordered){
      try{
        const data=await fetchTimeout(`${base}${path}${qs?"?"+qs:""}`);
        pipedBase=base;
        try{ localStorage.setItem(PIPED_BASE_KEY,base); }catch(_){ }
        return data;
      }catch(e){ lastErr=e; }
    }
    throw lastErr||new Error("No search mirror available");
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

  async function youtubePopular(){
    try{
      ytHint.textContent="Loading fresh YouTube suggestions…";
      const categories=[
        {id:"10",tag:"music"},
        {id:"1",tag:"movies film animation"}
      ];
      const results=await Promise.allSettled(categories.map(cat=>
        youtubeApi("videos",{
          part:"snippet",chart:"mostPopular",regionCode:"IN",
          videoCategoryId:cat.id,maxResults:35
        })
      ));
      const items=[];
      let anyFail=false;
      results.forEach((result,index)=>{
        if(result.status!=="fulfilled"){ anyFail=true; return; }
        const tag=categories[index].tag;
        (result.value.items||[]).forEach(x=>{
          if(!x.id) return;
          items.push({
            id:x.id,
            title:x.snippet?.title||"YouTube video",
            meta:x.snippet?.channelTitle||"YouTube",
            tags:tag
          });
        });
      });
      if(apiMode==="builtin" && anyFail){
        apiMode="piped";
        YOUTUBE_API_KEY="";
        ytHint.textContent="Built-in key is restricted to ronflix.pages.dev — switching to public search mirror.";
        return false;
      }
      if(!items.length){
        if(apiMode==="user") apiPanel.classList.add("show");
        return false;
      }
      popularPool=items;
      rotatePopularSuggestions();
      return true;
    }catch(err){
      console.warn("YouTube popular:",err);
      if(apiMode==="builtin"){
        apiMode="piped";
        YOUTUBE_API_KEY="";
        return false;
      }
      apiPanel.classList.add("show");
      return false;
    }
  }

  async function pipedTrending(){
    const data=await pipedRequest("/trending",{region:"IN"});
    const arr=Array.isArray(data)?data:(data.items||[]);
    return arr.map(x=>pipedItem(x,"trending")).filter(Boolean);
  }

  async function loadPopular(){
    currentQuery="";
    if(apiMode==="user" || apiMode==="builtin"){
      const ok=await youtubePopular();
      if(ok) return;
      if(apiMode==="user"){
        popularPool=[...sampleVideos];
        render(freshSuggestionBatch(popularPool,Math.min(8,popularPool.length)));
        setMore(false);
        return;
      }
    }
    if(apiMode==="piped"){
      try{
        const items=await pipedTrending();
        if(items.length){
          popularPool=items;
          rotatePopularSuggestions();
          return;
        }
      }catch(err){ console.warn("Piped trending:",err); }
    }
    popularPool=[...sampleVideos];
    render(freshSuggestionBatch(popularPool,Math.min(8,popularPool.length)));
    setMore(false);
    ytHint.textContent="Could not refresh suggestions. Use search or paste a direct YouTube link.";
  }

  async function youtubeKeywordSearch(q,pageToken,append){
    try{
      ytHint.textContent=append?"Loading more…":"Searching YouTube…";
      const isList=currentSearchFilter==="playlists";
      const searchParams={
        part:isList?"snippet,contentDetails":"snippet",
        type:isList?"playlist":"video",
        videoEmbeddable:isList?undefined:"true",
        videoSyndicated:isList?undefined:"true",
        safeSearch:"moderate",
        maxResults:20,q,pageToken
      };
      if(currentSearchFilter==="live"){ searchParams.type="video"; searchParams.videoEmbeddable="true"; searchParams.videoSyndicated="true"; searchParams.eventType="live"; }
      const d=await youtubeApi("search",searchParams);
      const items=(d.items||[]).map(x=>{
        if(isList) return {
          id:x.id?.playlistId,kind:"list",
          title:x.snippet?.title||"YouTube playlist",
          meta:[x.snippet?.channelTitle||"YouTube",x.contentDetails?.itemCount?`${x.contentDetails.itemCount} videos`:null].filter(Boolean).join(" · "),
          tags:q,
          thumb:x.snippet?.thumbnails?.high?.url||x.snippet?.thumbnails?.default?.url||PLAYLIST_THUMB
        };
        return {
          id:x.id?.videoId,kind:"video",
          title:x.snippet?.title||"YouTube video",
          meta:x.snippet?.channelTitle||"YouTube",
          tags:q
        };
      }).filter(x=>x.id);
      render(items,append);
      nextPageToken=d.nextPageToken||"";
      setMore(!!nextPageToken);
      ytHint.textContent=currentItems.length
        ?(currentSearchFilter==="live"?"Live now results — tap any active stream to play it here."
          :currentSearchFilter==="playlists"?"Playlist results — tap any playlist to play it here."
          :"YouTube results — tap any video to play it here.")
        :(currentSearchFilter==="live"?"No active embeddable live streams found for that search."
          :currentSearchFilter==="playlists"?"No playlists found for that search."
          :"No embeddable YouTube videos found.");
      return true;
    }catch(err){
      console.warn("YouTube search:",err);
      if(apiMode==="builtin"){
        apiMode="piped";
        YOUTUBE_API_KEY="";
        ytHint.textContent="Built-in key is restricted to ronflix.pages.dev — switching to public search mirror.";
        return false;
      }
      nextPageToken="";
      setMore(false);
      ytHint.textContent=`YouTube search failed: ${err.message||"check API restrictions or quota"}.`;
      apiPanel.classList.add("show");
      return false;
    }
  }

  async function pipedKeywordSearch(q,pageToken,append){
    const live=currentSearchFilter==="live";
    const isList=currentSearchFilter==="playlists";
    try{
      ytHint.textContent=append?"Loading more…":"Searching via public mirror…";
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
      apiPanel.classList.add("show");
      ytHint.textContent="Search mirrors are busy right now. Add a YouTube Data API key below for reliable search, or retry in a minute.";
    }
  }

  async function keywordSearch(q,pageToken="",append=false){
    currentQuery=q;
    if(apiMode==="user" || apiMode==="builtin"){
      const ok=await youtubeKeywordSearch(q,pageToken,append);
      if(ok) return;
    }
    if(apiMode==="piped"){
      await pipedKeywordSearch(q,pageToken,append);
      return;
    }
    nextPageToken="";
    setMore(false);
    render([]);
    apiPanel.classList.add("show");
    ytHint.textContent="Search is unavailable right now. Add a YouTube Data API key below or retry in a minute.";
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
    ytPlayer.removeAttribute("src");
    ytPlayerCard.classList.remove("show");
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
    else ytHint.textContent="Search YouTube — tap any result to play it here.";
  }));

  apiToggle.addEventListener("click",()=>apiPanel.classList.toggle("show"));
  apiSave.addEventListener("click",async()=>{
    const key=apiKeyInput.value.trim();
    if(!key){ytHint.textContent="Paste your YouTube Data API key first.";return;}
    YOUTUBE_API_KEY=key;
    apiMode="user";
    localStorage.setItem(API_STORAGE_KEY,key);
    updateApiUi();
    await loadPopular();
  });
  apiClear.addEventListener("click",()=>{
    YOUTUBE_API_KEY="";
    localStorage.removeItem(API_STORAGE_KEY);
    apiKeyInput.value="";
    apiPanel.classList.remove("show");
    apiToggle.classList.remove("ready");
    apiToggle.textContent="Enable full search";
    apiMode="piped";
    loadPopular();
  });
  moreBtn.addEventListener("click",()=>{if(currentQuery&&nextPageToken)keywordSearch(currentQuery,nextPageToken,true);});

  setSearchFilter("all");
  updateApiUi();
  renderRecent();
  loadPopular();
})()
