/* Standalone PrepPath prototype. No production JavaScript is imported. */
(() => {
  'use strict';

  const root = document.getElementById('app');
  const STORAGE_KEY = 'preppath-modern-prototype-v1';

  const icons = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    home: '<path d="M3 11 12 3l9 8v9H15v-6H9v6H3z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/>',
    book: '<path d="M4 4h7v17H7a3 3 0 0 0-3 3zm16 0h-7v17h4a3 3 0 0 1 3 3z"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 6 3-6 3z"/>',
    chart: '<path d="M4 20V11m6 9V5m6 15v-7m4 7H2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m15 9 6-6m-4 0h4v4"/>',
    gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7 1-2-2.2-2.2-2 1-1.7-.7-.8-2.2h-3l-.7 2.1-1.7.7-2-1L1 6l1 2-.7 1.7-2.1.8v3l2.1.7.7 1.7-1 2L3.2 20l2-1 1.7.7.7 2.1h3l.7-2.1 1.7-.7 2 1 2.1-2.1-1-2 .7-1.7z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    bell: '<path d="M5 17h14l-1.5-2v-4a5.5 5.5 0 0 0-11 0v4zm5 3h4"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 20h16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    flame: '<path d="M13 3c1 5-3 5-1 9 1-2 3-3 4-5 3 4 3 9 0 12-3 3-9 2-11-2-2-5 2-9 5-12 0 4 2 5 3 6-1-3 0-5 0-8z"/>',
    star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'
  };

  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.target}</svg>`;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const progress = (value) => `<div class="progress" aria-label="${value}% complete"><i style="width:${Math.max(0,Math.min(100,value))}%"></i></div>`;
  const tag = (label, tone = 'accent') => `<span class="tag tone-${tone}">${escapeHtml(label)}</span>`;
  const stat = (label, value, delta, tone = 'accent', glyph = 'chart') => `<article class="stat tone-${tone}"><div class="stat-top"><span class="stat-icon">${icon(glyph)}</span>${escapeHtml(label)}</div><div class="stat-value"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(delta)}</span></div></article>`;
  const button = (label, action, kind = '', attrs = '') => `<button class="btn ${kind}" data-action="${action}" ${attrs}>${escapeHtml(label)}</button>`;
  const segments = (group, items, active) => `<div class="segmented" role="tablist">${items.map(([value,label]) => `<button class="segment ${active === value ? 'active' : ''}" data-group="${group}" data-value="${value}" role="tab" aria-selected="${active === value}">${escapeHtml(label)}</button>`).join('')}</div>`;

  const navItems = [
    ['overview','Overview','home'], ['planner','Planner','calendar'], ['syllabus','Syllabus','book'],
    ['lectures','Lectures','play'], ['performance','Performance','chart'], ['practice','Practice','target']
  ];

  const subjects = [
    {id:'quant',symbol:'Q',name:'Quantitative Aptitude',sub:'Number System • Algebra • Geometry',done:62,total:128,percent:48,tone:'accent',chapters:[
      ['Number System','Mastered','Review in 6 days','accent'],['Algebra','In progress','8 of 14 topics','blue'],['Geometry','Needs revision','3 weak concepts','amber'],['Time & Distance','Pending','Not started','purple']]},
    {id:'english',symbol:'E',name:'English Language',sub:'Grammar • Vocabulary • Comprehension',done:48,total:84,percent:57,tone:'blue',chapters:[['Grammar','In progress','12 of 18 topics','blue'],['Vocabulary','Mastered','Review in 9 days','accent'],['Comprehension','Pending','2 practice sets','amber']]},
    {id:'reasoning',symbol:'R',name:'General Intelligence & Reasoning',sub:'Analogy • Coding • Series',done:31,total:80,percent:39,tone:'purple',chapters:[['Analogy','Mastered','82% mastery','accent'],['Coding-Decoding','In progress','6 of 10 topics','purple'],['Number Series','Needs revision','4 weak patterns','amber']]},
    {id:'ga',symbol:'G',name:'General Awareness',sub:'History • Polity • Science • Current Affairs',done:7,total:72,percent:10,tone:'amber',chapters:[['Indian Polity','In progress','4 of 12 topics','blue'],['Indian History','Needs revision','42% mastery','red'],['Current Affairs','Pending','7 days behind','amber']]}
  ];

  const plannerTasks = [
    {id:1,title:'English mini quiz',meta:'7:30 PM • 20 min',status:'scheduled',tone:'purple'},
    {id:2,title:'Current Affairs notes',meta:'45 min • General Awareness',status:'scheduled',tone:'blue'},
    {id:3,title:'Recurring vocabulary',meta:'Daily • 15 min',status:'scheduled',tone:'cyan'},
    {id:4,title:'Indian Polity lecture',meta:'28 min remaining',status:'progress',tone:'cyan'},
    {id:5,title:'Geometry practice',meta:'15 of 25 solved',status:'progress',tone:'amber'},
    {id:6,title:'Number System revision',meta:'Completed • 25 min',status:'done',tone:'accent'},
    {id:7,title:'Coding-Decoding set',meta:'Completed • 30 min',status:'done',tone:'accent'},
    {id:8,title:'Morning current affairs',meta:'Completed • 20 min',status:'done',tone:'accent'}
  ];

  const courses = [
    {id:1,title:'Complete Indian Polity',meta:'18 videos • 12h 40m',progress:42,tone:'accent',status:'Active',note:'4 watched this week'},
    {id:2,title:'Quantitative Aptitude Masterclass',meta:'46 videos • 28h 10m',progress:68,tone:'blue',status:'Active',note:'12 tagged • 31 watched'},
    {id:3,title:'English Vocabulary Series',meta:'32 videos • 9h 25m',progress:91,tone:'purple',status:'Almost done',note:'3 videos remaining'},
    {id:4,title:'General Awareness 2026',meta:'54 videos • 18h 50m',progress:16,tone:'amber',status:'Needs time',note:'Below weekly target'}
  ];

  const assets = [
    {id:1,title:'Fundamental Rights',meta:'Screenshot • 42:18',type:'screenshots',source:'Turbo',tone:'purple',mark:'12',date:'Today, 6:42 PM'},
    {id:2,title:'Polity notes',meta:'AI generated notes',type:'notes',source:'Lecture',tone:'cyan',mark:'AI',date:'Today, 6:18 PM'},
    {id:3,title:'Number System',meta:'Handwritten upload',type:'uploads',source:'Upload',tone:'blue',mark:'PDF',date:'16 Jul 2026'},
    {id:4,title:'Geometry formulas',meta:'Screenshot • 18:04',type:'screenshots',source:'Telegram',tone:'accent',mark:'8',date:'16 Jul 2026'},
    {id:5,title:'Current Affairs July',meta:'PDF resource',type:'uploads',source:'Upload',tone:'amber',mark:'PDF',date:'15 Jul 2026'},
    {id:6,title:'Coding-Decoding',meta:'Saved moment',type:'moments',source:'Lecture',tone:'purple',mark:'★',date:'14 Jul 2026'}
  ];

  const quizzes = [
    {id:'quant-speed',title:'Quant speed drill',meta:'Weak-topic adaptive',details:'25 questions • 20 min',tone:'accent',level:'Medium'},
    {id:'english-accuracy',title:'English accuracy set',meta:'Grammar + vocabulary',details:'25 questions • 15 min',tone:'blue',level:'Easy'},
    {id:'reasoning',title:'Reasoning challenge',meta:'Series + coding',details:'30 questions • 25 min',tone:'purple',level:'Hard'},
    {id:'current-affairs',title:'Current affairs weekly',meta:'Last 7 days',details:'25 questions • 18 min',tone:'amber',level:'Medium'},
    {id:'mock-09',title:'Mock Test 09',meta:'Full Tier 1 pattern',details:'100 questions • 60 min',tone:'red',level:'Full mock'},
    {id:'polity',title:'Polity chapter quiz',meta:'Fundamental Rights',details:'25 questions • 20 min',tone:'cyan',level:'Medium'}
  ];

  const attempts = [
    ['SSC CGL Mock Test 08','Today, 6:20 PM','142 / 200','78%','52m 14s','accent'],
    ['Polity Chapter Quiz','Yesterday','21 / 25','84%','16m 08s','blue'],
    ['Quant Speed Drill','16 Jul 2026','18 / 25','72%','19m 42s','amber'],
    ['English Accuracy Set','15 Jul 2026','23 / 25','92%','14m 21s','purple'],
    ['Reasoning Sectional 11','13 Jul 2026','39 / 50','78%','28m 40s','cyan'],
    ['SSC CGL Mock Test 07','12 Jul 2026','134 / 200','75%','56m 02s','accent'],
    ['Current Affairs Weekly','10 Jul 2026','16 / 25','64%','18m 16s','red']
  ];

  const savedQuestions = [
    ['If x + 1/x = 3, find x² + 1/x².','Quantitative Aptitude • Algebra','Medium','accent'],
    ['Which Article is the “heart and soul” of the Constitution?','General Awareness • Polity','Easy','amber'],
    ['Choose the correctly spelt word.','English • Vocabulary','Medium','blue'],
    ['Find the missing number: 4, 9, 19, 39, ?','Reasoning • Number Series','Hard','purple'],
    ['A train crosses a platform in 36 seconds…','Quantitative Aptitude • Time & Distance','Hard','red']
  ];

  const quizQuestions = [
    {q:'Which Article of the Indian Constitution is known as the “heart and soul” of the Constitution?',options:['Article 14','Article 19','Article 21','Article 32'],answer:3,subject:'General Awareness'},
    {q:'If x + 1/x = 3, what is x² + 1/x²?',options:['5','7','9','11'],answer:1,subject:'Quantitative Aptitude'},
    {q:'Choose the correctly spelt word.',options:['Accomodation','Accommodation','Acommodation','Accommadation'],answer:1,subject:'English'},
    {q:'Find the next number: 4, 9, 19, 39, ?',options:['69','79','80','81'],answer:1,subject:'Reasoning'},
    {q:'The Battle of Plassey was fought in which year?',options:['1756','1757','1761','1764'],answer:1,subject:'General Awareness'}
  ];

  const defaults = {
    route:'overview', sidebarOpen:false, modal:null, toast:'', exam:'SSC CGL 2026', plannerRange:'week', plannerView:'kanban', selectedDay:18,
    autoRollover:true, tasks:plannerTasks, focusRunning:false, focusSeconds:1500, syllabusView:'chapters', syllabusFilter:'all', expandedSubject:'quant',
    lectureView:'watch', playing:false, speed:'1.5', aiTab:'notes', lectureProgress:62, playlistWatched:4, collection:'all', performanceView:'overview', performanceRange:'month',
    performanceMode:'list', mediaFilter:'all', selectedAsset:1, practiceView:'available', quizFilter:'all', historySelected:0, savedFolder:'all',
    quiz:{current:0,answers:{},review:[],seconds:2058,submitted:false}, notifications:3
  };

  let savedState = {};
  try { savedState = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { savedState = {}; }
  const state = {...defaults, ...savedState, tasks:Array.isArray(savedState.tasks) ? savedState.tasks : plannerTasks, quiz:{...defaults.quiz,...(savedState.quiz || {})}};
  const routeFromHash = () => location.hash.replace(/^#\/?/,'') || state.route || 'overview';
  state.route = routeFromHash();

  const persist = () => {
    const copy = {...state, modal:null, toast:'', sidebarOpen:false};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
  };

  const contextForRoute = () => ({
    overview:'Preparation command center', planner:'Plan and execute', syllabus:'Coverage and mastery', lectures:'Watch and learn',
    performance:'Insights and progress', practice:'Quizzes and tests', media:'Study assets'
  }[state.route] || 'Preparation command center');

  const renderSidebar = () => `<aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" aria-label="Primary navigation">
    <div class="brand"><div class="brand-mark">P</div><div class="brand-copy"><strong>PrepPath</strong><span>EXAM COMMAND CENTER</span></div></div>
    <button class="exam-switcher" data-action="exam-switch"><span class="exam-badge">CGL</span><span class="exam-meta"><strong>${escapeHtml(state.exam)}</strong><small>12 Sep • 86 days left</small></span><span class="chevron">⌄</span></button>
    <div class="nav-label">WORKSPACE</div>
    <nav class="sidebar-nav">${navItems.map(([route,label,glyph]) => `<button class="nav-link ${state.route === route ? 'active' : ''}" data-route="${route}">${icon(glyph)}<span>${label}</span>${route === 'planner' ? '<b class="nav-count">5</b>' : ''}</button>`).join('')}</nav>
    <div class="nav-label">LIBRARY</div>
    <nav class="sidebar-nav"><button class="nav-link ${state.route === 'media' ? 'active' : ''}" data-route="media">${icon('gallery')}<span>Media Library</span><b class="nav-count">24</b></button></nav>
    <div class="daily-goal"><div class="goal-head"><span>Daily goal</span><span>72%</span></div>${progress(72)}<div class="goal-copy">2h 10m of 3h target</div><div class="streak"><i>${icon('flame')}</i><span>12 day streak</span></div></div>
    <div class="sidebar-footer"><button class="nav-link" data-action="settings">${icon('settings')}<span>Settings</span></button><button class="profile" data-action="study-profile" style="width:100%;border:0;background:transparent;color:inherit;text-align:left"><span class="avatar">PK</span><span><strong>Purendar</strong><small>Focused learner</small></span><span class="chevron">⌄</span></button></div>
  </aside>`;

  const renderTopbar = () => `<header class="topbar"><button class="icon-button mobile-menu-button" data-action="toggle-sidebar" aria-label="Open menu">${icon('menu')}</button><div class="top-context"><div class="context-eyebrow">${escapeHtml(state.route.toUpperCase())} / ${escapeHtml(state.exam)}</div><div class="context-title">${contextForRoute()}</div></div><div class="top-actions"><button class="search-button" data-action="search">${icon('search')}<span>Search anything…</span><kbd>⌘K</kbd></button><button class="icon-button" data-action="notifications" aria-label="Notifications">${icon('bell')}<span class="dot"></span></button><button class="btn btn-primary" data-action="quick-add">+ Quick add</button></div></header>`;
  const renderMobileNav = () => `<nav class="mobile-nav" aria-label="Mobile navigation">${[['overview','Home','home'],['planner','Plan','calendar'],['lectures','Study','play'],['practice','Practice','target'],['more','More','more']].map(([route,label,glyph]) => `<button class="${state.route === route || (route === 'more' && ['syllabus','performance','media'].includes(state.route)) ? 'active' : ''}" data-${route === 'more' ? 'action="mobile-more"' : `route="${route}"`}>${icon(glyph)}<span>${label}</span></button>`).join('')}</nav>`;

  const pageHeading = (titleText, subtitle, tools = '') => `<div class="page-heading"><div><h1>${escapeHtml(titleText)}</h1><p>${escapeHtml(subtitle)}</p></div>${tools ? `<div class="page-tools">${tools}</div>` : ''}</div>`;
  const appShell = (content) => `<div class="app-shell">${renderSidebar()}${renderTopbar()}<main class="main"><div class="page">${content}</div></main>${renderMobileNav()}</div>`;


  function renderOverview() {
    const bars = [62,48,78,42,87,71,55];
    const stats = [stat('Completed','148','+12 this week','accent','check'),stat('Avg. accuracy','76.4%','↑ 4.2%','blue','chart'),stat('Revision due','12','3 overdue','purple','book'),stat('Predicted score','142 / 200','+8 pts','amber','target')].join('');
    return pageHeading('Good evening, Purendar','You’re building momentum. Finish two priority tasks to stay ahead of plan.', `<button class="btn" data-route="planner">Open today’s plan</button>`) + `
      <section class="overview-hero-grid">
        <article class="health-card"><div class="health-copy"><div class="card-kicker">PREPARATION HEALTH</div><h2>On track for your target</h2><p>Pace is healthy, but General Awareness needs attention.</p><div class="hero-metrics"><div class="mini-metric"><span>WEEKLY STUDY</span><strong>12h 40m</strong></div><div class="mini-metric"><span>PLAN ADHERENCE</span><strong>84%</strong></div></div></div><div class="readiness-ring"><div class="ring-copy"><strong>80</strong><span>READINESS</span></div></div></article>
        <article class="card focus-list"><div class="card-header"><div><h2 class="card-title">Today’s focus</h2><div class="card-kicker">3 OF 5 TASKS • 2H 10M REMAINING</div></div><button class="link-button" data-route="planner">VIEW PLAN →</button></div>${progress(60)}
          <div class="focus-item"><button class="check done" data-action="toggle-focus-task" aria-label="Toggle Number System">${icon('check')}</button><span><strong>Number System revision</strong><small>Quantitative Aptitude • 25 min</small></span>${tag('Done','accent')}</div>
          <div class="focus-item"><button class="check" data-action="toggle-focus-task" aria-label="Toggle Indian Polity"></button><span><strong>Indian Polity lecture</strong><small>General Awareness • 42 min</small></span><button class="btn btn-primary" data-route="lectures">Resume</button></div>
          <div class="focus-item"><button class="check" data-action="toggle-focus-task" aria-label="Toggle English quiz"></button><span><strong>English mini quiz</strong><small>25 questions • 20 min</small></span><span class="empty-text">7:30 PM</span></div>
        </article>
      </section>
      <section class="stat-grid" style="margin-top:14px">${stats}</section>
      <section class="dashboard-grid">
        <article class="card chart-card"><div class="card-header"><div><h2 class="card-title">Study investment</h2><div class="card-kicker">TIME STUDIED VS DAILY TARGET</div></div><span class="tag tone-accent">12h 40m</span></div><div class="bar-chart">${bars.map((height,index) => `<div class="bar-wrap"><i style="height:${height}%"></i><span>${['MON','TUE','WED','THU','FRI','SAT','SUN'][index]}</span></div>`).join('')}</div></article>
        <article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Subject allocation</h2><div class="card-kicker">THIS WEEK • 12H 40M TOTAL</div></div><button class="link-button" data-route="performance">DETAILS →</button></div><div class="subject-bars">${[['Quantitative Aptitude',78,'4h 20m'],['English',62,'3h 15m'],['Reasoning',54,'2h 50m'],['General Awareness',34,'2h 15m']].map(([name,value,time],index) => `<div class="subject-line"><span>${name}</span><strong>${time}</strong><div class="progress"><i style="width:${value}%;background:${['var(--accent)','var(--blue)','var(--purple)','var(--amber)'][index]}"></i></div></div>`).join('')}</div></article>
        <article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Needs attention</h2><div class="card-kicker">SMART PRIORITIES</div></div></div><div class="attention-list"><div class="attention-item tone-amber"><strong>Indian History</strong><small>42% mastery • High impact</small></div><div class="attention-item tone-purple"><strong>Geometry</strong><small>3 weak concepts</small></div><div class="attention-item tone-blue"><strong>Mock Test 06</strong><small>Due Sunday</small></div></div></article>
      </section>
      <section class="overview-bottom-grid"><article class="card continue-card"><div class="video-thumb"><button class="play-button" data-route="lectures" aria-label="Resume lecture">${icon('play')}</button></div><div><div class="card-kicker">GENERAL AWARENESS • INDIAN POLITY</div><h3 class="card-title" style="margin:7px 0">Fundamental Rights & Duties</h3><div class="empty-text">42:18 watched • 28 minutes remaining</div>${progress(60)}</div><button class="btn btn-primary" data-route="lectures">Resume</button></article><article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Recent activity</h2><div class="card-kicker">LATEST COMPLETIONS</div></div><button class="link-button" data-route="performance">VIEW ALL →</button></div><div class="activity-list"><div><span class="check done">${icon('check')}</span><p><strong>Completed Algebra quiz</strong><small>82% accuracy • 1h ago</small></p></div><div><span class="check done">${icon('book')}</span><p><strong>Revised Coding-Decoding</strong><small>Mastery moved to 74%</small></p></div></div></article></section>`;
  }

  function taskCard(task) {
    const labels = {scheduled:'Start',progress:'Continue',done:'Done'};
    return `<article class="task-card tone-${task.tone}" draggable="true" data-task-id="${task.id}"><h4>${escapeHtml(task.title)}</h4><p>${escapeHtml(task.meta)}</p><div class="task-actions">${tag(labels[task.status],task.tone)}<button class="link-button" data-action="advance-task" data-id="${task.id}">${task.status === 'done' ? 'Reopen' : 'Move →'}</button></div></article>`;
  }

  function renderPlanner() {
    const days = ['M','T','W','T','F','S','S',...Array.from({length:35},(_,i)=>String(i+1))];
    const columns = [['scheduled','Scheduled','blue'],['progress','In progress','amber'],['done','Completed','accent']];
    const content = state.plannerView === 'kanban' ? `<div class="kanban">${columns.map(([status,label,tone]) => { const tasks = state.tasks.filter(task => task.status === status); return `<section class="kanban-column"><div class="column-head"><span class="status-dot tone-${tone}"></span>${label}<span>${tasks.length}</span></div>${tasks.map(taskCard).join('')}<button class="btn" style="width:100%" data-action="add-task">+ Add task</button></section>`; }).join('')}</div>` : `<div class="task-list-view">${state.tasks.map(taskCard).join('')}</div>`;
    return pageHeading('Smart planner','Plan time, move tasks, protect focus, and keep unfinished work moving.', button('AI generate plan','generate-plan','btn-primary')) + `
      <div class="planner-shell">
        <aside class="card planner-rail"><div class="calendar-head"><strong>July 2026</strong><span class="empty-text">Today</span></div><div class="mini-calendar">${days.map((day,index) => index < 7 ? `<span class="day label">${day}</span>` : `<button class="day ${Number(day) === state.selectedDay ? 'selected' : ''}" data-action="select-day" data-day="${day}">${day}</button>`).join('')}</div>
          <div class="rail-panel"><h4>TODAY</h4><strong>3 / 5 tasks</strong>${progress(60)}</div>
          <div class="rail-panel"><h4>MY PLANS</h4><strong>SSC CGL Master Plan</strong><span class="empty-text">84% • 86 days left</span>${progress(84)}</div>
          <div class="rail-panel"><h4>COURSE-VIDEO SYNC</h4><strong>Polity • ${state.playlistWatched} / 18 watched</strong><span class="empty-text">Next lecture added to today</span>${progress(Math.round(state.playlistWatched / 18 * 100))}</div>
          <div class="rail-panel"><div class="toggle-row"><span><h4>AUTO-ROLLOVER</h4><small class="empty-text">Move unfinished tasks</small></span><button class="switch ${state.autoRollover ? 'on' : ''}" data-action="toggle-rollover" aria-label="Toggle auto-rollover"></button></div></div>
          <div class="rail-panel"><h4>HABITS</h4><div class="empty-text">Morning CA ✓</div><div class="empty-text">Revision 4 / 7</div></div>
        </aside>
        <section class="planner-main">
          <div class="planner-toolbar">${segments('plannerRange',[['day','Day'],['week','Week'],['month','Month'],['quarter','3 Months']],state.plannerRange)}${segments('plannerView',[['kanban','Kanban'],['list','List']],state.plannerView)}</div>
          <div class="stat-grid">${stat('Planned','5 tasks','3h 25m','blue','calendar')}${stat('Completed','3 tasks','60%','accent','check')}${stat('Focus time','2h 10m','+24m','purple','clock')}${stat('Pace','On track','Healthy','cyan','chart')}</div>${content}
          <div class="focus-strip"><article class="card timer-card"><div class="card-header"><div><h3 class="card-title">Focus & Pomodoro</h3><div class="card-kicker">CURRENT SESSION • INDIAN POLITY</div></div></div><div class="timer-value" id="focusTimer">${formatTime(state.focusSeconds)}</div><div class="chip-row" style="margin-top:12px"><button class="btn btn-primary" data-action="focus-timer">${state.focusRunning ? 'Pause focus' : 'Start focus'}</button><button class="btn" data-action="adjust-timer">Adjust timer</button></div>${progress(35)}</article><article class="card weekly-bars"><div class="card-header"><div><h3 class="card-title">Weekly study time</h3><div class="card-kicker">12H 40M • +18%</div></div></div><div class="week-bars">${[40,65,48,83,72,56,35].map((height,index) => `<i class="${index === 4 ? 'active' : ''}" style="height:${height}%"></i>`).join('')}</div></article></div>
        </section>
      </div>`;
  }

  function renderSyllabus() {
    const tools = `<input class="search-field" placeholder="Search chapters…" data-input="syllabusSearch">`;
    const tabs = segments('syllabusView',[['chapters','Chapters'],['pattern','Exam Pattern']],state.syllabusView);
    if (state.syllabusView === 'pattern') return pageHeading('Exam pattern','Understand the paper structure before planning preparation.',tools) + tabs + renderExamPattern();
    const visible = subjects.filter(subject => state.syllabusFilter === 'all' || (state.syllabusFilter === 'completed' ? subject.percent >= 50 : state.syllabusFilter === 'pending' ? subject.percent < 50 : true));
    return pageHeading('Syllabus chapters','Track mastery chapter by chapter and act from one clean workspace.',tools) + tabs + `
      <section class="coverage-hero"><div><div class="card-kicker">SYLLABUS PROGRESS</div><h2>41% complete</h2><p>148 of 364 chapters • 22 bookmarked • 12 due for revision</p>${progress(41)}</div>${stat('Mastered','84','+9','accent','check')}${stat('In progress','64','12 due','amber','book')}</section>
      <div class="chip-row" style="margin-bottom:12px">${[['all','All chapters'],['pending','Pending'],['completed','Completed'],['bookmarked','Bookmarked']].map(([value,label]) => `<button class="segment ${state.syllabusFilter === value ? 'active' : ''}" data-group="syllabusFilter" data-value="${value}">${label}</button>`).join('')}</div>
      <section class="subject-accordion">${visible.map(subject => `<article class="card subject-card tone-${subject.tone}"><button class="subject-summary" data-action="toggle-subject" data-id="${subject.id}"><span class="subject-symbol">${subject.symbol}</span><span class="subject-name"><strong>${subject.name}</strong><small>${subject.sub}</small></span><span class="subject-progress">${progress(subject.percent)}<span>${subject.percent}%</span></span>${tag(`${subject.done} / ${subject.total}`,subject.tone)}<span class="chevron">${state.expandedSubject === subject.id ? '⌃' : '⌄'}</span></button>${state.expandedSubject === subject.id ? `<div class="chapter-list">${subject.chapters.map(([name,status,meta,tone]) => `<div class="chapter-row"><span><strong>${name}</strong><small>${meta}</small></span>${tag(status,tone)}<button class="link-button" data-action="chapter-video">▶ Link lecture</button><button class="link-button" data-action="bookmark">☆</button></div>`).join('')}</div>` : ''}</article>`).join('')}</section>`;
  }

  function renderExamPattern() {
    return `<section class="coverage-hero"><div><div class="card-kicker">SSC CGL 2026 • TIER 1</div><h2>Exam pattern at a glance</h2><p>Computer-based test • four sections • shared time</p></div>${stat('Questions','100','4 sections','blue','list')}${stat('Duration','60 min','−0.50 wrong','red','clock')}</section>
      <div class="pattern-grid"><article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Tier 1 structure</h2><div class="card-kicker">QUESTION AND MARK DISTRIBUTION</div></div>${segments('patternTier',[['tier1','Tier 1'],['tier2','Tier 2']],state.patternTier || 'tier1')}</div><table class="reference-table"><thead><tr><th>Section</th><th>Questions</th><th>Marks</th><th>Time</th></tr></thead><tbody>${[['General Intelligence & Reasoning',25,50,'Shared'],['General Awareness',25,50,'Shared'],['Quantitative Aptitude',25,50,'Shared'],['English Comprehension',25,50,'Shared']].map(row => `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td><td>${row[3]}</td></tr>`).join('')}<tr><td><strong>Total</strong></td><td><strong>100</strong></td><td><strong>200</strong></td><td><strong>60 min</strong></td></tr></tbody></table></article>
      <article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Marking rules</h2><div class="card-kicker">KNOW BEFORE YOU ATTEMPT</div></div></div><div class="rule-box tone-accent"><span class="rule-score">+2</span><span><strong>Correct answer</strong><small class="empty-text" style="display:block">Two marks awarded</small></span></div><div class="rule-box tone-red"><span class="rule-score">−.5</span><span><strong>Incorrect answer</strong><small class="empty-text" style="display:block">Half mark deducted</small></span></div><div class="attention-item tone-amber"><strong>Strategy note</strong><small>Target 85+ attempts with 90% accuracy. Keep the last 8 minutes for review.</small></div></article></div>
      <div class="reference-bottom"><article class="card reference-list"><div class="card-header"><div><h3 class="card-title">Eligibility</h3><div class="card-kicker">QUICK REFERENCE</div></div></div>${[['Age range','18–32 years'],['Qualification','Bachelor’s degree'],['Nationality','As per SSC rules'],['Attempts','No fixed limit']].map(([a,b]) => `<div class="data-row"><span>${a}</span><strong>${b}</strong></div>`).join('')}</article><article class="card reference-list"><div class="card-header"><div><h3 class="card-title">Important dates</h3><div class="card-kicker">PLANNING MILESTONES</div></div></div>${[['Notification','June 2026'],['Application closes','July 2026'],['Tier 1 exam','September 2026'],['Tier 2 exam','December 2026']].map(([a,b]) => `<div class="data-row"><span>${a}</span><strong>${b}</strong></div>`).join('')}</article><article class="card reference-list"><div class="card-header"><div><h3 class="card-title">Preparation tips</h3><div class="card-kicker">BASED ON EXAM WEIGHT</div></div></div>${['Balance speed and accuracy.','Attempt strong sections first.','Review marked questions last.'].map((item,index) => `<div class="data-row"><span>${String(index+1).padStart(2,'0')} • ${item}</span></div>`).join('')}<button class="btn btn-primary" data-action="generate-plan" style="width:100%;margin-top:12px">Build plan from pattern</button></article></div>`;
  }


  function renderLectures() {
    const tabs = segments('lectureView',[['watch','Watch'],['library','Library & Organiser']],state.lectureView);
    if (state.lectureView === 'library') return pageHeading('Lecture library & organiser','Import, group, tag, filter, and schedule course videos.', button('+ Import playlist','import-playlist','btn-primary')) + tabs + renderLectureLibrary();
    const aiContent = {
      notes:`<div class="note-block tone-accent"><h4>KEY IDEA</h4><p>Fundamental Rights protect individual liberty against arbitrary state action under Articles 12–35.</p></div><div class="note-block tone-blue"><h4>LIVE NOTES</h4><ul><li>Six categories of Fundamental Rights</li><li>Article 32: constitutional remedies</li><li>Reasonable restrictions apply</li></ul></div>`,
      quiz:`<div class="note-block tone-purple"><h4>QUICK CHECK</h4><p>Which Article provides the Right to Constitutional Remedies?</p><div class="chip-row"><button class="btn" data-action="ai-answer">Article 21</button><button class="btn" data-action="ai-answer-correct">Article 32</button></div></div>`,
      cards:`<div class="note-block tone-cyan"><h4>FLASHCARD 3 OF 8</h4><p><strong>Front:</strong> What is Article 32?</p><p><strong>Back:</strong> The right to move the Supreme Court for enforcement of Fundamental Rights.</p></div>`,
      tutor:`<div class="note-block tone-purple"><h4>ASK ABOUT THIS LECTURE</h4><p>Try “Explain Article 32 simply” or “Compare Articles 32 and 226”.</p><button class="btn btn-purple" data-action="ask-tutor">Ask tutor</button></div>`
    }[state.aiTab];
    return pageHeading('Lecture watch','Video, chapters, playback, moments, screenshots, and AI study tools.') + tabs + `
      <div class="url-bar"><input value="https://youtube.com/watch?v=polity-06" aria-label="Lecture URL"><button class="btn btn-primary" data-action="load-lecture">Load</button><button class="btn" data-action="focus-mode">Focus mode</button><button class="btn" data-action="external-youtube">YouTube ↗</button></div>
      <div class="watch-grid"><article class="card player-card"><div class="player-stage"><button class="play-button" style="width:72px;height:72px" data-action="toggle-play" aria-label="${state.playing ? 'Pause' : 'Play'}">${icon(state.playing ? 'clock' : 'play')}</button><h2>Fundamental Rights & Duties</h2></div><div class="player-controls"><span>${state.playing ? 'Playing' : 'Paused'}</span>${progress(state.lectureProgress)}<span>42:18 / 1:10:24</span></div><div class="control-row"><div class="chip-row"><button class="link-button" data-action="save-moment">☆ Save moment</button><button class="link-button" data-action="capture-screenshot">▣ Screenshot</button><button class="link-button" data-action="open-screenshot-gallery">Gallery</button><button class="link-button" data-action="toggle-pip">PiP</button></div><div class="speed-row">${['0.5','1','1.25','1.5','2','3','4'].map(speed => `<button class="speed ${state.speed === speed ? 'active' : ''}" data-group="speed" data-value="${speed}">${speed}×</button>`).join('')}</div></div></article>
      <aside class="card ai-panel"><div class="card-header"><div><h2 class="card-title">AI study assistant</h2><div class="card-kicker">NOTES • QUIZ • CARDS • TUTOR</div></div></div>${segments('aiTab',[['notes','Notes'],['quiz','Quiz'],['cards','Cards'],['tutor','Tutor']],state.aiTab)}<div class="ai-content">${aiContent}<div class="note-block tone-accent"><h4>AUTO-SAVED</h4><p>8 notes • 3 moments • 1 screenshot</p></div></div></aside></div>
      <div class="watch-bottom"><article class="card chapter-links"><div class="card-header"><div><h3 class="card-title">Chapter links</h3><div class="card-kicker">JUMP TO A TOPIC</div></div></div>${[['00:00','Introduction'],['18:42','Six Fundamental Rights'],['42:18','Article 32']].map(([time,label],index) => `<button class="chapter-link ${index === 2 ? 'active' : ''}" data-action="jump-chapter" data-progress="${[0,27,62][index]}"><span>${time}</span><strong>${label}</strong><span>${index === 2 ? 'Current' : 'Jump'}</span></button>`).join('')}</article><article class="card playlist-progress"><div class="card-header"><div><h3 class="card-title">Playlist progress</h3><div class="card-kicker">${state.playlistWatched} OF 18 VIDEOS • ${Math.round(state.playlistWatched / 18 * 100)}% COMPLETE</div></div><div class="chip-row"><button class="link-button" data-action="mark-video-watched">Mark watched</button><select class="select-field"><option>Playlist order</option><option>Shortest first</option><option>Unwatched first</option></select></div></div>${progress(Math.round(state.playlistWatched / 18 * 100))}<div class="data-row" style="grid-template-columns:1fr auto"><span><strong>Now playing</strong><small class="empty-text" style="display:block">Fundamental Rights & Duties</small></span><span>28 min left</span></div><div class="data-row" style="grid-template-columns:1fr auto"><span><strong>Up next</strong><small class="empty-text" style="display:block">Directive Principles of State Policy</small></span><button class="link-button" data-action="next-video">Play →</button></div></article></div>`;
  }

  function renderLectureLibrary() {
    return `<div class="stat-grid">${stat('Playlists','8','2 active','accent','play')}${stat('Videos','186','74 watched','blue','list')}${stat('Groups','6','24 tagged','purple','folder')}${stat('Remaining','18h 42m','78% planned','amber','clock')}</div><div class="library-shell"><aside class="card collection-rail"><div class="card-header"><div><h3 class="card-title">Collections</h3><div class="card-kicker">GROUPS, TAGS AND FILTERS</div></div></div>${[['all','All playlists','8'],['active','Active','2'],['later','Saved for later','3'],['completed','Completed','3']].map(([value,label,count]) => `<button class="collection-link ${state.collection === value ? 'active' : ''}" data-group="collection" data-value="${value}"><span>${label}</span><strong>${count}</strong></button>`).join('')}<div class="nav-label" style="margin-left:0">CUSTOM GROUPS</div>${[['Polity sprint','24'],['Weak topics','12'],['Mock analysis','8']].map(([label,count]) => `<button class="collection-link" data-action="filter-group"><span>${label}</span><strong>${count}</strong></button>`).join('')}<div class="nav-label" style="margin-left:0">TAGS</div><div class="chip-row">${tag('Revision','purple')}${tag('Important','amber')}${tag('Short','blue')}${tag('Long form','accent')}</div><div class="storage"><strong style="font-size:10px">Auto study plan</strong><p class="empty-text">Schedule playlist videos into Planner.</p><button class="link-button" data-action="generate-plan">Create →</button></div></aside><section class="card course-list"><div class="card-header"><div><h2 class="card-title">Playlist library</h2><div class="card-kicker">SORT: RECENTLY WATCHED</div></div><div class="chip-row"><button class="btn" data-action="bulk-actions">Bulk actions</button><button class="btn btn-primary" data-action="add-video">+ Video</button></div></div>${courses.map(course => `<article class="course-row"><div class="course-thumb"><button class="play-button" data-action="play-course" data-id="${course.id}">${icon('play')}</button></div><div class="course-info"><h3>${course.title}</h3><p>${course.meta}</p>${progress(course.progress)}<div class="chip-row" style="margin-top:9px">${tag(course.status,course.tone)}<span class="empty-text">${course.note}</span></div></div><div class="course-actions"><strong style="color:var(--${course.tone});font-size:10px">${course.progress}%</strong><button class="btn" data-action="course-menu">•••</button></div></article>`).join('')}<div class="chip-row" style="margin-top:14px"><button class="btn" data-action="mark-watched">Mark watched</button><button class="btn" data-action="reset-progress">Reset progress</button><button class="btn" data-action="move-group">Move to group</button><button class="btn" data-action="add-tag">Add tag</button></div></section></div>`;
  }

  function renderPerformance() {
    const tabs = segments('performanceView',[['overview','Overview'],['revision','Revision']],state.performanceView);
    if (state.performanceView === 'revision') return pageHeading('Revision queue','Due reviews, memory forecast, mastery, and spaced repetition.',button('Start revision','start-revision','btn-primary')) + tabs + renderRevision();
    const points = '20,190 105,155 190,170 275,115 360,135 445,80 530,100 615,45';
    return pageHeading('Performance overview','Range analytics, subject trends, completed work, and timeline.',segments('performanceRange',[['week','Week'],['month','Month'],['quarter','Quarter']],state.performanceRange)) + tabs + `
      <div class="stat-grid">${stat('Completed targets','48','+12 this month','accent','check')}${stat('Study time','42h 18m','+18%','blue','clock')}${stat('Avg. accuracy','76.4%','+4.2%','purple','target')}${stat('Videos completed','31','8 this week','cyan','play')}</div>
      <div class="analytics-grid"><article class="card chart-card"><div class="card-header"><div><h2 class="card-title">Completion trend</h2><div class="card-kicker">TARGETS AND VIDEOS • ${state.performanceRange.toUpperCase()}</div></div>${segments('performanceMode',[['list','List'],['timeline','Timeline']],state.performanceMode)}</div><div class="line-chart"><svg viewBox="0 0 640 220" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="url(#chartGradient)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="chartGradient"><stop stop-color="#00C896"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>${points.split(' ').map(point => {const [x,y]=point.split(',');return `<circle cx="${x}" cy="${y}" r="5" fill="#00C896" stroke="#0A0D12" stroke-width="3"/>`;}).join('')}</svg></div></article><article class="card card-pad"><div class="card-header"><div><h2 class="card-title">Subject performance</h2><div class="card-kicker">COMPLETION • ACCURACY</div></div></div><div class="subject-bars">${[['English',84,'blue'],['Reasoning',79,'purple'],['Quantitative Aptitude',74,'accent'],['General Awareness',61,'amber']].map(([name,value,tone]) => `<div class="subject-line"><span>${name}</span><strong style="color:var(--${tone})">${value}%</strong><div class="progress"><i style="width:${value}%;background:var(--${tone})"></i></div></div>`).join('')}</div><div class="attention-item tone-amber" style="margin-top:18px"><strong>General Awareness is below target</strong><small>Prioritize Indian History and Current Affairs.</small></div></article></div>
      <article class="card completed-work"><div class="card-header"><div><h2 class="card-title">Completed work</h2><div class="card-kicker">SEARCH, FILTER, AND REVIEW OUTPUT</div></div><div class="chip-row"><input class="search-field" placeholder="Search completed work…"><select class="select-field"><option>All types</option><option>Targets</option><option>Videos</option><option>Quizzes</option></select></div></div><div class="completed-head"><span>Item</span><span>Subject</span><span>Type</span><span>Completed</span><span></span></div>${[['Number System revision','Quantitative Aptitude','Target','Today, 8:10 AM','accent'],['Fundamental Rights & Duties','General Awareness','Video','Yesterday, 7:42 PM','blue'],['English Accuracy Set','English','Quiz • 92%','15 Jul, 6:20 PM','purple'],['Coding-Decoding practice','Reasoning','Target','14 Jul, 9:05 AM','cyan']].map(row => `<div class="completed-row"><strong>${row[0]}</strong><span>${row[1]}</span>${tag(row[2],row[4])}<span class="empty-text">${row[3]}</span><button class="link-button" data-action="view-completion">View →</button></div>`).join('')}</article>`;
  }

  function renderRevision() {
    const revisionItems = [['Fundamental Rights','Indian Polity','Overdue by 2 days','red'],['Number System shortcuts','Quantitative Aptitude','Due now','amber'],['Coding-Decoding patterns','Reasoning','Due in 2 hours','blue'],['Active & Passive Voice','English','Due this evening','purple'],['Indian National Movement','History','Due tomorrow','accent']];
    return `<div class="stat-grid">${stat('Due today','12 topics','3 overdue','amber','clock')}${stat('This week','34 topics','8 mastered','blue','calendar')}${stat('Retention','82%','+6%','accent','chart')}${stat('Revision streak','9 days','Best 15','purple','flame')}</div><div class="revision-grid"><article class="card revision-queue"><div class="card-header"><div><h2 class="card-title">Today’s spaced-repetition queue</h2><div class="card-kicker">ORDERED BY URGENCY AND MEMORY DECAY</div></div><select class="select-field"><option>All subjects</option><option>Quantitative Aptitude</option><option>General Awareness</option></select></div>${revisionItems.map((item,index) => `<div class="revision-item tone-${item[3]}"><span class="queue-number">${index+1}</span><span><strong>${item[0]}</strong><small>${item[1]} • ${item[2]}</small></span><button class="btn" data-action="review-topic" data-topic="${escapeHtml(item[0])}">${index === 0 ? 'Review now' : 'Review'}</button></div>`).join('')}</article><aside><article class="card forecast"><div class="card-header"><div><h2 class="card-title">Retention forecast</h2><div class="card-kicker">NEXT 7 DAYS</div></div></div><div class="forecast-bars">${[82,74,69,77,64,71,59].map((value,index) => `<div class="forecast-bar"><i style="height:${value}%"></i><span>${['S','M','T','W','T','F','S'][index]}</span></div>`).join('')}</div><p class="empty-text">17 topics enter the review window this week.</p></article><article class="card mastery-card"><div class="card-header"><div><h2 class="card-title">Mastery distribution</h2><div class="card-kicker">364 TOTAL CHAPTERS</div></div></div><div class="subject-bars">${[['Mastered',31,112,'accent'],['Learning',38,138,'blue'],['Needs revision',22,80,'amber'],['Not started',9,34,'purple']].map(([name,value,count,tone]) => `<div class="subject-line"><span>${name}</span><strong>${count}</strong><div class="progress"><i style="width:${value}%;background:var(--${tone})"></i></div></div>`).join('')}</div></article></aside></div>`;
  }

  function renderMedia() {
    const visible = state.mediaFilter === 'all' ? assets : assets.filter(asset => asset.type === state.mediaFilter);
    const selected = assets.find(asset => asset.id === state.selectedAsset) || assets[0];
    return pageHeading('Media library','Folders, screenshots, uploads, saved moments, and linked previews.',button('+ Upload','upload-asset','btn-primary')) + `
      <div class="media-shell"><aside class="card media-rail"><div class="card-header"><div><h2 class="card-title">Library</h2><div class="card-kicker">FOLDERS AND SOURCES</div></div></div><div class="empty-text" style="margin-bottom:10px">All media / Recent</div>${[['all','All items','24'],['screenshots','Lecture screenshots','12'],['uploads','Uploads & PDFs','9'],['moments','Saved moments','7'],['notes','Generated notes','8']].map(([value,label,count]) => `<button class="collection-link ${state.mediaFilter === value ? 'active' : ''}" data-group="mediaFilter" data-value="${value}"><span>${label}</span><strong>${count}</strong></button>`).join('')}<div class="nav-label" style="margin-left:0">SOURCE FILTER</div><div class="chip-row">${tag('Turbo','purple')}${tag('Telegram','blue')}${tag('Upload','amber')}</div><div class="storage"><strong style="font-size:10px">Storage</strong><p class="empty-text">1.8 GB of 5 GB used</p>${progress(36)}</div><button class="btn" data-action="new-folder" style="width:100%;margin-top:12px">+ New folder</button></aside><section class="media-main"><div class="card-header"><div><h2 class="card-title">Recent study assets</h2><div class="card-kicker">${visible.length} ITEMS • UPDATED TODAY</div></div><div class="chip-row"><input class="search-field" placeholder="Search files…"><button class="btn">Grid</button><button class="btn">List</button></div></div><div class="asset-grid">${visible.map(asset => `<article class="card asset-card tone-${asset.tone}"><button class="asset-preview" style="width:100%" data-action="select-asset" data-id="${asset.id}"><span class="asset-icon">${asset.mark}</span></button><div class="asset-meta"><strong>${asset.title}</strong><button class="link-button" data-action="preview-asset" data-id="${asset.id}">Preview</button><small>${asset.meta} • ${asset.date}</small></div></article>`).join('')}</div><article class="preview-strip"><div class="asset-preview"><span class="asset-icon tone-${selected.tone}">${selected.mark}</span></div><div><div class="card-kicker">SELECTED ASSET</div><h3 class="card-title" style="margin:7px 0">${selected.title}</h3><p class="empty-text">${selected.meta} • Linked to Indian Polity / Fundamental Rights</p></div><div class="chip-row"><button class="btn btn-primary" data-action="open-source">Open source</button><button class="btn" data-action="move-asset">Move</button><button class="btn" data-action="download-asset">Download</button></div></article></section></div>`;
  }


  function renderPractice() {
    const tabs = segments('practiceView',[['available','Available'],['history','History'],['saved','Saved Questions']],state.practiceView);
    if (state.practiceView === 'history') return pageHeading('Attempt history','Review outcomes and solutions without crowding quiz discovery.') + tabs + renderHistory();
    if (state.practiceView === 'saved') return pageHeading('Saved questions','Organise difficult questions into reusable revision and practice sets.',button('Create quiz','create-quiz','btn-primary')) + tabs + renderSavedQuestions();
    return pageHeading('Practice quizzes','Adaptive, playlist, shared, and community quiz discovery.',button('Create quiz','create-quiz','btn-primary')) + tabs + `
      <section class="quiz-hero"><div><div class="card-kicker">RECOMMENDED NEXT</div><h2>General Awareness recovery set</h2><p>25 adaptive questions from your weakest topics • about 20 minutes</p><div class="chip-row" style="margin-top:12px">${tag('Adaptive','amber')}${tag('Medium','blue')}</div></div><button class="btn btn-primary" data-action="start-quiz" data-quiz="ga-recovery">Start quiz</button></section>
      <div class="chip-row" style="margin:14px 0 4px">${[['all','All'],['subject','Subject'],['playlist','Playlist'],['community','Community'],['shared','Shared']].map(([value,label]) => `<button class="segment ${state.quizFilter === value ? 'active' : ''}" data-group="quizFilter" data-value="${value}">${label}</button>`).join('')}</div>
      <section class="quiz-grid">${quizzes.map(quiz => `<article class="card quiz-card tone-${quiz.tone}"><h3>${quiz.title}</h3><p>${quiz.meta}</p>${tag(quiz.level,quiz.tone)}<div class="quiz-card-foot"><span class="empty-text">${quiz.details}</span><button class="btn" data-action="start-quiz" data-quiz="${quiz.id}">Start</button></div></article>`).join('')}</section>
      <article class="card continue-attempt"><span class="queue-number tone-purple">42</span><div><div class="card-kicker">AUTO-SAVED 18 MINUTES AGO</div><h3 class="card-title" style="margin:6px 0">SSC CGL Mock Test 08</h3><div class="empty-text">Question 42 of 100 • 31 answered • 11 marked for review</div>${progress(42)}</div><button class="btn btn-purple" data-action="continue-quiz">Continue</button></article>`;
  }

  function renderHistory() {
    const selected = attempts[state.historySelected] || attempts[0];
    return `<div class="stat-grid">${stat('Attempts','42','8 this month','blue','target')}${stat('Avg. score','74%','+5%','accent','chart')}${stat('Best subject','English','84%','purple','book')}${stat('Practice time','18h 24m','+3h','amber','clock')}</div><div class="history-layout"><section class="card history-table"><div class="card-header"><div><h2 class="card-title">Attempt history</h2><div class="card-kicker">OPEN A RESULT FOR QUESTION-BY-QUESTION REVIEW</div></div><input class="search-field" placeholder="Search attempts…"></div>${attempts.map((attempt,index) => `<button class="history-row ${state.historySelected === index ? 'selected' : ''}" data-action="select-attempt" data-index="${index}" style="width:100%;background:${state.historySelected === index ? '' : 'transparent'};color:inherit;text-align:left;border-left:${state.historySelected === index ? '' : '0'};border-right:${state.historySelected === index ? '' : '0'}"><span><strong>${attempt[0]}</strong><small class="empty-text" style="display:block">${attempt[1]}</small></span><strong>${attempt[2]}</strong><span style="color:var(--${attempt[5]})">${attempt[3]}</span><span>${attempt[4]}</span><span class="link-button">View →</span></button>`).join('')}</section><aside class="card result-summary"><div class="card-header"><div><h2 class="card-title">Selected result</h2><div class="card-kicker">${selected[0].toUpperCase()}</div></div></div><div class="score-ring"><div><strong>${selected[2].split(' / ')[0]}</strong><span>OF ${selected[2].split(' / ')[1] || '200'}</span></div></div><div class="stat-grid" style="grid-template-columns:1fr 1fr">${stat('Correct','72','78%','accent','check')}${stat('Wrong','18','−9 marks','red','close')}</div><div class="card-header" style="margin-top:18px"><div><h3 class="card-title">Subject breakdown</h3><div class="card-kicker">ACCURACY</div></div></div><div class="subject-bars">${[['English',88,'blue'],['Reasoning',80,'purple'],['Quant',76,'accent'],['GA',61,'amber']].map(([name,value,tone]) => `<div class="subject-line"><span>${name}</span><strong>${value}%</strong><div class="progress"><i style="width:${value}%;background:var(--${tone})"></i></div></div>`).join('')}</div><button class="btn btn-primary" data-route="quiz-results" style="width:100%;margin-top:20px">Open full analysis</button></aside></div>`;
  }

  function renderSavedQuestions() {
    const folders = [['all','All questions','54'],['quant','Quantitative Aptitude','18'],['english','English','12'],['reasoning','Reasoning','14'],['ga','General Awareness','10']];
    return `<div class="saved-layout"><aside class="card folder-rail"><div class="card-header"><div><h2 class="card-title">Question folders</h2><div class="card-kicker">54 SAVED QUESTIONS</div></div></div>${folders.map(([value,label,count]) => `<button class="folder-link ${state.savedFolder === value ? 'active' : ''}" data-group="savedFolder" data-value="${value}"><span>${label}</span><strong>${count}</strong></button>`).join('')}<div class="nav-label" style="margin-left:0">CUSTOM SETS</div>${[['Frequently wrong','9'],['Formula revision','7'],['Before mock','15']].map(([label,count]) => `<button class="folder-link" data-action="custom-set"><span>${label}</span><strong>${count}</strong></button>`).join('')}<div class="storage"><div class="card-kicker">BUILD A CUSTOM QUIZ</div><p>Turn saved questions into a timed practice set.</p><button class="btn btn-primary" data-action="create-quiz">Choose questions</button></div></aside><section class="card question-list"><div class="card-header"><div><h2 class="card-title">All saved questions</h2><div class="card-kicker">SORT: RECENTLY SAVED</div></div><div class="chip-row"><select class="select-field"><option>All subjects</option><option>Quantitative Aptitude</option></select><select class="select-field"><option>Difficulty</option><option>Easy</option><option>Hard</option></select></div></div>${savedQuestions.map((question,index) => `<article class="saved-question tone-${question[3]}"><span class="queue-number">${index+1}</span><div><h4>${question[0]}</h4><p>${question[1]}</p>${tag(question[2],question[3])}</div><button class="link-button" data-action="unsave-question">★</button></article>`).join('')}</section></div>`;
  }

  function renderQuizRunner() {
    const quiz = state.quiz;
    const question = quizQuestions[quiz.current % quizQuestions.length];
    const answered = Object.keys(quiz.answers).length;
    return `<div class="quiz-shell"><header class="quiz-top"><div class="brand-mark">P</div><div class="quiz-brand">PrepPath</div><div class="quiz-context">/ Quiz runner</div><button class="btn" style="margin-left:auto" data-action="exit-quiz">Exit quiz</button></header><section class="card quiz-progress-head"><span><strong>SSC CGL Mock Test 09</strong><small class="empty-text" style="display:block">Question ${quiz.current+1} of 100 • ${question.subject}</small></span><div>${progress(Math.round((quiz.current+1)/100*100))}</div><div class="timer-box"><span>TIME LEFT</span><strong id="quizTimer">${formatTime(quiz.seconds)}</strong></div></section><div class="runner-grid"><main class="card question-panel"><div class="card-header"><div><div class="card-kicker">QUESTION ${quiz.current+1}</div></div><button class="btn" data-action="mark-review">${quiz.review.includes(quiz.current) ? '★ Marked for review' : '☆ Mark for review'}</button></div><div class="question-text">${question.q}</div><div class="options">${question.options.map((option,index) => `<button class="option ${quiz.answers[quiz.current] === index ? 'selected' : ''}" data-action="select-option" data-index="${index}"><span class="option-key">${String.fromCharCode(65+index)}</span><span>${option}</span></button>`).join('')}</div><footer class="question-footer"><button class="btn" data-action="previous-question">← Previous</button><div class="chip-row"><button class="btn" data-action="clear-answer">Clear response</button><button class="btn btn-primary" data-action="next-question">Save & Next</button></div></footer></main><aside class="card palette-panel"><div class="card-header"><div><h2 class="card-title">Question palette</h2><div class="card-kicker">100 QUESTIONS</div></div></div><div class="palette-legend"><span style="color:var(--accent)">● Answered ${answered}</span><span style="color:var(--amber)">● Review ${quiz.review.length}</span><span>● Unseen ${100-answered}</span></div><div class="palette">${Array.from({length:50},(_,index) => `<button class="${index === quiz.current ? 'current' : quiz.review.includes(index) ? 'review' : quiz.answers[index] !== undefined ? 'answered' : ''}" data-action="jump-question" data-index="${index}">${index+1}</button>`).join('')}</div><div class="card-kicker">SECTION</div><div class="chip-row" style="margin:10px 0 22px">${tag('Reasoning','blue')}${tag('GA','purple')}${tag('Quant','accent')}${tag('English','amber')}</div><div class="note-block tone-accent"><h4>AUTO-SAVED</h4><p>Your answers are saved continuously.</p></div><button class="btn btn-danger" data-action="submit-quiz" style="width:100%;margin-top:18px">Submit test</button></aside></div></div>`;
  }

  function renderQuizResults() {
    const rows = [['42. Heart and soul of Constitution','Article 21','Article 32'],['57. Battle of Plassey year','1756','1757'],['63. SI unit of electric current','Volt','Ampere'],['78. Synonym of “abundant”','Scarce','Plentiful'],['91. Geometry angle relation','Option B','Option D']];
    return `<div class="quiz-shell"><header class="quiz-top"><div class="brand-mark">P</div><div class="quiz-brand">PrepPath</div><div class="quiz-context">/ Quiz results</div><button class="btn" style="margin-left:auto" data-route="practice">Back to practice</button></header><section class="results-hero"><div><div class="card-kicker">TEST COMPLETED</div><h1>SSC CGL Mock Test 09</h1><p>Strong improvement. General Awareness remains the highest-impact opportunity.</p><div class="chip-row"><button class="btn btn-primary" data-action="review-results">Review answers</button><button class="btn" data-action="retake-quiz">Retake test</button><button class="btn" data-route="practice">Back to practice</button></div></div><div class="score-ring"><div><strong>142</strong><span>OF 200</span></div></div></section><section class="stat-grid" style="max-width:1500px;margin:0 auto">${stat('Accuracy','78%','72 correct','accent','target')}${stat('Wrong','18','−9 marks','red','close')}${stat('Time used','52m 14s','7m 46s left','blue','clock')}${stat('Percentile','84th','Top 16%','purple','chart')}</section><div class="results-grid"><article class="card subject-result"><div class="card-header"><div><h2 class="card-title">Subject breakdown</h2><div class="card-kicker">SCORE • ACCURACY • TIME</div></div></div><div class="subject-bars">${[['English',88,'44 / 50 • 10m 42s','blue'],['Reasoning',80,'40 / 50 • 12m 18s','purple'],['Quantitative Aptitude',76,'38 / 50 • 17m 06s','accent'],['General Awareness',61,'20 / 50 • 12m 08s','amber']].map(([name,value,meta,tone]) => `<div class="subject-line"><span><strong>${name}</strong><small class="empty-text" style="display:block">${meta}</small></span><strong>${value}%</strong><div class="progress"><i style="width:${value}%;background:var(--${tone})"></i></div></div>`).join('')}</div><div class="attention-item tone-amber" style="margin-top:22px"><strong>Focus next</strong><small>Indian History and Current Affairs</small></div></article><article class="card question-review"><div class="card-header"><div><h2 class="card-title">Question review</h2><div class="card-kicker">SOLUTIONS AND EXPLANATIONS</div></div>${segments('resultFilter',[['all','All 100'],['wrong','Incorrect 18'],['marked','Marked 11']],state.resultFilter || 'wrong')}</div>${rows.map(row => `<div class="review-row"><strong>${row[0]}</strong><span style="color:var(--red)">${row[1]}</span><span style="color:var(--accent)">${row[2]}</span><button class="link-button" data-action="explain-answer">Explain →</button></div>`).join('')}<p class="empty-text">Open any question to view the full solution, explanation, and source chapter.</p></article></div></div>`;
  }


  function renderModal() {
    if (!state.modal) return '';
    const close = `<button class="icon-button modal-close" data-action="close-modal" aria-label="Close">${icon('close')}</button>`;
    const modalContent = {
      search:`${close}<h2>Search PrepPath</h2><p>Jump to any workspace or find study content.</p><input class="search-field" style="width:100%;height:44px" placeholder="Search chapters, plans, lectures…" autofocus><div class="command-results">${[['overview','Preparation overview'],['planner','Today’s planner'],['syllabus','Syllabus chapters'],['lectures','Indian Polity lecture'],['performance','Performance analysis'],['practice','Practice quizzes'],['media','Media library']].map(([route,label]) => `<button class="command-item" data-route="${route}"><span>${label}</span><small>Open →</small></button>`).join('')}</div>`,
      quickAdd:`${close}<h2>Quick add</h2><p>Create a task without leaving the current workspace.</p><form class="form-grid" data-form="quick-add"><label>Task title<input name="title" required placeholder="e.g. Revise Indian Polity"></label><label>Type<select name="type"><option>Study task</option><option>Quiz</option><option>Lecture</option><option>Revision</option></select></label><label>Duration<input name="duration" value="30 min"></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Add to planner</button></div></form>`,
      addTask:`${close}<h2>Add planner task</h2><p>Add a task to the selected day.</p><form class="form-grid" data-form="add-task"><label>Title<input name="title" required placeholder="Task name"></label><label>Status<select name="status"><option value="scheduled">Scheduled</option><option value="progress">In progress</option></select></label><label>Details<input name="meta" value="30 min"></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Add task</button></div></form>`,
      generatePlan:`${close}<h2>AI plan generator</h2><p>Prototype wizard: choose a goal and PrepPath will distribute work into available study time.</p><form class="form-grid" data-form="generate-plan"><label>Plan goal<select name="goal"><option>Finish entire syllabus</option><option>Recover weak subjects</option><option>Mock-test sprint</option></select></label><label>Daily study time<select name="time"><option>3 hours</option><option>4 hours</option><option>5 hours</option></select></label><label>Target date<input type="date" name="date" value="2026-09-12"></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Generate plan</button></div></form>`,
      adjustTimer:`${close}<h2>Adjust focus timer</h2><p>Choose a focus interval. Break reminders appear automatically.</p><div class="chip-row" style="margin:20px 0">${[15,25,45,60].map(minutes => `<button class="btn" data-action="set-focus-time" data-minutes="${minutes}">${minutes} min</button>`).join('')}</div>`,
      exam:`${close}<h2>Switch exam</h2><p>Progress and plans remain separate for each exam.</p><div class="command-results">${['SSC CGL 2026','SSC CHSL 2026','RRB NTPC 2026','IBPS PO 2026','BPSC 2026','SSC GD 2026'].map(exam => `<button class="command-item" data-action="choose-exam" data-exam="${exam}"><span>${exam}</span><small>${exam === state.exam ? 'Active' : 'Switch'}</small></button>`).join('')}</div>`,
      studyProfile:`${close}<h2>Study profile & onboarding</h2><p>Review the three inputs PrepPath uses to personalise your plan.</p><form class="form-grid" data-form="study-profile"><div class="profile-steps"><section><span>1</span><div><strong>Target exam</strong><small>Choose the exam and attempt date</small></div></section><section><span>2</span><div><strong>Available time</strong><small>Set weekdays, weekends, and breaks</small></div></section><section><span>3</span><div><strong>Goals & baseline</strong><small>Set score target and current level</small></div></section></div><label>Target exam<select name="exam"><option>SSC CGL 2026</option><option>SSC CHSL 2026</option><option>RRB NTPC 2026</option></select></label><label>Daily study time<select name="time"><option>3 hours</option><option>4 hours</option><option>5 hours</option></select></label><label>Target score<input name="score" value="165 / 200"></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save study profile</button></div></form>`,
      settings:`${close}<h2>Prototype settings</h2><p>These controls demonstrate intended settings placement.</p><div class="form-grid"><label>Daily target<select><option>3 hours</option><option>4 hours</option></select></label><label>Notifications<select><option>Enabled</option><option>Disabled</option></select></label><label>Auto rollover<select><option>Enabled</option><option>Disabled</option></select></label></div>`,
      notifications:`${close}<h2>Notifications</h2><p>Three updates need attention.</p><div class="command-results"><button class="command-item" data-route="performance"><span>3 revisions are overdue</span><small>Review →</small></button><button class="command-item" data-route="planner"><span>English quiz starts at 7:30 PM</span><small>Open →</small></button><button class="command-item" data-route="lectures"><span>New Polity lecture available</span><small>Watch →</small></button></div>`,
      mobileMore:`${close}<h2>More workspaces</h2><div class="command-results"><button class="command-item" data-route="syllabus"><span>Syllabus</span><small>Open →</small></button><button class="command-item" data-route="performance"><span>Performance & Revision</span><small>Open →</small></button><button class="command-item" data-route="media"><span>Media Library</span><small>Open →</small></button><button class="command-item" data-action="settings"><span>Settings</span><small>Open →</small></button></div>`,
      importPlaylist:`${close}<h2>Import playlist</h2><p>Add a YouTube playlist and organise it into your study library.</p><form class="form-grid" data-form="import-playlist"><label>Playlist URL<input type="url" required placeholder="https://youtube.com/playlist?list=..."></label><label>Group<select><option>Active playlists</option><option>Polity sprint</option><option>Weak topics</option></select></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Import</button></div></form>`,
      uploadAsset:`${close}<h2>Upload study asset</h2><p>Prototype upload supports images, PDFs, and handwritten notes.</p><form class="form-grid" data-form="upload-asset"><label>File<input type="file" required></label><label>Folder<select><option>Handwritten notes</option><option>PDF resources</option><option>Lecture screenshots</option></select></label><label>Link to chapter<input placeholder="Search chapter…"></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Upload</button></div></form>`,
      assetPreview:(() => { const asset = assets.find(item => item.id === state.selectedAsset) || assets[0]; return `${close}<h2>${asset.title}</h2><p>${asset.meta} • ${asset.date}</p><div class="asset-preview" style="height:280px;margin:18px 0"><span class="asset-icon tone-${asset.tone}">${asset.mark}</span></div><div class="modal-actions"><button class="btn" data-action="download-asset">Download</button><button class="btn btn-primary" data-action="open-source">Open source</button></div>`; })(),
      createQuiz:`${close}<h2>Create custom quiz</h2><p>Build a quiz from subjects, playlists, or saved questions.</p><form class="form-grid" data-form="create-quiz"><label>Source<select><option>Saved questions</option><option>Weak topics</option><option>Playlist</option><option>Entire syllabus</option></select></label><label>Question count<select><option>25 questions</option><option>50 questions</option><option>100 questions</option></select></label><label>Difficulty<select><option>Mixed</option><option>Easy</option><option>Hard</option></select></label><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Create quiz</button></div></form>`,
      confirmSubmit:`${close}<h2>Submit this test?</h2><p>You answered ${Object.keys(state.quiz.answers).length} questions and marked ${state.quiz.review.length} for review. You can’t change answers after submission.</p><div class="modal-actions"><button class="btn" data-action="close-modal">Continue test</button><button class="btn btn-danger" data-action="confirm-submit">Submit test</button></div>`,
      explanation:`${close}<h2>Solution explanation</h2><p><strong>Correct answer: Article 32</strong></p><div class="note-block tone-accent"><h4>WHY</h4><p>Dr. B. R. Ambedkar described Article 32 as the heart and soul of the Constitution because it guarantees the right to approach the Supreme Court for enforcement of Fundamental Rights.</p></div><button class="btn btn-primary" data-route="syllabus" style="margin-top:16px">Open source chapter</button>`
    }[state.modal];
    return `<div class="backdrop" data-action="close-modal"></div><section class="modal" role="dialog" aria-modal="true">${modalContent || `${close}<h2>Prototype action</h2><p>This interaction is represented in the standalone prototype.</p>`}</section>`;
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(safe / 60)).padStart(2,'0')}:${String(safe % 60).padStart(2,'0')}`;
  }

  function routeContent() {
    return ({overview:renderOverview,planner:renderPlanner,syllabus:renderSyllabus,lectures:renderLectures,performance:renderPerformance,practice:renderPractice,media:renderMedia}[state.route] || renderOverview)();
  }

  function render() {
    document.body.classList.toggle('quiz-active', ['quiz-runner','quiz-results'].includes(state.route));
    const content = state.route === 'quiz-runner' ? renderQuizRunner() : state.route === 'quiz-results' ? renderQuizResults() : appShell(routeContent());
    root.innerHTML = content + renderModal() + (state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : '');
    persist();
  }

  function navigate(route) {
    state.route = route;
    state.sidebarOpen = false;
    state.modal = null;
    if (location.hash !== `#${route}`) location.hash = route;
    else render();
    window.scrollTo({top:0,behavior:'smooth'});
  }

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    state.toast = message;
    render();
    toastTimer = setTimeout(() => { state.toast = ''; render(); }, 2400);
  }

  function openModal(name) { state.modal = name; render(); }

  root.addEventListener('click', (event) => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) { navigate(routeButton.dataset.route); return; }
    const groupButton = event.target.closest('[data-group]');
    if (groupButton) { state[groupButton.dataset.group] = groupButton.dataset.value; render(); return; }
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const open = (name) => openModal(name);
    switch (action) {
      case 'toggle-sidebar': state.sidebarOpen = !state.sidebarOpen; render(); break;
      case 'close-modal': state.modal = null; render(); break;
      case 'search': open('search'); break;
      case 'quick-add': open('quickAdd'); break;
      case 'exam-switch': open('exam'); break;
      case 'choose-exam': state.exam = actionButton.dataset.exam || state.exam; state.modal = null; showToast(`Switched to ${state.exam}.`); break;
      case 'settings': open('settings'); break;
      case 'study-profile': open('studyProfile'); break;
      case 'notifications': open('notifications'); break;
      case 'mobile-more': open('mobileMore'); break;
      case 'toggle-focus-task': actionButton.classList.toggle('done'); actionButton.innerHTML = actionButton.classList.contains('done') ? icon('check') : ''; break;
      case 'select-day': state.selectedDay = Number(actionButton.dataset.day); render(); break;
      case 'toggle-rollover': state.autoRollover = !state.autoRollover; render(); break;
      case 'generate-plan': open('generatePlan'); break;
      case 'add-task': open('addTask'); break;
      case 'advance-task': {
        const task = state.tasks.find(item => item.id === Number(actionButton.dataset.id));
        if (task) task.status = task.status === 'scheduled' ? 'progress' : task.status === 'progress' ? 'done' : 'scheduled';
        render(); break;
      }
      case 'focus-timer': state.focusRunning = !state.focusRunning; render(); break;
      case 'adjust-timer': open('adjustTimer'); break;
      case 'set-focus-time': state.focusSeconds = Number(actionButton.dataset.minutes) * 60; state.focusRunning = false; state.modal = null; render(); break;
      case 'toggle-subject': state.expandedSubject = state.expandedSubject === actionButton.dataset.id ? '' : actionButton.dataset.id; render(); break;
      case 'chapter-video': state.lectureView = 'watch'; showToast('Lecture link opened in the Watch workspace.'); setTimeout(() => navigate('lectures'),300); break;
      case 'bookmark': actionButton.textContent = actionButton.textContent.trim() === '☆' ? '★' : '☆'; showToast('Bookmark updated.'); break;
      case 'load-lecture': showToast('Lecture loaded. Resume position restored.'); break;
      case 'toggle-play': state.playing = !state.playing; render(); break;
      case 'focus-mode': document.documentElement.requestFullscreen?.(); showToast('Focus mode enabled. Press Esc to exit.'); break;
      case 'external-youtube': showToast('External YouTube action demonstrated.'); break;
      case 'save-moment': showToast('Moment saved with the current timestamp.'); break;
      case 'capture-screenshot': showToast('Screenshot captured and added to Media Library.'); break;
      case 'open-screenshot-gallery': state.mediaFilter = 'screenshots'; navigate('media'); showToast('Showing lecture screenshots in Media Library.'); break;
      case 'mark-video-watched': state.playlistWatched = Math.min(18, state.playlistWatched + 1); state.lectureProgress = 100; showToast(`Marked watched • ${state.playlistWatched} of 18 complete.`); break;
      case 'toggle-pip': showToast('Picture-in-picture requested.'); break;
      case 'ai-answer': showToast('Not quite. Review Article 32.'); break;
      case 'ai-answer-correct': showToast('Correct — Article 32.'); break;
      case 'ask-tutor': showToast('AI Tutor response generated for this lecture moment.'); break;
      case 'jump-chapter': state.lectureProgress = Number(actionButton.dataset.progress); render(); break;
      case 'next-video': state.lectureProgress = 0; showToast('Next lecture loaded.'); break;
      case 'import-playlist': open('importPlaylist'); break;
      case 'add-video': open('importPlaylist'); break;
      case 'play-course': state.lectureView = 'watch'; render(); showToast('Course opened in Watch mode.'); break;
      case 'bulk-actions': case 'filter-group': case 'course-menu': case 'mark-watched': case 'reset-progress': case 'move-group': case 'add-tag': showToast('Library action applied in prototype.'); break;
      case 'view-completion': showToast('Completed-item detail opened.'); break;
      case 'start-revision': case 'review-topic': showToast(`Revision session started${actionButton.dataset.topic ? `: ${actionButton.dataset.topic}` : ''}.`); break;
      case 'upload-asset': open('uploadAsset'); break;
      case 'new-folder': showToast('New folder created.'); break;
      case 'select-asset': state.selectedAsset = Number(actionButton.dataset.id); render(); break;
      case 'preview-asset': state.selectedAsset = Number(actionButton.dataset.id); open('assetPreview'); break;
      case 'open-source': state.modal = null; showToast('Linked source opened at the saved timestamp.'); break;
      case 'move-asset': case 'download-asset': showToast(action === 'move-asset' ? 'Move action demonstrated.' : 'Download prepared.'); break;
      case 'create-quiz': open('createQuiz'); break;
      case 'start-quiz': state.quiz = {...defaults.quiz,answers:{},review:[]}; navigate('quiz-runner'); break;
      case 'continue-quiz': navigate('quiz-runner'); break;
      case 'select-attempt': state.historySelected = Number(actionButton.dataset.index); render(); break;
      case 'custom-set': showToast('Custom question set selected.'); break;
      case 'unsave-question': actionButton.textContent = actionButton.textContent === '★' ? '☆' : '★'; showToast('Saved-question status updated.'); break;
      case 'exit-quiz': navigate('practice'); break;
      case 'select-option': state.quiz.answers[state.quiz.current] = Number(actionButton.dataset.index); render(); break;
      case 'mark-review': state.quiz.review = state.quiz.review.includes(state.quiz.current) ? state.quiz.review.filter(index => index !== state.quiz.current) : [...state.quiz.review,state.quiz.current]; render(); break;
      case 'clear-answer': delete state.quiz.answers[state.quiz.current]; render(); break;
      case 'previous-question': state.quiz.current = Math.max(0,state.quiz.current-1); render(); break;
      case 'next-question': state.quiz.current = Math.min(99,state.quiz.current+1); render(); break;
      case 'jump-question': state.quiz.current = Number(actionButton.dataset.index); render(); break;
      case 'submit-quiz': open('confirmSubmit'); break;
      case 'confirm-submit': state.quiz.submitted = true; navigate('quiz-results'); break;
      case 'review-results': state.resultFilter = 'wrong'; showToast('Incorrect answers filtered for review.'); break;
      case 'retake-quiz': state.quiz = {...defaults.quiz,answers:{},review:[]}; navigate('quiz-runner'); break;
      case 'explain-answer': open('explanation'); break;
      default: showToast('Interactive prototype action completed.');
    }
  });

  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    if (form.dataset.form === 'quick-add' || form.dataset.form === 'add-task') {
      const title = data.get('title') || 'New study task';
      state.tasks = [...state.tasks,{id:Date.now(),title:String(title),meta:String(data.get('duration') || data.get('meta') || '30 min'),status:String(data.get('status') || 'scheduled'),tone:'blue'}];
      state.modal = null; state.route = 'planner'; location.hash = 'planner'; showToast('Task added to Planner.'); return;
    }
    const messages = {'generate-plan':'AI study plan generated and ready for review.','import-playlist':'Playlist imported into the library.','upload-asset':'Study asset uploaded and linked.','create-quiz':'Custom quiz created from selected questions.','study-profile':'Study profile saved. Personalised planning is ready.'};
    state.modal = null; showToast(messages[form.dataset.form] || 'Prototype form completed.');
  });

  window.addEventListener('hashchange', () => { state.route = routeFromHash(); state.modal = null; render(); });
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openModal('search'); }
    if (event.key === 'Escape' && state.modal) { state.modal = null; render(); }
  });

  setInterval(() => {
    if (state.focusRunning && state.focusSeconds > 0) {
      state.focusSeconds -= 1;
      const timer = document.getElementById('focusTimer');
      if (timer) timer.textContent = formatTime(state.focusSeconds);
    }
    if (state.route === 'quiz-runner' && state.quiz.seconds > 0) {
      state.quiz.seconds -= 1;
      const timer = document.getElementById('quizTimer');
      if (timer) timer.textContent = formatTime(state.quiz.seconds);
    }
  },1000);

  render();
})();
