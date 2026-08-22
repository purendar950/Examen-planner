/* StudyPlanner dashboard reference: real-data enrichment. */
(function(){
  if(window.__spDashboardDataV1)return; window.__spDashboardDataV1=true;

  /* Distinct card backgrounds: colorful glass surfaces instead of one uniform dark card. */
  (function injectDashboardCardTheme(){
    if(document.getElementById('sp-dashboard-card-theme'))return;
    var s=document.createElement('style');
    s.id='sp-dashboard-card-theme';
    s.textContent=`
      .dashboard-v2 .dv-card{
        background:linear-gradient(145deg,rgba(20,31,52,.96),rgba(11,20,36,.98));
        border-color:rgba(255,255,255,.13);
        box-shadow:0 14px 38px rgba(0,0,0,.20),inset 0 1px 0 rgba(255,255,255,.055);
      }
      .dashboard-v2 .dv-grid-top>.dv-readiness{
        background:linear-gradient(145deg,rgba(0,132,105,.42),rgba(9,42,47,.96));
        border-color:rgba(45,230,190,.34);
      }
      .dashboard-v2 .dv-grid-top>.dv-mission{
        background:linear-gradient(145deg,rgba(28,91,170,.46),rgba(12,32,63,.97));
        border-color:rgba(72,160,255,.36);
      }
      .dashboard-v2 .dv-grid-top>.dv-quick{
        background:linear-gradient(145deg,rgba(102,61,170,.43),rgba(35,24,65,.97));
        border-color:rgba(174,126,255,.34);
      }
      .dashboard-v2 .dv-mid-row>.dv-target{
        background:linear-gradient(145deg,rgba(0,116,139,.44),rgba(9,35,48,.97));
        border-color:rgba(42,211,238,.34);
      }
      .dashboard-v2 .dv-mid-row>.dv-member{
        background:linear-gradient(145deg,rgba(111,54,166,.48),rgba(39,22,65,.97));
        border-color:rgba(192,132,252,.36);
      }
      .dashboard-v2 .dv-ops>.revision-widget{
        background:linear-gradient(145deg,rgba(111,54,166,.44),rgba(37,24,65,.97));
        border-color:rgba(192,132,252,.34);
      }
      .dashboard-v2 .dv-ops>#mock-dash-summary{
        background:linear-gradient(145deg,rgba(25,92,175,.46),rgba(12,32,65,.97));
        border-color:rgba(96,165,250,.36);
      }
      .dashboard-v2 .dv-ops>#yt-continue-card{
        background:linear-gradient(145deg,rgba(0,126,105,.44),rgba(8,43,43,.97));
        border-color:rgba(52,211,153,.34);
      }
      .dashboard-v2 .dv-ops>#ai-notes-card{
        background:linear-gradient(145deg,rgba(170,103,20,.46),rgba(61,39,15,.97));
        border-color:rgba(251,191,36,.35);
      }
      .dashboard-v2 .dv-analysis{
        background:linear-gradient(145deg,rgba(10,105,137,.44),rgba(9,35,52,.97));
        border-color:rgba(34,211,238,.34);
      }
      .dashboard-v2 .dv-subject{
        background:linear-gradient(145deg,color-mix(in srgb,var(--subject-color,#2f8cff) 20%,#111d31),#0b1628);
        border:1px solid color-mix(in srgb,var(--subject-color,#2f8cff) 28%,rgba(255,255,255,.08));
      }
      .dashboard-v2 #recent-activity-list{
        background:linear-gradient(145deg,rgba(157,45,104,.42),rgba(54,20,48,.97));
        border-color:rgba(244,114,182,.34);
      }
      .dashboard-v2 .dv-card:hover{
        transform:translateY(-2px);
        border-color:rgba(255,255,255,.22);
        box-shadow:0 18px 42px rgba(0,0,0,.25),0 0 24px rgba(80,180,255,.08),inset 0 1px 0 rgba(255,255,255,.07);
        transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;
      }
      @media (prefers-reduced-motion:reduce){.dashboard-v2 .dv-card:hover{transform:none}}
    `;
    document.head.appendChild(s);
  })();

  function key(d){d=new Date(d);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
  function day(d){d=new Date(d);d.setHours(0,0,0,0);return d}
  function add(d,n){d=new Date(d);d.setDate(d.getDate()+n);return d}
  function dur(s){s=Math.max(0,Math.floor(s||0));var h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?(h+'h '+m+'m'):(m?(m+'m'):(s+'s'))}
  function subjects(){try{return getActiveSubjects()||[]}catch(e){return[]}}
  function daysLeft(){try{var d=typeof safeExamDate==='function'?new Date(safeExamDate(appState.examDate)):new Date(appState.examDate);return Math.max(1,Math.ceil((day(d)-day(new Date()))/86400000))}catch(e){return 1}}
  function week(){var t=day(new Date()),a=[],total=0,done=0,study=0;for(var i=6;i>=0;i--){var d=add(t,-i),k=key(d),ts=(appState.tasks&&appState.tasks[k])||[],hs=Object.values((appState.habitsLog&&appState.habitsLog[k])||{}),tt=ts.length+hs.length,dd=ts.filter(function(x){return x.done||x.status==='done'}).length+hs.filter(Boolean).length;total+=tt;done+=dd;study+=ts.reduce(function(s,x){return s+(typeof taskLiveSeconds==='function'?taskLiveSeconds(x):(x.totalSeconds||0))},0)+Number((appState.videoStudyLog&&appState.videoStudyLog[k])||0);a.push({d:d,p:tt?Math.round(dd/tt*100):0})}return{a:a,total:total,done:done,study:study,p:total?Math.round(done/total*100):0}}
  function mocks(){var by=(appState.mocks&&appState.mocks[currentExam])||{},a=[];Object.keys(by).forEach(function(t){(by[t]||[]).forEach(function(m){a.push(m)})});a.sort(function(x,y){return new Date(y.date||0)-new Date(x.date||0)});var s=a.map(function(x){return Number(x.total)||0}),n=Math.min(5,s.length);return{a:a,s:s,latest:s.length?s[0]:null,best:s.length?Math.max.apply(null,s):null,avg:n?Math.round(s.slice(0,n).reduce(function(x,y){return x+y},0)/n*10)/10:null}}
  function revision(ss){var t=day(new Date()),e=add(t,7),due=0,week=0,mastered=0,names=[];ss.forEach(function(s){(s.chapters||[]).forEach(function(c){var p=(appState.progress&&appState.progress[c.id])||{},r=p.nextRevisionAt||p.revisionDate||p.nextReviewAt;if(r){var d=day(new Date(r));if(!isNaN(d)){if(d<=t){due++;if(names.length<2)names.push(c.name)}else if(d<e)week++}}if(p.mastered||p.revisionMastered||p.reviewLevel>=3)mastered++})});return{due:due,week:week,mastered:mastered,text:names.length?'Due now: '+names.join(' · ')+(due>names.length?' · +'+(due-names.length)+' more':''):'Your revision queue is empty.'}}
  function chart(w){var el=document.getElementById('dash-weekly-chart');if(!el)return;var W=560,H=120,P=22,n=w.a.length,x=function(i){return P+i*(W-2*P)/(n-1)},y=function(v){return H-P-v/100*(H-2*P)},pts=w.a.map(function(v,i){return x(i)+','+y(v.p)}).join(' '),grid=[0,50,100].map(function(v){return '<line x1="'+P+'" y1="'+y(v)+'" x2="'+(W-P)+'" y2="'+y(v)+'" stroke="#1b293b"/><text x="3" y="'+(y(v)+3)+'" font-size="7" fill="#5f6f84">'+v+'%</text>'}).join(''),dots=w.a.map(function(v,i){return '<circle cx="'+x(i)+'" cy="'+y(v.p)+'" r="3.5" fill="#00d49b"/>'}).join(''),labels=w.a.map(function(v,i){return '<text x="'+x(i)+'" y="116" text-anchor="middle" font-size="8" fill="#718096">'+v.d.toLocaleDateString('en-IN',{weekday:'short'}).slice(0,3)+'</text>'}).join('');el.innerHTML=grid+'<polyline points="'+P+','+(H-P)+' '+pts+' '+(W-P)+','+(H-P)+'" fill="rgba(0,212,155,.08)" stroke="none"/><polyline points="'+pts+'" fill="none" stroke="#00d49b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'+dots+labels}
  function render(){if(typeof appState==='undefined'||!appState)return;var ss=subjects(),all=ss.reduce(function(a,s){return a.concat(s.chapters||[])},[]),done=all.filter(function(c){return appState.progress[c.id]&&appState.progress[c.id].done}).length,remaining=all.length-done,days=daysLeft(),target=Math.max(0,Math.ceil(remaining/days)),w=week(),m=mocks(),r=revision(ss),today=key(new Date()),ts=(appState.tasks&&appState.tasks[today])||[],hs=Object.values((appState.habitsLog&&appState.habitsLog[today])||{}),dt=ts.length+hs.length,dd=ts.filter(function(x){return x.done||x.status==='done'}).length+hs.filter(Boolean).length;
    function set(id,v){var e=document.getElementById(id);if(e)e.textContent=v}
    set('chapters-per-day',target);set('dash-daily-note',remaining+' chapters remaining · '+days+' days left');var bar=document.getElementById('dash-daily-bar');if(bar)bar.style.width=(dt?Math.round(dd/dt*100):0)+'%';set('dash-study-time',dur(w.study));set('dash-completion-rate',w.p+'%');set('dash-completion-delta',w.total?w.done+' of '+w.total+' tracked items':'No tracked activity yet');set('dash-mock-average',m.avg==null?'—':m.avg);set('dash-mock-average-note',m.avg==null?'No saved mocks':'Last '+Math.min(5,m.s.length)+' saved mocks');set('dash-mock-count',m.s.length);set('dash-mock-latest',m.latest==null?'—':m.latest);set('dash-mock-best',m.best==null?'—':m.best);set('dash-mock-preview',m.s.length?'Latest saved mock · '+(m.a[0].name||'Mock'):'No mock tests saved yet.');set('rev-due-count',r.due);set('rev-week-count',r.week);set('rev-mastered-count',r.mastered);set('rev-due-preview',r.text);var plan='free';try{plan=EZ_PROFILE&&EZ_PROFILE.plan?String(EZ_PROFILE.plan).toLowerCase():'free'}catch(e){}set('dash-membership-title',plan&&plan!=='free'?'PRO MEMBER':'STUDYPLANNER MEMBER');set('dash-membership-cta',plan&&plan!=='free'?'Manage membership →':'View membership →');set('dash-notes-count',(Array.isArray(appState.ytAiNotes)?appState.ytAiNotes.length:0)+(Array.isArray(appState.ytNotebooks)?appState.ytNotebooks.length:0));set('dash-notes-media',Object.keys(appState.ytLinks||{}).length);set('dash-notes-quick',Array.isArray(appState.ytNotes)?appState.ytNotes.length:0);chart(w)}
  function hook(){if(typeof window.updateDashboard!=='function'){setTimeout(hook,50);return}var base=window.updateDashboard;if(!base.__spWrapped){var wrapped=function(){base.apply(this,arguments);try{render()}catch(e){console.warn('dashboard data',e)}};wrapped.__spWrapped=true;window.updateDashboard=wrapped}try{render()}catch(e){}}
  hook();window.addEventListener('load',function(){setTimeout(render,0)});window.setInterval(function(){if(!document.hidden)render()},60000);
})();