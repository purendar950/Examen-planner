/* PrepPath complete interactive prototype. All data is local and intentionally illustrative. */
(() => {
  'use strict';

  const STORAGE_KEY = 'preppath-complete-prototype-v2';
  const exams = [
    { name: 'SSC CGL 2026', icon: '◫', subjects: ['Quantitative Aptitude', 'English', 'Reasoning', 'General Awareness'] },
    { name: 'SSC GD 2026', icon: '◇', subjects: ['Elementary Mathematics', 'English or Hindi', 'Reasoning', 'General Knowledge'] },
    { name: 'RRB NTPC 2026', icon: '▤', subjects: ['Mathematics', 'General Intelligence', 'General Awareness'] },
    { name: 'IBPS PO 2026', icon: '⌂', subjects: ['Quantitative Aptitude', 'English', 'Reasoning', 'Banking Awareness'] },
    { name: 'UPPCS 2026', icon: '◎', subjects: ['General Studies I', 'General Studies II', 'Current Affairs', 'Essay'] },
    { name: 'BPSC 2026', icon: '▥', subjects: ['General Studies', 'Bihar Studies', 'Current Affairs', 'General Hindi'] }
  ];
  const quizQuestions = [
    { q: 'If 20% of a number is 48, what is 35% of that number?', options: ['72', '84', '96', '108'], answer: 1, subject: 'Quantitative Aptitude', why: 'The number is 48 ÷ 0.20 = 240. Then 35% of 240 is 84.' },
    { q: 'Choose the word most similar in meaning to “meticulous”.', options: ['Careless', 'Precise', 'Rapid', 'Ordinary'], answer: 1, subject: 'English', why: 'Meticulous describes someone who is very careful and precise.' },
    { q: 'Find the next number: 3, 8, 15, 24, 35, …', options: ['44', '46', '48', '50'], answer: 2, subject: 'Reasoning', why: 'The differences are consecutive odd numbers: 5, 7, 9, 11, then 13. So 35 + 13 = 48.' },
    { q: 'The Finance Commission of India is constituted under which Article?', options: ['Article 263', 'Article 280', 'Article 324', 'Article 356'], answer: 1, subject: 'General Awareness', why: 'Article 280 of the Constitution provides for a Finance Commission.' },
    { q: 'A train covers 360 km in 4.5 hours. What is its average speed?', options: ['72 km/h', '75 km/h', '80 km/h', '90 km/h'], answer: 2, subject: 'Quantitative Aptitude', why: 'Average speed = distance ÷ time = 360 ÷ 4.5 = 80 km/h.' }
  ];

  function localIso(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  function addDays(date, amount) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + amount);
    return copy;
  }
  const demoToday = new Date();
  const demoTodayIso = localIso(demoToday);
  const defaultExamDate = localIso(addDays(demoToday, 120));

  const defaultState = {
    authenticated: false,
    onboarded: false,
    onboardingStep: 1,
    profile: { name: 'Aarav Sharma', email: 'aarav@example.com' },
    exam: 'SSC CGL 2026',
    examDate: defaultExamDate,
    dailyHours: 3,
    weakSubjects: ['Quantitative Aptitude', 'General Awareness'],
    plannerTab: 'today',
    practiceView: 'dashboard',
    practiceFilter: 'all',
    learnView: 'library',
    quizIndex: 0,
    quizQueue: [0, 1, 2, 3, 4],
    quizAnswers: [null, null, null, null, null],
    quizFinished: false,
    reviewMode: false,
    completedLessons: [0, 1, 2],
    selectedLearningTopic: 'Percentages',
    learningCourses: {
      Percentages: { activeLesson: 3, videoProgress: 36, completedLessons: [0, 1, 2], savedLessons: [] }
    },
    savedQuestions: [1, 3],
    savedLessons: [],
    flaggedQuestions: [],
    expandedSubjects: ['Quantitative Aptitude'],
    completedTopics: ['Number System', 'Analogy', 'Reading Comprehension'],
    bookmarkedTopics: ['Current Affairs'],
    syllabusSearch: '',
    syllabusSubject: 'all',
    syllabusStatus: 'all',
    learnSearch: '',
    learnSubject: 'all',
    playlists: [{ id: 1, name: 'Exam week essentials', lessons: 6 }],
    videoProgress: 36,
    videoPlaying: false,
    revisionFeedback: {},
    calendarOffset: 0,
    planIntensity: 'Balanced',
    sessions: [
      { id: 1, date: demoTodayIso, generated: true, title: 'Percentages and profit-loss', subject: 'Quantitative Aptitude', time: '8:00 AM', duration: 60, tone: '' },
      { id: 2, date: demoTodayIso, generated: true, title: 'Constitutional bodies', subject: 'General Awareness', time: '10:30 AM', duration: 45, tone: 'blue' },
      { id: 3, date: demoTodayIso, generated: true, title: 'Analogy practice set', subject: 'Reasoning', time: '4:00 PM', duration: 45, tone: 'orange' },
      { id: 4, date: demoTodayIso, generated: true, title: 'Editorial reading and vocabulary', subject: 'English', time: '7:00 PM', duration: 30, tone: '' }
    ],
    weeklyGoal: { hours: 18, questions: 300 },
    kanbanTasks: [
      { id: 1, subject: 'Quant', title: 'Time and work practice', meta: 'Due today', status: 'todo' },
      { id: 2, subject: 'English', title: 'Revise 40 vocabulary words', meta: 'Due tomorrow', status: 'todo' },
      { id: 3, subject: 'GK', title: 'April current affairs', meta: 'Due Friday', status: 'todo' },
      { id: 4, subject: 'Reasoning', title: 'Seating arrangement set', meta: '35 min left', status: 'progress' },
      { id: 5, subject: 'Quant', title: 'Percentage revision', meta: '12 of 20 done', status: 'progress' },
      { id: 6, subject: 'English', title: 'Reading comprehension', meta: 'Completed today', status: 'done' },
      { id: 7, subject: 'GK', title: 'Polity chapter 4', meta: 'Completed yesterday', status: 'done' }
    ],
    tasks: [
      { id: 1, title: 'Percentages: mixed questions', subject: 'Quant', time: '8:00 AM', done: true, credited: true },
      { id: 2, title: 'Revise constitutional bodies', subject: 'GK', time: '10:30 AM', done: false, credited: false },
      { id: 3, title: 'Complete analogy practice set', subject: 'Reasoning', time: '4:00 PM', done: false, credited: false },
      { id: 4, title: 'Read one editorial', subject: 'English', time: '7:00 PM', done: false, credited: false }
    ],
    notificationsRead: false,
    settings: { reminders: true, weeklyDigest: true, sound: false, compact: false, theme: 'light', push: true, email: true },
    streak: 12,
    studyMinutes: 148,
    timerSeconds: 25 * 60,
    timerRunning: false,
    activeLesson: 3
  };

  const saved = loadState();
  const state = { ...defaultState, ...saved, profile: { ...defaultState.profile, ...(saved.profile || {}) }, settings: { ...defaultState.settings, ...(saved.settings || {}) }, weeklyGoal: { ...defaultState.weeklyGoal, ...(saved.weeklyGoal || {}) } };
  ['savedQuestions', 'savedLessons', 'flaggedQuestions', 'expandedSubjects', 'completedTopics', 'bookmarkedTopics', 'playlists', 'kanbanTasks', 'tasks', 'sessions', 'completedLessons', 'quizQueue'].forEach(key => { if (!Array.isArray(state[key])) state[key] = defaultState[key]; });
  state.sessions = state.sessions.map(session => ({ ...session, date: session.date || demoTodayIso, generated: session.generated !== false }));
  state.tasks = state.tasks.map(task => ({ ...task, credited: Boolean(task.credited || task.done) }));
  if (!state.learningCourses || typeof state.learningCourses !== 'object' || Array.isArray(state.learningCourses)) state.learningCourses = {};
  if (!state.learningCourses[state.selectedLearningTopic]) state.learningCourses[state.selectedLearningTopic] = { activeLesson: state.activeLesson, videoProgress: state.videoProgress, completedLessons: [...state.completedLessons], savedLessons: [...state.savedLessons] };
  state.quizQueue = state.quizQueue.filter(index => Number.isInteger(index) && quizQuestions[index]);
  if (!state.quizQueue.length) state.quizQueue = defaultState.quizQueue;
  if (!state.examDate || state.examDate < demoTodayIso) state.examDate = defaultExamDate;
  if (!Number.isFinite(Number(state.dailyHours)) || Number(state.dailyHours) < 1 || Number(state.dailyHours) > 8) state.dailyHours = defaultState.dailyHours;
  if (!state.revisionFeedback || typeof state.revisionFeedback !== 'object') state.revisionFeedback = {};
  if (!exams.some(exam => exam.name === state.exam)) { state.exam = exams[0].name; state.weakSubjects = exams[0].subjects.slice(0, 2); }
  state.videoPlaying = false;
  let timerHandle = null;
  let videoHandle = null;
  let toastCounter = 0;
  let modalOpener = null;
  let filterHandle = null;

  const el = {
    app: document.getElementById('app'),
    auth: document.getElementById('authExperience'),
    product: document.getElementById('productExperience'),
    sidebar: document.getElementById('sidebar'),
    topbar: document.getElementById('topbar'),
    screen: document.getElementById('screen'),
    mobileNav: document.getElementById('mobileNav'),
    modal: document.getElementById('modalRoot'),
    toasts: document.getElementById('toastRegion')
  };

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
  }
  function syncLearningCourseState() {
    const topic = state.selectedLearningTopic || 'Percentages';
    if (!state.learningCourses || typeof state.learningCourses !== 'object') state.learningCourses = {};
    state.learningCourses[topic] = {
      activeLesson: state.activeLesson,
      videoProgress: state.videoProgress,
      completedLessons: [...state.completedLessons],
      savedLessons: [...state.savedLessons]
    };
  }
  function activateLearningTopic(topic) {
    if (!topic) return;
    syncLearningCourseState();
    state.selectedLearningTopic = topic;
    const course = state.learningCourses[topic] || { activeLesson: 0, videoProgress: 0, completedLessons: [], savedLessons: [] };
    state.activeLesson = Number(course.activeLesson) || 0;
    state.videoProgress = Number(course.videoProgress) || 0;
    state.completedLessons = Array.isArray(course.completedLessons) ? [...course.completedLessons] : [];
    state.savedLessons = Array.isArray(course.savedLessons) ? [...course.savedLessons] : [];
  }
  function persist() {
    syncLearningCourseState();
    const copy = { ...state, timerRunning: false, videoPlaying: false };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(copy)); } catch (_) { /* Prototype remains usable without storage. */ }
  }
  function esc(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
  function icon(symbol) { return `<span class="icon" aria-hidden="true">${symbol}</span>`; }
  function currentExam() { return exams.find(item => item.name === state.exam) || exams[0]; }
  function daysUntilExam() {
    const target = new Date(`${state.examDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((target - today) / 86400000);
    return Number.isFinite(diff) ? Math.max(0, diff) : 0;
  }
  function routeParts() {
    const raw = location.hash.replace(/^#\/?/, '') || 'home';
    return raw.split('/').filter(Boolean);
  }
  function go(route) {
    const hash = `#/${route}`;
    if (location.hash === hash) renderProduct(); else location.hash = hash;
  }
  function showToast(message, type = 'success') {
    const id = `toast-${++toastCounter}`;
    const toast = document.createElement('div');
    toast.id = id;
    toast.className = 'toast';
    toast.innerHTML = `${icon(type === 'success' ? '✓' : 'i')}<span>${esc(message)}</span>`;
    el.toasts.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }
  function applyTheme() {
    const theme = state.settings.theme === 'dark' ? 'dark' : 'light';
    el.app.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#081d1a' : '#123c34');
  }
  function setModal(content, wide = false, label = 'Dialog') {
    if (!el.modal.innerHTML) modalOpener = document.activeElement;
    el.modal.innerHTML = `<div class="modal-layer" data-action="backdrop-close"><section class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${content}</section></div>`;
    document.body.dataset.modalOpen = 'true';
    window.setTimeout(() => el.modal.querySelector('input, select, button, textarea')?.focus(), 0);
  }
  function closeModal() {
    el.modal.innerHTML = '';
    delete document.body.dataset.modalOpen;
    if (modalOpener instanceof HTMLElement) modalOpener.focus();
    modalOpener = null;
  }
  function modalFrame(title, body, footer = '') {
    return `<div class="modal-head"><h2>${esc(title)}</h2><button class="btn btn-icon" data-action="close-modal" aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  }

  function render() {
    applyTheme();
    if (!state.authenticated || !state.onboarded) renderAuthFlow();
    else renderProduct();
  }

  function renderAuthFlow() {
    stopTimer();
    el.product.hidden = true;
    el.auth.innerHTML = state.authenticated ? onboardingTemplate() : landingTemplate();
  }

  function landingTemplate() {
    return `<section class="auth-page" aria-label="Welcome to PrepPath">
      <div class="auth-story">
        <div class="logo light"><span class="logo-mark">P</span><span>PrepPath</span></div>
        <div class="auth-copy">
          <p class="eyebrow">Your preparation, with direction</p>
          <h1>Turn ambition into a <span>daily plan.</span></h1>
          <p>A focused workspace for planning, learning, practice, and progress—built around the exam that matters to you.</p>
        </div>
        <div class="proof-row">
          <div class="proof"><strong>12-day</strong><span>average study streak</span></div>
          <div class="proof"><strong>84%</strong><span>plan completion</span></div>
          <div class="proof"><strong>One place</strong><span>from syllabus to score</span></div>
        </div>
      </div>
      <div class="auth-panel">
        <form class="signin-card" id="signinForm">
          <span class="badge green">Free interactive demo</span>
          <h2>Welcome back</h2>
          <p>Sign in to continue your preparation.</p>
          <div class="stack">
            <div class="field"><label for="email">Email address</label><input class="input" id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
            <div class="field"><div class="row-between"><label for="password">Password</label><button class="link-button" type="button" data-action="forgot-password">Forgot password?</button></div><input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="Any password works" minlength="4" required></div>
            <button class="btn btn-primary btn-block" type="submit">Sign in ${icon('→')}</button>
          </div>
          <div class="or">or continue with</div>
          <button class="btn btn-google btn-block" type="button" data-action="google-login"><span class="google-mark" aria-hidden="true">G</span> Continue with Google</button>
          <button class="btn btn-accent btn-block" type="button" data-action="demo-login">Use demo account</button>
          <div class="demo-note">${icon('⌁')}<span>No account or network needed. Prototype data is stored only in this browser.</span></div>
        </form>
      </div>
    </section>`;
  }

  function onboardingTemplate() {
    const step = state.onboardingStep;
    let content = '';
    if (step === 1) {
      content = `<h1>What are you preparing for?</h1><p>Choose your primary exam. You can switch or add another one later.</p>
        <div class="exam-options">${exams.map(exam => `<button class="choice-card${state.exam === exam.name ? ' selected' : ''}" data-action="select-exam" data-exam="${esc(exam.name)}" type="button"><span class="choice-icon" aria-hidden="true">${exam.icon}</span><strong>${esc(exam.name)}</strong><span class="muted">Structured plan included</span></button>`).join('')}</div>`;
    } else if (step === 2) {
      content = `<h1>Set your target date</h1><p>We’ll work backwards to create a realistic preparation timeline.</p>
        <div class="card card-pad stack"><div class="field"><label for="examDate">Expected exam date</label><input class="input" type="date" id="examDate" value="${esc(state.examDate)}" min="${demoTodayIso}" required></div><div class="demo-note">${icon('◷')}<span><strong>${daysUntilExam()} days to go.</strong> That’s enough time for a focused plan with revision cycles.</span></div></div>`;
    } else {
      const subjects = currentExam().subjects;
      content = `<h1>Shape your daily plan</h1><p>Tell us your study capacity and where you need the most support.</p>
        <div class="card card-pad stack">
          <div class="range-wrap"><span class="field-label">Daily study target</span><output class="hours-output" id="hoursOutput">${state.dailyHours} hours</output><input class="range" id="hoursRange" type="range" min="1" max="8" value="${state.dailyHours}" aria-label="Daily study hours"><div class="row-between muted"><span>1 hour</span><span>8 hours</span></div></div>
          <div class="divider"></div><span class="field-label">Subjects that need attention</span><div class="chip-options">${subjects.map(subject => `<button type="button" class="check-chip${state.weakSubjects.includes(subject) ? ' selected' : ''}" data-action="toggle-weak" data-subject="${esc(subject)}">${esc(subject)}</button>`).join('')}</div>
        </div>`;
    }
    return `<section class="onboarding">
      <aside class="onboarding-side"><div class="logo light"><span class="logo-mark">P</span><span>PrepPath</span></div><h2>A plan built around your life.</h2><p>Three quick steps. Change anything later in settings.</p><div class="step-list">${['Choose exam', 'Set target', 'Personalise plan'].map((label, index) => `<div class="step-item${step === index + 1 ? ' active' : ''}"><span class="step-number">${index + 1}</span><span>${label}</span></div>`).join('')}</div></aside>
      <main class="onboarding-main"><div class="onboarding-top"><button class="link-button" data-action="skip-onboarding">Skip &amp; load demo data</button></div><div class="onboarding-card">${content}<div class="onboarding-actions"><button class="btn btn-ghost" data-action="onboarding-back" ${step === 1 ? 'disabled' : ''}>${icon('←')} Back</button><button class="btn btn-primary" data-action="onboarding-next">${step === 3 ? 'Build my plan' : 'Continue'} ${icon('→')}</button></div></div></main>
    </section>`;
  }

  const navItems = [
    ['home', '⌂', 'Home'], ['planner', '▦', 'Planner'], ['syllabus', '☷', 'Syllabus'], ['learn', '▷', 'Learn'], ['practice', '✎', 'Practice'], ['progress', '↗', 'Progress'], ['profile', '○', 'Profile']
  ];

  function renderProduct() {
    applyTheme();
    el.auth.innerHTML = '';
    el.product.hidden = false;
    const [route = 'home', subroute] = routeParts();
    const safeRoute = navItems.some(item => item[0] === route) ? route : 'home';
    if (safeRoute !== route) { go('home'); return; }
    if (safeRoute === 'planner' && subroute) state.plannerTab = subroute;
    if (safeRoute === 'practice' && subroute) state.practiceView = subroute;
    if (safeRoute === 'learn' && subroute) state.learnView = subroute;
    el.sidebar.innerHTML = sidebarTemplate(safeRoute);
    el.topbar.innerHTML = topbarTemplate();
    el.mobileNav.innerHTML = mobileNavTemplate(safeRoute);
    const renderers = { home: renderHome, planner: renderPlanner, syllabus: renderSyllabus, learn: renderLearn, practice: renderPractice, progress: renderProgress, profile: renderProfile };
    el.screen.innerHTML = renderers[safeRoute]();
    el.screen.dataset.route = safeRoute;
    document.title = `${navItems.find(item => item[0] === safeRoute)[2]} — PrepPath`;
    persist();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function sidebarTemplate(active) {
    return `<div class="logo light"><span class="logo-mark">P</span><span>PrepPath</span></div><nav class="sidebar-nav" aria-label="Primary">${navItems.map(([route, symbol, label]) => `<a class="nav-link${active === route ? ' active' : ''}" href="#/${route}" ${active === route ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-goal"><p>DAILY GOAL</p><strong>${state.studyMinutes} / ${state.dailyHours * 60} minutes</strong><div class="mini-progress"><span data-width="${Math.min(100, Math.round(state.studyMinutes / (state.dailyHours * 60) * 20) * 5)}"></span></div></div></div>`;
  }
  function mobileNavTemplate(active) {
    return navItems.map(([route, symbol, label]) => `<a class="nav-link${active === route ? ' active' : ''}" href="#/${route}" ${active === route ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('');
  }
  function topbarTemplate() {
    return `<div class="topbar-left"><a class="logo mobile-logo" href="#/home" aria-label="PrepPath home"><span class="logo-mark">P</span><span class="logo-word">PrepPath</span></a><select class="exam-switch" id="examSwitcher" aria-label="Switch exam">${exams.map(exam => `<option${exam.name === state.exam ? ' selected' : ''}>${esc(exam.name)}</option>`).join('')}</select></div><div class="topbar-actions"><button class="search-trigger" data-action="open-command" aria-label="Search and navigate">${icon('⌕')}<span>Search anything…</span><kbd>⌘ K</kbd></button><button class="btn btn-icon theme-button" data-action="toggle-theme" aria-label="Switch to ${state.settings.theme === 'dark' ? 'light' : 'dark'} theme">${icon(state.settings.theme === 'dark' ? '☀' : '☾')}</button><button class="btn btn-icon" data-action="open-notifications" aria-label="Notifications">${icon('♧')}${state.notificationsRead ? '' : '<span class="notification-dot"></span>'}</button><button class="avatar" data-action="go-profile" aria-label="Open profile">${esc(state.profile.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase())}</button></div>`;
  }

  function pageHead(eyebrow, title, copy, actions = '') {
    return `<div class="page-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h1 class="section-title">${esc(title)}</h1><p class="section-copy">${esc(copy)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
  }

  function renderHome() {
    const completed = state.tasks.filter(task => task.done).length;
    const firstName = state.profile.name.split(/\s+/)[0] || 'Learner';
    const weakAreaButtons = state.weakSubjects.slice(0, 2).map((subject, index) => index === 0 ? `<button data-action="study-topic" data-topic="${esc(subject)}"><strong>${esc(subject)}</strong><span>58% accuracy · Study next</span></button>` : `<button data-action="start-subject-quiz" data-subject="${esc(subject)}"><strong>${esc(subject)}</strong><span>64% accuracy · Practise</span></button>`).join('');
    return `${pageHead('Dashboard', `Good morning, ${esc(firstName)}`, 'Your plan is focused. Start with the highest-impact task.', `<button class="btn btn-ghost" data-action="open-add-task">${icon('+')} Add task</button><button class="btn btn-primary" data-action="open-focus-modal">${icon('▶')} Focus now</button>`)}
      <section class="card hero-card"><div><p class="eyebrow">${daysUntilExam()} days until ${esc(state.exam)}</p><h1>Consistency today makes exam day feel familiar.</h1><p>You’re ahead of this week’s target. Complete two more focused blocks to keep the momentum.</p></div><div class="hero-action"><button class="btn btn-accent" data-action="continue-plan">Continue today’s plan ${icon('→')}</button></div></section>
      <div class="grid grid-4 home-stats"><article class="card stat-card"><span class="stat-label">Study streak</span><div class="stat-value">${state.streak} days</div><div class="stat-trend">↑ Personal best</div></article><article class="card stat-card"><span class="stat-label">Today’s focus</span><div class="stat-value">${Math.floor(state.studyMinutes / 60)}h ${state.studyMinutes % 60}m</div><div class="stat-trend">${Math.min(100, Math.round(state.studyMinutes / (state.dailyHours * 60) * 100))}% of daily goal</div></article><article class="card stat-card"><span class="stat-label">Questions this week</span><div class="stat-value">284</div><div class="stat-trend">↑ 18% from last week</div></article><article class="card stat-card"><span class="stat-label">Average accuracy</span><div class="stat-value">76%</div><div class="stat-trend">↑ 4% this month</div></article></div>
      <div class="grid home-layout"><div class="stack"><section class="card card-pad"><div class="card-head"><div><h2>Today’s plan</h2><span class="muted">${completed} of ${state.tasks.length} complete</span></div><button class="link-button" data-action="view-planner">View planner</button></div><div class="task-list">${state.tasks.map(task => taskTemplate(task)).join('')}</div></section><section class="card card-pad"><div class="card-head"><h2>Study time this week</h2><span class="badge green">14h 20m</span></div><div class="chart compact-chart" aria-label="Study time for the past seven days">${[['Mon',48],['Tue',68],['Wed',55],['Thu',84],['Fri',62],['Sat',76],['Sun',42]].map(([day,height]) => `<div class="chart-col"><div class="chart-bar" data-height="${height}"></div><span>${day}</span></div>`).join('')}</div></section><section class="card card-pad"><div class="card-head"><h2>Subject progress</h2><button class="link-button" data-action="view-syllabus">Full syllabus</button></div><div class="stack">${subjectProgressRows()}</div></section></div>
      <aside class="stack"><section class="card card-pad"><div class="card-head"><h2>Exam readiness</h2><span class="badge green">On track</span></div><div class="readiness"><div class="progress-ring"><strong>72%</strong></div><p class="muted">Strong foundation. Prioritise General Awareness this week.</p><button class="btn btn-soft btn-block" data-action="view-progress">View insights</button></div></section><section class="card card-pad"><div class="card-head"><h2>Weak areas</h2><span class="badge red">3 priorities</span></div><div class="insight-list">${weakAreaButtons}</div></section><section class="card card-pad"><div class="card-head"><h2>Next mock</h2><span class="badge navy">Sunday</span></div><strong>${esc(state.exam.replace(/\s+2026$/, ''))} Full Mock 08</strong><p class="muted">100 questions · 60 minutes</p><button class="btn btn-primary btn-block" data-action="open-mocks">View mock details</button></section><section class="card card-pad"><div class="card-head"><h2>28-day activity</h2><span class="badge lime">${state.streak} day streak</span></div><div class="activity" aria-label="Study activity heatmap">${Array.from({ length: 28 }, (_, i) => `<span class="${i % 7 === 0 ? 'a3' : i % 3 === 0 ? 'a2' : i % 2 === 0 ? 'a1' : ''}" title="${i % 4 + 1} study sessions"></span>`).join('')}</div></section></aside></div>`;
  }
  function taskTemplate(task) {
    return `<div class="task-item${task.done ? ' done' : ''}"><button class="task-check" data-action="toggle-task" data-id="${task.id}" aria-label="${task.done ? 'Mark incomplete' : 'Mark complete'}">${task.done ? '✓' : ''}</button><div><div class="task-title">${esc(task.title)}</div><div class="task-meta">${esc(task.time)} · ${esc(task.subject)}</div></div><span class="badge ${task.subject === 'GK' ? 'navy' : 'green'}">${esc(task.subject)}</span></div>`;
  }
  function subjectProgressRows() {
    const palette = ['green', 'blue', 'lime', 'orange'];
    const amounts = [68, 84, 78, 42];
    return currentExam().subjects.slice(0, 4).map((name, index) => `<div class="subject-row"><span>${esc(name)}</span><div class="progress-track"><div class="progress-fill ${palette[index]}" data-width="${amounts[index]}"></div></div><strong>${amounts[index]}%</strong></div>`).join('');
  }

  function renderPlanner() {
    const tabs = [['today', 'Today'], ['week', 'Week'], ['calendar', 'Calendar'], ['kanban', 'Kanban'], ['revision', 'Revision'], ['timer', 'Focus']];
    const tab = tabs.some(item => item[0] === state.plannerTab) ? state.plannerTab : 'today';
    return `${pageHead('Study planner', 'Plan the work. Work the plan.', 'Balance focused study, practice, and spaced revision.', `<button class="btn btn-accent" data-action="open-plan-setup">${icon('↻')} Setup or regenerate plan</button><button class="btn btn-ghost" data-action="open-focus-modal">${icon('◷')} Open Pomodoro</button><button class="btn btn-ghost" data-action="open-add-task">${icon('+')} Add task</button><button class="btn btn-primary" data-action="open-add-session">${icon('▣')} Schedule session</button>`)}<div class="tabs" role="tablist" aria-label="Planner views">${tabs.map(([id, label]) => `<button class="tab${tab === id ? ' active' : ''}" role="tab" aria-selected="${tab === id}" data-action="planner-tab" data-tab="${id}">${label}</button>`).join('')}</div>${plannerContent(tab)}`;
  }
  function plannerContent(tab) {
    const calendarDate = new Date(demoToday.getFullYear(), demoToday.getMonth() + state.calendarOffset, 1);
    const calendarLabel = calendarDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const todaySessions = state.sessions.filter(session => session.date === demoTodayIso);
    if (tab === 'today') return `<section class="card card-pad"><div class="card-head"><div><h2>Today’s generated plan</h2><span class="muted">${todaySessions.reduce((total, session) => total + session.duration, 0)} minutes planned · ${state.planIntensity} intensity</span></div><span class="badge green">Balanced day</span></div><div class="timeline">${todaySessions.length ? todaySessions.map(session => `<div class="time-row"><span class="time-label">${esc(session.time)}</span><div class="time-slot"><div class="session-block ${esc(session.tone || '')}"><strong>${esc(session.title)}</strong><div>${esc(session.subject)} · ${session.duration} min</div></div></div></div>`).join('') : '<div class="empty"><h3>No sessions today</h3><p>Schedule a session or regenerate your plan.</p></div>'}</div></section>`;
    if (tab === 'week') {
      const weekStart = new Date(demoToday);
      weekStart.setDate(demoToday.getDate() - ((demoToday.getDay() + 6) % 7));
      const weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
      const rangeLabel = `${weekDays[0].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}–${weekDays[6].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
      const weekStartIso = localIso(weekDays[0]);
      const weekEndIso = localIso(weekDays[6]);
      const weekMinutes = state.sessions.filter(session => session.date >= weekStartIso && session.date <= weekEndIso).reduce((total, session) => total + session.duration, 0);
      return `<section class="card card-pad"><div class="card-head"><h2>${rangeLabel}</h2><span class="badge green">${Math.round(weekMinutes / 60)}h planned</span></div><div class="week-grid">${weekDays.map(date => { const iso = localIso(date); const sessions = state.sessions.filter(session => session.date === iso); return `<div class="day-column${iso === demoTodayIso ? ' today' : ''}"><div class="day-head"><span>${date.toLocaleDateString('en-IN', { weekday: 'short' })}</span><strong>${date.getDate()}</strong></div>${sessions.length ? sessions.map(session => `<div class="mini-session">${esc(session.subject)} · ${session.duration}m</div>`).join('') : '<div class="empty">No sessions</div>'}</div>`; }).join('')}</div></section>`;
    }
    if (tab === 'calendar') {
      const year = calendarDate.getFullYear();
      const month = calendarDate.getMonth();
      const leading = (new Date(year, month, 1).getDay() + 6) % 7;
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      return `<section class="card card-pad"><div class="calendar-head"><button class="btn btn-icon" data-action="calendar-prev" aria-label="Previous month">←</button><h2>${calendarLabel}</h2><button class="btn btn-icon" data-action="calendar-next" aria-label="Next month">→</button></div><div class="calendar-grid">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<div class="calendar-cell muted-day"><strong>${day}</strong></div>`).join('')}${Array.from({ length: 42 }, (_, index) => { const day = index - leading + 1; const valid = day > 0 && day <= daysInMonth; const date = valid ? new Date(year, month, day) : null; const iso = date ? localIso(date) : ''; const events = valid ? state.sessions.filter(session => session.date === iso) : []; return `<div class="calendar-cell${!valid ? ' muted-day' : ''}${iso === demoTodayIso ? ' today' : ''}">${valid ? day : ''}${events.map(session => `<div class="calendar-event">${esc(session.title)}</div>`).join('')}</div>`; }).join('')}</div></section>`;
    }
    if (tab === 'kanban') return `<div class="kanban">${[['todo', 'To do'], ['progress', 'In progress'], ['done', 'Completed']].map(([status, label]) => { const items = state.kanbanTasks.filter(task => task.status === status); return `<section class="kanban-col"><div class="kanban-head"><span>${label}</span><span class="badge${status === 'done' ? ' green' : ''}">${items.length}</span></div>${items.length ? items.map(kanbanCard).join('') : '<div class="empty">No tasks here</div>'}</section>`; }).join('')}</div>`;
    if (tab === 'revision') { const cards = [['Percentage shortcuts', 'Due today', 'Last reviewed 7 days ago · Quant'], ['Fundamental Rights', 'Tomorrow', 'Last reviewed 14 days ago · GK'], ['Sentence correction rules', 'In 3 days', 'Last reviewed 21 days ago · English']]; return `<div class="grid grid-2"><section class="stack">${cards.map(([topic, due, meta], index) => `<article class="card revision-card"><div class="revision-date"><span>APR</span><strong>${14 + index * (index || 1)}</strong></div><div><span class="badge${index === 0 ? ' red' : index === 1 ? ' lime' : ''}">${due}</span><h3>${topic}</h3><span class="muted">${meta}</span>${state.revisionFeedback[topic] ? `<div class="feedback-status">Last response: ${state.revisionFeedback[topic]}</div>` : ''}</div><div class="revision-actions"><button class="btn btn-sm btn-soft" data-action="revision-feedback" data-topic="${topic}" data-result="remembered">Remembered</button><button class="btn btn-sm btn-ghost" data-action="revision-feedback" data-topic="${topic}" data-result="forgot">Forgot</button></div></article>`).join('')}</section><aside class="card card-pad"><div class="card-head"><h2>Revision health</h2><span class="badge green">Good</span></div><div class="readiness"><div class="progress-ring"><strong>81%</strong></div><p class="muted">12 topics are current. 3 are due this week.</p></div><div class="divider"></div><button class="btn btn-soft btn-block" data-action="auto-plan-revision">Auto-plan this week</button></aside></div>`; }
    return `<div class="grid grid-2"><section class="card timer-card"><p class="eyebrow">Pomodoro focus</p><h2>${state.timerRunning ? 'Stay with it.' : 'Ready when you are.'}</h2><div class="timer-display" id="timerDisplay">${formatTime(state.timerSeconds)}</div><div class="timer-controls"><button class="btn btn-accent" data-action="timer-toggle">${state.timerRunning ? 'Pause' : 'Start'} ${icon(state.timerRunning ? 'Ⅱ' : '▶')}</button><button class="btn btn-ghost" data-action="timer-reset">Reset</button></div></section><section class="card card-pad"><div class="card-head"><h2>Focus queue</h2><button class="link-button" data-action="open-add-task">Add</button></div><div class="task-list">${state.tasks.filter(task => !task.done).slice(0,3).map(taskTemplate).join('')}</div><div class="divider"></div><div class="row-between"><span class="muted">Today’s focused time</span><strong>${Math.floor(state.studyMinutes / 60)}h ${state.studyMinutes % 60}m</strong></div></section></div>`;
  }
  function kanbanCard(task) { const next = task.status === 'todo' ? 'In progress' : task.status === 'progress' ? 'Completed' : 'To do'; return `<article class="kanban-card"><span class="badge green">${esc(task.subject)}</span><h4>${esc(task.title)}</h4><p>${esc(task.meta)}</p><button class="link-button" data-action="kanban-move" data-id="${task.id}">Move to ${next} →</button></article>`; }
  function formatTime(total) { const min = Math.floor(total / 60).toString().padStart(2, '0'); const sec = (total % 60).toString().padStart(2, '0'); return `${min}:${sec}`; }

  const topicBank = {
    'Quantitative Aptitude': ['Number System', 'Percentages', 'Profit and Loss', 'Time and Work', 'Algebra'],
    'English': ['Reading Comprehension', 'Vocabulary', 'Grammar', 'Sentence Correction'],
    'Reasoning': ['Analogy', 'Series', 'Coding-Decoding', 'Seating Arrangement'],
    'General Awareness': ['Indian Polity', 'History', 'Geography', 'Current Affairs'],
    'Elementary Mathematics': ['Number System', 'Ratio and Proportion', 'Mensuration', 'Data Interpretation'],
    'English or Hindi': ['Comprehension', 'Vocabulary', 'Grammar', 'Language Usage'],
    'General Knowledge': ['History', 'Geography', 'Science', 'Current Affairs'],
    'Mathematics': ['Arithmetic', 'Algebra', 'Geometry', 'Data Interpretation'],
    'General Intelligence': ['Analogy', 'Series', 'Coding-Decoding', 'Puzzles'],
    'Banking Awareness': ['Banking Basics', 'Financial Awareness', 'Economy', 'Current Affairs'],
    'General Studies I': ['History', 'Geography', 'Society', 'Current Affairs'],
    'General Studies II': ['Polity', 'Governance', 'Social Justice', 'International Relations'],
    'Essay': ['Essay Structure', 'Argument Building', 'Examples', 'Timed Writing'],
    'General Studies': ['History', 'Polity', 'Geography', 'Economy'],
    'Bihar Studies': ['Bihar History', 'Bihar Geography', 'Bihar Economy', 'Bihar Current Affairs'],
    'General Hindi': ['Grammar', 'Comprehension', 'Vocabulary', 'Precis Writing'],
    'Current Affairs': ['National Events', 'International Events', 'Economy Updates', 'Science Updates']
  };
  function getSyllabusData() {
    const symbols = ['∑', 'A', '◇', '◎'];
    const progress = [68, 84, 78, 42];
    return currentExam().subjects.map((subject, index) => [subject, symbols[index] || '•', topicBank[subject] || [`${subject} basics`, `${subject} concepts`, `${subject} practice`, `${subject} revision`], progress[index] || 50]);
  }
  function renderSyllabus() {
    const syllabusData = getSyllabusData();
    const query = state.syllabusSearch.trim().toLowerCase();
    const filtered = syllabusData.map(([name, symbol, topics, progress]) => {
      const matchingTopics = topics.filter(topic => {
        const matchesQuery = !query || name.toLowerCase().includes(query) || topic.toLowerCase().includes(query);
        const complete = state.completedTopics.includes(topic);
        const matchesStatus = state.syllabusStatus === 'all' || (state.syllabusStatus === 'complete' ? complete : !complete);
        return matchesQuery && matchesStatus;
      });
      return [name, symbol, matchingTopics, progress];
    }).filter(([name, , topics]) => (state.syllabusSubject === 'all' || name === state.syllabusSubject) && topics.length);
    const syllabusTopics = syllabusData.flatMap(item => item[2]);
    const totalTopics = syllabusTopics.length;
    const coveredCount = syllabusTopics.filter(topic => state.completedTopics.includes(topic)).length;
    const coverage = Math.round(coveredCount / totalTopics * 100);
    return `${pageHead('Syllabus tracker', `${esc(state.exam)} syllabus`, 'Search, filter, bookmark, and track every topic.', `<button class="btn btn-ghost" data-action="download-syllabus">${icon('↓')} Export</button><button class="btn btn-primary" data-action="create-syllabus-plan">Create study plan</button>`)}
      <section class="card filter-bar" aria-label="Syllabus filters"><div class="field filter-search"><label for="syllabusSearch">Search topics</label><input class="input" id="syllabusSearch" type="search" value="${esc(state.syllabusSearch)}" placeholder="Search percentages, polity…"></div><div class="field"><label for="syllabusSubject">Subject</label><select class="select" id="syllabusSubject"><option value="all">All subjects</option>${syllabusData.map(([name]) => `<option value="${esc(name)}"${state.syllabusSubject === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></div><div class="field"><label for="syllabusStatus">Status</label><select class="select" id="syllabusStatus"><option value="all">All statuses</option><option value="complete"${state.syllabusStatus === 'complete' ? ' selected' : ''}>Complete</option><option value="incomplete"${state.syllabusStatus === 'incomplete' ? ' selected' : ''}>Not complete</option></select></div></section>
      <div class="grid syllabus-layout"><section class="stack">${filtered.length ? filtered.map(([name, symbol, topics, progress]) => syllabusSubject(name, symbol, topics, progress, Boolean(query) || state.syllabusStatus !== 'all')).join('') : '<div class="card empty"><div class="empty-icon">⌕</div><h3>No matching topics</h3><p>Try a different search or filter.</p></div>'}</section><aside class="stack"><section class="card card-pad"><div class="card-head"><h2>Overall coverage</h2><span class="badge green">${coverage}%</span></div><div class="readiness"><div class="progress-ring"><strong>${coverage}%</strong></div><p class="muted">${coveredCount} of ${totalTopics} core topics covered</p></div></section><section class="card card-pad"><h3>Bookmarked topics</h3><p class="muted">${state.bookmarkedTopics.length} saved for quick review.</p><div class="bookmark-summary">${state.bookmarkedTopics.slice(0, 4).map(topic => `<button data-action="study-topic" data-topic="${esc(topic)}">☆ ${esc(topic)}</button>`).join('') || '<span class="muted">Bookmark a topic to see it here.</span>'}</div></section><section class="card card-pad"><h3>Recommended next</h3><p class="muted">Current Affairs has high exam weight and the lowest coverage.</p><button class="btn btn-accent btn-block" data-action="learn-current-affairs">Start Current Affairs</button></section></aside></div>`;
  }
  function syllabusSubject(name, symbol, topics, progress, forceOpen = false) {
    const open = forceOpen || state.expandedSubjects.includes(name);
    const completed = topics.filter(topic => state.completedTopics.includes(topic)).length;
    return `<article class="card subject-card"><button class="subject-head" data-action="toggle-subject" data-subject="${esc(name)}" aria-expanded="${open}"><span class="subject-icon">${symbol}</span><span><span class="subject-name">${esc(name)}</span><span class="subject-stats">${completed} of ${topics.length} shown topics complete</span></span><span class="badge green">${progress}%</span><span aria-hidden="true">${open ? '−' : '+'}</span></button>${open ? `<div class="topic-list">${topics.map(topic => { const bookmarked = state.bookmarkedTopics.includes(topic); return `<div class="topic-row"><button class="topic-check${state.completedTopics.includes(topic) ? ' complete' : ''}" data-action="toggle-topic" data-topic="${esc(topic)}" aria-label="Toggle ${esc(topic)}">${state.completedTopics.includes(topic) ? '✓' : ''}</button><span>${esc(topic)}</span><div class="topic-actions"><button class="bookmark-button${bookmarked ? ' active' : ''}" data-action="toggle-bookmark" data-topic="${esc(topic)}" aria-label="${bookmarked ? 'Remove bookmark from' : 'Bookmark'} ${esc(topic)}">${bookmarked ? '★' : '☆'}</button><button class="link-button" data-action="study-topic" data-topic="${esc(topic)}">Study</button></div></div>`; }).join('')}</div>` : ''}</article>`;
  }

  function renderLearn() {
    if (state.learnView === 'player') return renderPlayer();
    const courseStyles = [['▥', 'green'], ['A', 'navy'], ['⌂', 'lime'], ['◇', 'green']];
    const courses = currentExam().subjects.map((subject, index) => [courseStyles[index][0], subject, `${subject} essentials`, `${10 + index * 2} lessons · ${3 + index}h ${10 + index * 5}m`, courseStyles[index][1]]);
    const query = state.learnSearch.trim().toLowerCase();
    const visible = courses.filter(course => (state.learnSubject === 'all' || course[1] === state.learnSubject) && (!query || `${course[1]} ${course[2]}`.toLowerCase().includes(query)));
    return `${pageHead('Learning library', 'Learn concepts that stick.', 'Search lessons, build playlists, and resume where you left off.', `<button class="btn btn-ghost" data-action="show-downloads">${icon('↓')} Downloads</button><button class="btn btn-primary" data-action="resume-lesson">Resume lesson</button>`)}
      <section class="card filter-bar" aria-label="Video filters"><div class="field filter-search"><label for="learnSearch">Search videos</label><input class="input" id="learnSearch" type="search" value="${esc(state.learnSearch)}" placeholder="Search lessons and topics"></div><div class="field"><label for="learnSubject">Subject</label><select class="select" id="learnSubject"><option value="all">All subjects</option>${currentExam().subjects.map(subject => `<option${state.learnSubject === subject ? ' selected' : ''}>${esc(subject)}</option>`).join('')}</select></div></section>
      <section class="card featured-course"><div><span class="badge lime">Continue learning · ${state.videoProgress}%</span><h2>Master percentages in 6 focused lessons</h2><p>Build intuition, learn time-saving methods, and practise exam-level applications.</p><button class="btn btn-accent" data-action="resume-lesson" data-topic="Percentages">Resume lesson 4 ${icon('→')}</button></div><div class="course-art" aria-hidden="true">%</div></section>
      <section class="playlist-section"><div class="card-head"><div><h2>Your playlists</h2><span class="muted">Personal study queues saved in this browser</span></div><button class="btn btn-soft" data-action="create-playlist">${icon('+')} Create playlist</button></div><div class="grid grid-3">${state.playlists.map(list => `<article class="card playlist-card"><span class="playlist-icon">▶</span><div><h3>${esc(list.name)}</h3><span class="muted">${list.lessons} lessons</span></div><button class="link-button" data-action="open-playlist" data-id="${list.id}">Open</button></article>`).join('')}</div></section>
      <div class="card-head"><h2>Video library</h2><span class="badge">${visible.length} results</span></div><div class="grid grid-3">${visible.length ? visible.map(course => courseCard(...course)).join('') : '<div class="card empty"><div class="empty-icon">⌕</div><h3>No videos found</h3><p>Try another search or subject.</p></div>'}</div><div class="grid grid-2"><section class="card card-pad"><div class="card-head"><h2>Quick revision notes</h2><span class="badge">12 saved</span></div><div class="stack"><button class="lesson-item" data-action="open-notes" data-topic="Percentages"><span class="lesson-number">01</span><span>Percentage conversion table</span><span>4 min</span></button><button class="lesson-item" data-action="open-notes" data-topic="Indian Polity"><span class="lesson-number">02</span><span>Articles 12–35 at a glance</span><span>7 min</span></button></div></section><section class="card card-pad"><div class="card-head"><h2>Your learning goal</h2><span class="badge green">4 / 5 lessons</span></div><p class="muted">One more lesson completes this week’s goal.</p><div class="progress-track"><div class="progress-fill" data-width="84"></div></div><div class="divider"></div><button class="btn btn-soft btn-block" data-action="resume-lesson">Complete weekly goal</button></section></div>`;
  }
  function learningNote(topic) {
    const key = topic.toLowerCase();
    if (key.includes('percentage')) return { title: 'Percentage change', body: 'Convert the percentage to a multiplier: increase by p% means × (1 + p/100), while a decrease means × (1 − p/100). For successive changes, multiply the factors rather than adding percentages.' };
    if (key.includes('current affair')) return { title: 'Current Affairs recall method', body: 'Organise each event as Who, What, Where, When, and Why it matters. Link it to the relevant ministry, institution, report, or constitutional context before spaced recall.' };
    if (key.includes('number system')) return { title: 'Number System toolkit', body: 'Start with divisibility, factors, multiples, HCF, and LCM. For remainder questions, reduce large values with modular patterns before calculating.' };
    if (key.includes('polity') || key.includes('right') || key.includes('constitution')) return { title: 'Polity article map', body: 'Anchor each provision to its Article, purpose, exceptions, and one landmark case or institutional example. Compare similar constitutional bodies in a table.' };
    if (key.includes('grammar') || key.includes('english') || key.includes('sentence')) return { title: 'Language error checklist', body: 'Check subject–verb agreement, tense consistency, pronouns, modifiers, parallelism, and prepositions in that order before choosing an answer.' };
    if (key.includes('reason') || key.includes('analogy') || key.includes('series')) return { title: 'Reasoning pattern scan', body: 'Test differences, ratios, alternating positions, squares, and primes systematically. Reject a pattern unless it explains every transition.' };
    return { title: `${topic} exam framework`, body: `Break ${topic} into definition, core rules, one worked example, common traps, and a timed practice set. Finish by recalling the method without notes.` };
  }
  function courseCard(symbol, subject, title, meta, color) { return `<article class="card course-card"><div class="course-thumb ${color}">${symbol}</div><div class="course-body"><span class="badge green">${subject}</span><h3>${title}</h3><div class="row-between"><span class="muted">${meta}</span><button class="link-button" data-action="open-course" data-topic="${esc(title)}" data-subject="${esc(subject)}">Open →</button></div></div></article>`; }
  function renderPlayer() {
    const topic = state.selectedLearningTopic || 'Percentages';
    const lessons = [`Understanding ${topic}`, `${topic}: core concepts`, `Worked examples for ${topic}`, `${topic} exam methods`, `Timed ${topic} practice`, `${topic} recap and revision`];
    return `${pageHead('Learning player', topic, `${topic} · Lesson ${state.activeLesson + 1} of 6`, `<button class="btn btn-ghost" data-action="back-library">← Library</button><button class="btn btn-primary" data-action="mark-lesson">Mark complete</button>`)}<div class="grid video-layout"><section><div class="video-stage${state.videoPlaying ? ' playing' : ''}" id="videoStage"><div class="video-visual" aria-hidden="true">${state.videoProgress}%</div><button class="play-button" data-action="toggle-video" aria-label="${state.videoPlaying ? 'Pause' : 'Play'} lesson">${state.videoPlaying ? 'Ⅱ' : '▶'}</button><div class="video-controls"><button data-action="video-skip" data-amount="-10" aria-label="Go back 10 seconds">−10</button><label for="videoSeek">Lesson progress</label><input id="videoSeek" type="range" min="0" max="100" value="${state.videoProgress}" aria-label="Seek lesson"><span id="videoProgressLabel">${state.videoProgress}%</span><button data-action="video-skip" data-amount="10" aria-label="Go forward 10 seconds">+10</button></div></div><div class="card card-pad"><span class="badge green">Lesson ${state.activeLesson + 1}</span><h2>${esc(lessons[state.activeLesson])}</h2><p class="muted">Understand the method with a visual walkthrough, then test it with three quick checks.</p><div class="page-actions"><button class="btn btn-soft" data-action="open-notes">${icon('☷')} Lesson notes</button><button class="btn btn-ghost" data-action="save-lesson">${icon(state.savedLessons.includes(state.activeLesson) ? '★' : '☆')} ${state.savedLessons.includes(state.activeLesson) ? 'Saved' : 'Save lesson'}</button><button class="btn btn-ghost" data-action="share-lesson">${icon('↗')} Share</button></div></div></section><aside class="card"><div class="card-pad"><div class="card-head"><h2>Course content</h2><span class="badge">${state.videoProgress}%</span></div><div class="progress-track"><div class="progress-fill video-progress-fill" data-width="${Math.round(state.videoProgress / 5) * 5}"></div></div></div>${lessons.map((lesson, index) => `<button class="lesson-item${state.activeLesson === index ? ' active' : ''}" data-action="select-lesson" data-index="${index}"><span class="lesson-number">${state.completedLessons.includes(index) ? '✓' : index + 1}</span><span>${esc(lesson)}</span><span>${6 + index}m</span></button>`).join('')}</aside></div>`;
  }

  function practiceNav(active = state.practiceView) {
    const items = [['saved', 'Saved'], ['dashboard', 'Quizzes'], ['mocks', 'Mock tests'], ['history', 'History']];
    return `<div class="tabs practice-nav" role="tablist" aria-label="Practice views">${items.map(([view, label]) => `<button class="tab${active === view ? ' active' : ''}" data-action="practice-tab" data-view="${view}" role="tab" aria-selected="${active === view}">${label}</button>`).join('')}</div>`;
  }
  function renderPractice() {
    if (state.practiceView === 'quiz') return renderQuiz();
    if (state.practiceView === 'results') return renderQuizResults();
    if (state.practiceView === 'review') return renderQuizReview();
    if (state.practiceView === 'saved') return renderSaved();
    if (state.practiceView === 'mocks') return renderMocks();
    if (state.practiceView === 'history') return renderHistory();
    const recommendations = [
      { subject: 'General Awareness', title: 'General Awareness', accuracy: 58 },
      { subject: 'Quantitative Aptitude', title: 'Time and Work', accuracy: 64 },
      { subject: 'English', title: 'Sentence Correction', accuracy: 69 }
    ].filter(item => state.practiceFilter === 'all' || item.subject === state.practiceFilter);
    return `${pageHead('Practice centre', 'Practise with purpose.', 'Target weak areas, simulate exam pressure, and learn from every answer.', `<button class="btn btn-primary" data-action="start-quiz">Start quick quiz</button>`)}${practiceNav('dashboard')}<section class="card filter-bar practice-filters" aria-label="Practice filters"><div class="field"><label for="practiceFilter">Filter quizzes</label><select class="select" id="practiceFilter"><option value="all">All subjects</option><option value="General Awareness"${state.practiceFilter === 'General Awareness' ? ' selected' : ''}>General Awareness</option><option value="Quantitative Aptitude"${state.practiceFilter === 'Quantitative Aptitude' ? ' selected' : ''}>Quantitative Aptitude</option><option value="English"${state.practiceFilter === 'English' ? ' selected' : ''}>English</option></select></div><span class="muted">Showing recommendations for ${state.practiceFilter === 'all' ? 'all subjects' : esc(state.practiceFilter)}</span></section><div class="grid practice-actions"><button class="action-card" data-action="start-quiz"><span class="choice-icon">⚡</span><h3>Quick quiz</h3><p>5 adaptive questions · About 6 minutes</p></button><button class="action-card" data-action="open-mocks"><span class="choice-icon">⌛</span><h3>Mock tests</h3><p>Full-length and sectional exam simulations</p></button><button class="action-card" data-action="open-saved"><span class="choice-icon">☆</span><h3>Saved questions</h3><p>${state.savedQuestions.length} questions to revisit</p></button></div><div class="grid grid-2"><section class="card card-pad"><div class="card-head"><h2>Recommended practice</h2><span class="badge red">Needs attention</span></div><div class="stack">${recommendations.map((item, index) => `<div><div class="row-between"><div><strong>${esc(item.title)}</strong><div class="muted">Accuracy: ${item.accuracy}%</div></div><button class="btn btn-sm btn-soft" data-action="start-subject-quiz" data-subject="${esc(item.subject)}">Practise</button></div>${index < recommendations.length - 1 ? '<div class="divider"></div>' : ''}</div>`).join('') || '<div class="empty"><p>No recommendations match this filter.</p></div>'}</div></section><section class="card card-pad"><div class="card-head"><h2>This week</h2><span class="badge green">Strong progress</span></div><div class="grid grid-2"><div><div class="stat-value">284</div><span class="muted">Questions attempted</span></div><div><div class="stat-value">76%</div><span class="muted">Average accuracy</span></div><div><div class="stat-value">42s</div><span class="muted">Avg. per question</span></div><div><div class="stat-value">+4%</div><span class="muted">Accuracy gain</span></div></div></section></div>`;
  }
  function renderQuiz() {
    const index = state.quizIndex;
    const questionId = activeQuestionId();
    const question = quizQuestions[questionId];
    if (!question) { state.practiceView = 'dashboard'; return renderPractice(); }
    const selected = state.quizAnswers[questionId];
    const total = state.quizQueue.length;
    return `<div class="quiz-shell">${pageHead('Quick quiz', `Question ${index + 1} of ${total}`, 'Choose the best answer. You can move back before submitting.', `<button class="btn btn-ghost" data-action="exit-quiz">Exit quiz</button>`)}<div class="quiz-top"><div class="quiz-progress"><div class="progress-fill" data-width="${Math.round(((index + 1) / total) * 20) * 5}"></div></div><span class="badge">${question.subject}</span></div><section class="card quiz-question"><span class="question-count">QUESTION ${index + 1}</span><h2>${question.q}</h2><div class="options">${question.options.map((option, optionIndex) => `<button class="option${selected === optionIndex ? ' selected' : ''}" data-action="select-answer" data-index="${optionIndex}"><span class="option-letter">${String.fromCharCode(65 + optionIndex)}</span><span>${esc(option)}</span></button>`).join('')}</div></section><div class="quiz-footer"><button class="btn btn-ghost" data-action="quiz-prev" ${index === 0 ? 'disabled' : ''}>← Previous</button><div class="row"><button class="btn btn-ghost" data-action="toggle-flag-question">${state.flaggedQuestions.includes(questionId) ? '⚑ Flagged' : '⚐ Flag'}</button><button class="btn btn-ghost" data-action="toggle-save-question">${state.savedQuestions.includes(questionId) ? '★ Saved' : '☆ Save'}</button><button class="btn btn-primary" data-action="quiz-next" ${selected === null ? 'disabled' : ''}>${index === total - 1 ? 'Submit quiz' : 'Next →'}</button></div></div></div>`;
  }
  function quizScore() { return state.quizQueue.reduce((score, questionId) => score + (state.quizAnswers[questionId] === quizQuestions[questionId].answer ? 1 : 0), 0); }
  function quizPercent() { return Math.round((quizScore() / state.quizQueue.length) * 100); }
  function renderQuizResults() {
    const score = quizScore();
    const total = state.quizQueue.length;
    const percent = quizPercent();
    const subjectStats = state.quizQueue.reduce((stats, questionId) => { const question = quizQuestions[questionId]; if (!stats[question.subject]) stats[question.subject] = { correct: 0, total: 0 }; stats[question.subject].total += 1; if (state.quizAnswers[questionId] === question.answer) stats[question.subject].correct += 1; return stats; }, {});
    return `<div class="quiz-shell">${pageHead('Quiz complete', 'Here’s how you did.', 'Use the review to turn mistakes into a stronger next attempt.')}<section class="card result-hero"><div class="result-score">${percent}%</div><h2>${percent >= 80 ? 'Excellent focus!' : percent >= 60 ? 'Solid attempt.' : 'A useful baseline.'}</h2><p>You answered ${score} of ${total} correctly in 4m 18s.</p><div class="timer-controls"><button class="btn btn-accent" data-action="review-quiz">Review answers</button><button class="btn btn-ghost" data-action="retake-quiz">Retake quiz</button></div></section><div class="grid grid-3"><article class="card stat-card"><span class="stat-label">Correct</span><div class="stat-value">${score}/${total}</div></article><article class="card stat-card"><span class="stat-label">Accuracy</span><div class="stat-value">${percent}%</div></article><article class="card stat-card"><span class="stat-label">Average time</span><div class="stat-value">52s</div></article></div><section class="card card-pad"><div class="card-head"><h2>Performance by subject</h2><button class="link-button" data-action="go-practice">Practice home</button></div><div class="stack">${Object.entries(subjectStats).map(([subject, stats], index) => { const accuracy = Math.round((stats.correct / stats.total) * 100); return `<div class="subject-row"><span>${esc(subject)}</span><div class="progress-track"><div class="progress-fill ${index % 2 ? 'blue' : ''}" data-width="${Math.round(accuracy / 5) * 5}"></div></div><strong>${accuracy}%</strong></div>`; }).join('')}</div></section></div>`;
  }
  function renderQuizReview() {
    return `${pageHead('Answer review', 'Learn from every question.', 'Correct answers and explanations are shown below.', `<button class="btn btn-ghost" data-action="back-results">← Results</button><button class="btn btn-primary" data-action="retake-quiz">Retake quiz</button>`)}<div class="stack">${state.quizQueue.map((questionId, position) => { const question = quizQuestions[questionId]; const answer = state.quizAnswers[questionId]; const correct = answer === question.answer; return `<article class="card review-item"><div class="row-between"><span class="badge ${correct ? 'green' : 'red'}">${correct ? 'Correct' : 'Needs review'}</span><div class="row"><span class="badge${state.flaggedQuestions.includes(questionId) ? ' red' : ''}">${state.flaggedQuestions.includes(questionId) ? '⚑ Flagged' : 'Not flagged'}</span><button class="link-button" data-action="toggle-saved-review" data-index="${questionId}">${state.savedQuestions.includes(questionId) ? '★ Saved' : '☆ Save'}</button></div></div><h3>${position + 1}. ${question.q}</h3><p>Your answer: <strong>${answer === null ? 'Not answered' : esc(question.options[answer])}</strong></p>${!correct ? `<p>Correct answer: <strong>${esc(question.options[question.answer])}</strong></p>` : ''}<div class="demo-note">${icon('i')}<span>${esc(question.why)}</span></div></article>`; }).join('')}</div>`;
  }
  function renderSaved() {
    return `${pageHead('Saved questions', 'Your revisit list', 'Use this list for deliberate revision.', `<button class="btn btn-primary" data-action="practice-saved">Practice all</button>`)}${practiceNav('saved')}<section class="card">${state.savedQuestions.length ? state.savedQuestions.map(index => `<div class="saved-row"><div><span class="badge green">${quizQuestions[index].subject}</span><h3>${esc(quizQuestions[index].q)}</h3><span class="muted">Saved from quick quiz</span></div><button class="btn btn-sm btn-danger" data-action="remove-saved" data-index="${index}">Remove</button></div>`).join('') : '<div class="empty"><div class="empty-icon">☆</div><h3>No saved questions</h3><p>Save a question during a quiz and it will appear here.</p></div>'}</section>`;
  }
  function renderMocks() {
    return `${pageHead('Mock tests', 'Practise under exam conditions', 'Timed simulations with section analysis and detailed review.')} ${practiceNav('mocks')}<section class="card"><div class="mock-row"><div><span class="badge green">Recommended</span><h3>${esc(state.exam.replace(/\s+2026$/, ''))} Full Mock 08</h3><span class="muted">100 questions · 60 minutes · All sections</span></div><button class="btn btn-primary" data-action="start-mock">Start test</button></div><div class="mock-row"><div><span class="badge navy">Sectional</span><h3>Quantitative Aptitude Sprint</h3><span class="muted">25 questions · 20 minutes</span></div><button class="btn btn-ghost" data-action="start-mock">Start test</button></div><div class="mock-row"><div><span class="badge lime">Previous year</span><h3>${esc(state.exam.replace(/\s+2026$/, ''))} 2024 Tier I</h3><span class="muted">100 questions · 60 minutes</span></div><button class="btn btn-ghost" data-action="start-mock">Start test</button></div></section>`;
  }
  function renderHistory() {
    return `${pageHead('Practice history', 'Your recent attempts', 'Review performance and identify patterns over time.')} ${practiceNav('history')}<section class="card"><div class="history-row"><div><span class="badge green">Quick quiz</span><h3>Mixed practice · Today</h3><span class="muted">5 questions · 4m 18s</span></div><div><strong>${state.quizFinished ? quizPercent() : 80}%</strong><button class="link-button" data-action="review-history"> Review</button></div></div><div class="history-row"><div><span class="badge navy">Mock test</span><h3>${esc(state.exam.replace(/\s+2026$/, ''))} Full Mock 07 · 12 Apr</h3><span class="muted">100 questions · 58m</span></div><div><strong>74%</strong><button class="link-button" data-action="history-details"> Details</button></div></div><div class="history-row"><div><span class="badge">Subject quiz</span><h3>General Awareness · 10 Apr</h3><span class="muted">20 questions · 12m</span></div><div><strong>62%</strong><button class="link-button" data-action="history-details"> Details</button></div></div></section>`;
  }

  function renderProgress() {
    const mockScores = [['Mock 04', 62], ['Mock 05', 68], ['Mock 06', 71], ['Mock 07', 74], ['Mock 08', 78]];
    return `${pageHead('Performance', 'Progress you can act on.', 'See what is improving, what needs attention, and what to do next.', `<button class="btn btn-ghost" data-action="export-report">${icon('↓')} Export report</button><button class="btn btn-primary" data-action="set-goal">Set weekly goal</button>`)}<div class="grid grid-4"><article class="card metric-card"><span class="stat-label">Study time</span><div class="stat-value">17h 24m</div><span class="stat-trend">↑ 12% vs last week</span></article><article class="card metric-card"><span class="stat-label">Questions solved</span><div class="stat-value">284</div><span class="stat-trend">↑ 43 questions</span></article><article class="card metric-card"><span class="stat-label">Accuracy</span><div class="stat-value">76%</div><span class="stat-trend">↑ 4 percentage points</span></article><article class="card metric-card"><span class="stat-label">Syllabus coverage</span><div class="stat-value">68%</div><span class="stat-trend">6 topics this week</span></article></div>
      <div class="grid grid-2"><section class="card card-pad"><div class="card-head"><h2>Recent mock trend</h2><span class="badge green">+16 points</span></div><div class="trend-chart" aria-label="Recent mock score trend">${mockScores.map(([label, score]) => `<div class="trend-point"><span class="trend-value">${score}%</span><div class="trend-bar" data-height="${score}"></div><span>${label}</span></div>`).join('')}</div></section><section class="card card-pad"><div class="card-head"><h2>Study consistency</h2><span class="badge green">Last 7 days</span></div><div class="chart" aria-label="Daily study minutes bar chart">${[['Mon',62],['Tue',76],['Wed',48],['Thu',84],['Fri',55],['Sat',68],['Sun',35]].map(([day,height]) => `<div class="chart-col"><div class="chart-bar" data-height="${height}"></div><span>${day}</span></div>`).join('')}</div></section></div>
      <div class="grid grid-2"><section class="card card-pad"><div class="card-head"><h2>Strengths</h2><span class="badge green">Keep building</span></div><div class="insight-list static"><div><strong>Reasoning accuracy · 84%</strong><span>Series and analogy are consistent strengths.</span></div><div><strong>English speed · 38s</strong><span>Faster than your 45-second target.</span></div></div></section><section class="card card-pad"><div class="card-head"><h2>Risks</h2><span class="badge red">Act this week</span></div><div class="insight-list static"><div><strong>Current Affairs · 58%</strong><span>Recall drops after seven days.</span></div><div><strong>Time and Work · 64%</strong><span>Accuracy falls under time pressure.</span></div></div></section></div>
      <section class="card card-pad recommendation-card"><div><p class="eyebrow">Recommended next action</p><h2>Run a 20-minute high-risk revision sprint</h2><p class="muted">Review Current Affairs cards, mark recall, then answer five timed questions.</p></div><button class="btn btn-accent" data-action="start-revision-plan">Start revision</button></section>
      <div class="grid grid-2"><section class="card card-pad"><div class="card-head"><h2>Weekly goals</h2><button class="link-button" data-action="set-goal">Edit</button></div><div class="goal-row"><div class="row-between"><strong>Study ${state.weeklyGoal.hours} hours</strong><span>17.4 / ${state.weeklyGoal.hours}h</span></div><div class="progress-track"><div class="progress-fill" data-width="90"></div></div></div><div class="goal-row"><div class="row-between"><strong>Solve ${state.weeklyGoal.questions} questions</strong><span>284 / ${state.weeklyGoal.questions}</span></div><div class="progress-track"><div class="progress-fill blue" data-width="90"></div></div></div></section><section class="card card-pad"><div class="card-head"><h2>Action plan</h2><span class="badge">This week</span></div><ol class="action-list"><li>Complete two Current Affairs recall sessions.</li><li>Take one timed Quant sectional quiz.</li><li>Review every flagged quiz question.</li></ol><button class="btn btn-soft btn-block" data-action="open-plan-setup">Add recommendations to plan</button></section></div>`;
  }

  function renderProfile() {
    const initials = state.profile.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
    return `${pageHead('Account and settings', 'Make PrepPath yours.', 'Manage your profile, appearance, exam, notifications, and data.')}<div class="grid profile-layout"><aside class="stack"><section class="card profile-card"><div class="profile-avatar">${esc(initials)}</div><h2>${esc(state.profile.name)}</h2><p>${esc(state.profile.email)}</p><span class="badge green">Free plan · Prototype</span><div class="divider"></div><div class="grid grid-2"><div><strong>${state.streak}</strong><div class="muted">day streak</div></div><div><strong>68%</strong><div class="muted">coverage</div></div></div><div class="divider"></div><button class="btn btn-ghost btn-block" data-action="edit-profile">Edit profile</button></section><section class="card card-pad"><div class="card-head"><h2>Achievements</h2><span class="badge lime">3 earned</span></div><div class="achievement compact"><span class="achievement-icon">🔥</span><div><strong>Streak keeper</strong><div class="muted">10 days</div></div></div><div class="achievement compact"><span class="achievement-icon">🎯</span><div><strong>Accuracy climber</strong><div class="muted">+10%</div></div></div><button class="link-button" data-action="all-achievements">View all achievements</button></section></aside><div class="stack">
      <section class="card settings-section"><h2>Appearance</h2><div class="setting-row"><div class="setting-copy"><strong>Theme</strong><span>Choose a light or dark workspace</span></div><div class="segmented"><button class="btn btn-sm${state.settings.theme === 'light' ? ' btn-primary' : ' btn-ghost'}" data-action="set-theme" data-theme="light">Light</button><button class="btn btn-sm${state.settings.theme === 'dark' ? ' btn-primary' : ' btn-ghost'}" data-action="set-theme" data-theme="dark">Dark</button></div></div></section>
      <section class="card settings-section"><h2>Preparation</h2><div class="setting-row"><div class="setting-copy"><strong>Primary exam</strong><span>${esc(state.exam)}</span></div><button class="btn btn-sm btn-ghost" data-action="change-exam">Switch exam</button></div><div class="setting-row"><div class="setting-copy"><strong>Target date</strong><span>${new Date(`${state.examDate}T12:00:00`).toLocaleDateString('en-IN', { dateStyle: 'long' })}</span></div><button class="btn btn-sm btn-ghost" data-action="change-date">Edit</button></div><div class="setting-row"><div class="setting-copy"><strong>Daily study target</strong><span>${state.dailyHours} hours per day</span></div><button class="btn btn-sm btn-ghost" data-action="change-hours">Edit</button></div></section>
      <section class="card settings-section"><h2>Notifications</h2>${settingToggle('reminders', 'Study reminders', 'Get a nudge before scheduled sessions')}${settingToggle('weeklyDigest', 'Weekly progress digest', 'A summary of progress and next priorities')}${settingToggle('push', 'Push notifications', 'Alerts for plans and revision')}${settingToggle('email', 'Email updates', 'Product and study summaries')}${settingToggle('sound', 'Focus timer sounds', 'Play a sound when a focus block ends')}</section>
      <section class="card settings-section"><h2>Subscription</h2><div class="setting-row"><div class="setting-copy"><strong>PrepPath Free</strong><span>Core planner, learning, and practice tools</span></div><button class="btn btn-sm btn-accent" data-action="manage-subscription">View plans</button></div></section>
      <section class="card settings-section referral-block"><h2>Referral</h2><div class="setting-row"><div class="setting-copy"><strong>Invite a study partner</strong><span>Share code PREP-AARAV and unlock a streak shield</span></div><button class="btn btn-sm btn-primary" data-action="copy-referral">Copy referral</button></div></section>
      <section class="card settings-section"><h2>Data and account</h2><div class="setting-row"><div class="setting-copy"><strong>Export prototype data</strong><span>Download a local summary of your demo progress</span></div><button class="btn btn-sm btn-ghost" data-action="export-data">Export</button></div><div class="setting-row"><div class="setting-copy"><strong>Reset prototype</strong><span>Clear local data and return to the welcome screen</span></div><button class="btn btn-sm btn-danger" data-action="confirm-reset">Reset</button></div><div class="setting-row"><div class="setting-copy"><strong>Sign out</strong><span>Your local plan will remain in this browser</span></div><button class="btn btn-sm btn-ghost" data-action="sign-out">Sign out</button></div></section></div></div>`;
  }
  function settingToggle(key, title, copy) { return `<div class="setting-row"><div class="setting-copy"><strong>${title}</strong><span>${copy}</span></div><button class="switch${state.settings[key] ? ' on' : ''}" role="switch" aria-checked="${state.settings[key]}" aria-label="${title}" data-action="toggle-setting" data-setting="${key}"></button></div>`; }

  function openCommand() {
    const commands = navItems.map(([route, symbol, label]) => ({ route, symbol, label, hint: `Go to ${label}` })).concat([
      { route: 'planner/timer', symbol: '◷', label: 'Start focus timer', hint: 'Planner' },
      { route: 'practice/quiz', symbol: '✎', label: 'Start quick quiz', hint: 'Practice' },
      { route: 'learn/player', symbol: '▷', label: 'Resume lesson', hint: 'Learn' }
    ]);
    setModal(`<input class="command-input" id="commandInput" placeholder="Search pages and actions…" aria-label="Search commands"><div class="command-list" id="commandList">${commands.map(command => `<button class="command-item" data-action="command-go" data-route="${command.route}" data-search="${command.label.toLowerCase()}">${icon(command.symbol)}<strong>${command.label}</strong><span>${command.hint}</span></button>`).join('')}</div>`, true, 'Command search');
  }
  function openNotifications() {
    const existing = document.getElementById('notificationPanel');
    if (existing) { existing.remove(); return; }
    state.notificationsRead = true; persist();
    const panel = document.createElement('section');
    panel.id = 'notificationPanel';
    panel.className = 'notification-panel';
    panel.setAttribute('aria-label', 'Notifications');
    panel.innerHTML = `<div class="notification-head"><strong>Notifications</strong><button class="link-button" data-action="mark-notifications">Mark all read</button></div><div class="notification-item unread">${icon('◷')}<div><strong>Study block in 20 minutes</strong><div class="muted">Constitutional bodies · 45 min</div></div></div><div class="notification-item">${icon('🔥')}<div><strong>12-day streak!</strong><div class="muted">You’ve studied every day this week.</div></div></div><div class="notification-item">${icon('↗')}<div><strong>Weekly report is ready</strong><div class="muted">Accuracy improved by 4%.</div></div></div>`;
    document.body.appendChild(panel);
    el.topbar.innerHTML = topbarTemplate();
  }

  function openAddTask() {
    setModal(modalFrame('Add a task', `<form id="addTaskForm" class="stack"><div class="field"><label for="taskTitle">Task name</label><input class="input" id="taskTitle" name="title" placeholder="e.g. Revise algebra formulas" required></div><div class="field-row"><div class="field"><label for="taskSubject">Subject</label><select class="select" id="taskSubject" name="subject"><option>Quant</option><option>English</option><option>Reasoning</option><option>GK</option></select></div><div class="field"><label for="taskTime">Time</label><input class="input" id="taskTime" name="time" type="time" value="18:00" required></div></div></form>`, `<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-task">Add task</button>`), false, 'Add task');
  }
  function openAddSession() {
    setModal(modalFrame('Schedule study session', `<form id="addSessionForm" class="stack"><div class="field"><label for="sessionTopic">Topic</label><input class="input" id="sessionTopic" name="topic" placeholder="What will you study?" required></div><div class="field-row"><div class="field"><label for="sessionDate">Date</label><input class="input" id="sessionDate" name="date" type="date" value="${demoTodayIso}" min="${demoTodayIso}" required></div><div class="field"><label for="sessionTime">Start time</label><input class="input" id="sessionTime" name="time" type="time" value="09:00" required></div></div><div class="field"><label for="duration">Duration</label><select class="select" id="duration" name="duration"><option value="25">25 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></div></form>`, `<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="submit-session">Schedule</button>`), false, 'Schedule study session');
  }
  function openPlanSetup() {
    setModal(modalFrame('Setup or regenerate plan', `<form id="planSetupForm" class="stack"><p class="muted">Rebalance your plan around capacity, priorities, and target date. Existing completed tasks stay complete.</p><div class="field-row"><div class="field"><label for="planHours">Daily hours</label><input class="input" id="planHours" name="hours" type="number" min="1" max="8" value="${state.dailyHours}" required></div><div class="field"><label for="planIntensity">Plan intensity</label><select class="select" id="planIntensity" name="intensity"><option${state.planIntensity === 'Balanced' ? ' selected' : ''}>Balanced</option><option${state.planIntensity === 'Intensive' ? ' selected' : ''}>Intensive</option><option${state.planIntensity === 'Light' ? ' selected' : ''}>Light</option></select></div></div><div class="field"><label for="planPriority">Priority subject</label><select class="select" id="planPriority" name="priority">${currentExam().subjects.map(subject => `<option>${esc(subject)}</option>`).join('')}</select></div><div class="demo-note"><span>Your next seven days will be regenerated with revision spacing and one mock block.</span></div></form>`, `<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="regenerate-plan">Regenerate plan</button>`), false, 'Plan setup');
  }
  function openFocusModal() {
    setModal(modalFrame('Pomodoro focus', `<div class="focus-modal"><p class="muted">25-minute focus block · Notifications are muted in this demo.</p><div class="timer-display" id="timerDisplayModal">${formatTime(state.timerSeconds)}</div><div class="timer-controls"><button class="btn btn-accent" data-action="focus-modal-toggle">${state.timerRunning ? 'Pause' : 'Start'} ${icon(state.timerRunning ? 'Ⅱ' : '▶')}</button><button class="btn btn-ghost" data-action="focus-modal-reset">Reset</button></div></div>`, `<button class="btn btn-ghost" data-action="close-modal">Close</button><button class="btn btn-primary" data-action="open-focus-tab">Open full focus view</button>`), false, 'Pomodoro focus timer');
  }
  function openPlaylistModal() {
    setModal(modalFrame('Create playlist', `<form id="playlistForm" class="stack"><div class="field"><label for="playlistName">Playlist name</label><input class="input" id="playlistName" name="name" placeholder="e.g. Weekend revision" required maxlength="50"></div><div class="field"><label for="playlistLessons">Starting lesson set</label><select class="select" id="playlistLessons" name="lessons"><option value="3">Current Affairs · 3 lessons</option><option value="6">Arithmetic foundations · 6 lessons</option><option value="4">Grammar essentials · 4 lessons</option></select></div></form>`, `<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-playlist">Create playlist</button>`), false, 'Create playlist');
  }
  function openSimpleInfo(title, body, actionLabel = 'Done') {
    setModal(modalFrame(title, body, `<button class="btn btn-primary" data-action="close-modal">${actionLabel}</button>`), false, title);
  }

  function beginQuiz(queue) {
    const validQueue = [...new Set(queue)].filter(index => Number.isInteger(index) && quizQuestions[index]);
    if (!validQueue.length) { showToast('Save at least one question before starting this quiz.', 'info'); return; }
    state.quizQueue = validQueue;
    state.practiceView = 'quiz'; state.quizIndex = 0; state.quizAnswers = quizQuestions.map(() => null); state.quizFinished = false; persist(); go('practice/quiz');
  }
  function startQuiz() { beginQuiz(quizQuestions.map((_, index) => index)); }
  function startSubjectQuiz(subject) {
    const queue = quizQuestions.map((question, index) => ({ question, index })).filter(({ question }) => question.subject === subject).map(({ index }) => index);
    if (!queue.length) { showToast(`No ${subject || 'subject'} questions are included in this prototype yet.`, 'info'); return; }
    beginQuiz(queue);
  }
  function startSavedQuiz() { beginQuiz(state.savedQuestions); }
  function retakeQuiz() { beginQuiz(state.quizQueue); }
  function activeQuestionId() { return state.quizQueue[state.quizIndex]; }
  function stopTimer() { if (timerHandle) window.clearInterval(timerHandle); timerHandle = null; state.timerRunning = false; }
  function startTimer() {
    if (timerHandle) return;
    state.timerRunning = true;
    timerHandle = window.setInterval(() => {
      state.timerSeconds -= 1;
      const display = document.getElementById('timerDisplay');
      const modalDisplay = document.getElementById('timerDisplayModal');
      if (display) display.textContent = formatTime(state.timerSeconds);
      if (modalDisplay) modalDisplay.textContent = formatTime(state.timerSeconds);
      if (state.timerSeconds <= 0) { stopTimer(); state.timerSeconds = 25 * 60; state.studyMinutes += 25; persist(); showToast('Focus block complete — excellent work!'); renderProduct(); }
    }, 1000);
  }

  function startVideo() {
    if (videoHandle || state.videoProgress >= 100) return;
    state.videoPlaying = true;
    videoHandle = window.setInterval(() => {
      state.videoProgress = Math.min(100, state.videoProgress + 1);
      const seek = document.getElementById('videoSeek');
      const label = document.getElementById('videoProgressLabel');
      if (seek) seek.value = state.videoProgress;
      if (label) label.textContent = `${state.videoProgress}%`;
      if (state.videoProgress >= 100) { stopVideo(); persist(); showToast('Lesson playback complete.'); renderProduct(); }
    }, 800);
  }
  function stopVideo() { if (videoHandle) window.clearInterval(videoHandle); videoHandle = null; state.videoPlaying = false; }

  document.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'signinForm') {
      const data = new FormData(event.target);
      state.profile.email = data.get('email'); state.authenticated = true; state.onboardingStep = 1; persist(); render();
    }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'hoursRange') { state.dailyHours = Number(event.target.value); document.getElementById('hoursOutput').textContent = `${state.dailyHours} hours`; persist(); }
    if (event.target.id === 'videoSeek') { state.videoProgress = Number(event.target.value); document.getElementById('videoProgressLabel').textContent = `${state.videoProgress}%`; persist(); }
    if (event.target.id === 'syllabusSearch' || event.target.id === 'learnSearch') {
      const key = event.target.id === 'syllabusSearch' ? 'syllabusSearch' : 'learnSearch';
      state[key] = event.target.value;
      window.clearTimeout(filterHandle);
      filterHandle = window.setTimeout(() => { renderProduct(); const input = document.getElementById(event.target.id); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }, 180);
    }
    if (event.target.id === 'commandInput') {
      const query = event.target.value.toLowerCase();
      document.querySelectorAll('[data-search]').forEach(item => { item.hidden = !item.dataset.search.includes(query); });
    }
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'examDate') { state.examDate = event.target.value; persist(); renderAuthFlow(); }
    if (event.target.id === 'examSwitcher') { state.exam = event.target.value; state.weakSubjects = currentExam().subjects.slice(0, 2); state.learnSubject = 'all'; state.syllabusSubject = 'all'; persist(); showToast(`Switched to ${state.exam}`); renderProduct(); }
    if (event.target.id === 'syllabusSubject') { state.syllabusSubject = event.target.value; persist(); renderProduct(); }
    if (event.target.id === 'syllabusStatus') { state.syllabusStatus = event.target.value; persist(); renderProduct(); }
    if (event.target.id === 'learnSubject') { state.learnSubject = event.target.value; persist(); renderProduct(); }
    if (event.target.id === 'practiceFilter') { state.practiceFilter = event.target.value; persist(); renderProduct(); }
  });

  document.addEventListener('click', event => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) {
      if (!event.target.closest('#notificationPanel') && !event.target.closest('[data-action="open-notifications"]')) document.getElementById('notificationPanel')?.remove();
      return;
    }
    const action = actionEl.dataset.action;
    if (action === 'backdrop-close' && event.target === actionEl) { closeModal(); return; }
    const actions = {
      'forgot-password': () => showToast('Password recovery is simulated in this prototype.', 'info'),
      'google-login': () => { state.profile.email = 'learner@gmail.com'; state.profile.name = 'Google Learner'; state.authenticated = true; state.onboarded = true; persist(); go('home'); showToast('Signed in with Google (simulated locally).'); },
      'demo-login': () => { state.authenticated = true; state.onboarded = true; state.onboardingStep = 3; persist(); go('home'); showToast('Demo plan loaded — welcome to PrepPath!'); },
      'select-exam': () => { state.exam = actionEl.dataset.exam; state.weakSubjects = currentExam().subjects.slice(0, 2); state.learnSubject = 'all'; state.syllabusSubject = 'all'; persist(); renderAuthFlow(); },
      'toggle-weak': () => { const subject = actionEl.dataset.subject; state.weakSubjects = state.weakSubjects.includes(subject) ? state.weakSubjects.filter(item => item !== subject) : [...state.weakSubjects, subject]; persist(); renderAuthFlow(); },
      'onboarding-back': () => { if (state.onboardingStep > 1) state.onboardingStep -= 1; persist(); renderAuthFlow(); },
      'onboarding-next': () => { const dateInput = document.getElementById('examDate'); if (dateInput) { if (!dateInput.reportValidity()) return; state.examDate = dateInput.value; } if (state.onboardingStep < 3) { state.onboardingStep += 1; persist(); renderAuthFlow(); } else { state.onboarded = true; persist(); go('home'); showToast('Your personalised study plan is ready.'); } },
      'skip-onboarding': () => { state.onboarded = true; persist(); go('home'); showToast('Demo data loaded. You can customise it in Profile.'); },
      'open-command': openCommand,
      'close-modal': closeModal,
      'open-notifications': openNotifications,
      'mark-notifications': () => { state.notificationsRead = true; document.getElementById('notificationPanel')?.remove(); showToast('Notifications marked as read.'); },
      'go-profile': () => go('profile'),
      'toggle-theme': () => { state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); renderProduct(); showToast(`${state.settings.theme === 'dark' ? 'Dark' : 'Light'} theme enabled.`); },
      'set-theme': () => { state.settings.theme = actionEl.dataset.theme; persist(); applyTheme(); renderProduct(); showToast(`${state.settings.theme === 'dark' ? 'Dark' : 'Light'} theme enabled.`); },
      'open-add-task': openAddTask,
      'open-add-session': openAddSession,
      'open-plan-setup': openPlanSetup,
      'regenerate-plan': () => { const form = document.getElementById('planSetupForm'); if (!form.reportValidity()) return; const data = new FormData(form); state.dailyHours = Number(data.get('hours')); state.planIntensity = data.get('intensity'); const priority = data.get('priority'); const subjects = [priority, ...currentExam().subjects.filter(subject => subject !== priority)]; const duration = state.planIntensity === 'Intensive' ? 60 : state.planIntensity === 'Light' ? 25 : 45; state.weakSubjects = subjects.slice(0, 2); const manualSessions = state.sessions.filter(session => session.generated === false); const generatedSessions = Array.from({ length: 7 }, (_, index) => { const subject = subjects[index % subjects.length]; return { id: Date.now() + index, date: localIso(addDays(demoToday, index)), generated: true, title: index === 0 ? `${subject} priority block` : index === 6 ? `${subject} weekly review` : `${subject} core practice`, subject, time: ['8:00 AM', '10:30 AM', '4:00 PM', '7:00 PM'][index % 4], duration: index === 0 ? Math.min(90, duration + 15) : duration, tone: ['', 'blue', 'orange', ''][index % 4] }; }); state.sessions = [...manualSessions, ...generatedSessions]; persist(); closeModal(); state.plannerTab = 'today'; go('planner/today'); showToast(`Plan regenerated with ${priority} as the priority.`); },
      'open-focus-modal': openFocusModal,
      'focus-modal-toggle': () => { if (state.timerRunning) stopTimer(); else startTimer(); persist(); openFocusModal(); },
      'focus-modal-reset': () => { stopTimer(); state.timerSeconds = 25 * 60; persist(); openFocusModal(); showToast('Focus timer reset.'); },
      'open-focus-tab': () => { closeModal(); state.plannerTab = 'timer'; go('planner/timer'); },
      'submit-task': () => { const form = document.getElementById('addTaskForm'); if (!form.reportValidity()) return; const data = new FormData(form); const rawTime = data.get('time'); const [hour, minute] = rawTime.split(':'); const hourNum = Number(hour); const time = `${hourNum % 12 || 12}:${minute} ${hourNum >= 12 ? 'PM' : 'AM'}`; state.tasks.push({ id: Date.now(), title: data.get('title'), subject: data.get('subject'), time, done: false, credited: false }); persist(); closeModal(); showToast('Task added to today’s plan.'); renderProduct(); },
      'submit-session': () => { const form = document.getElementById('addSessionForm'); if (!form.reportValidity()) return; const data = new FormData(form); const [hour, minute] = data.get('time').split(':'); const hourNum = Number(hour); state.sessions.push({ id: Date.now(), date: data.get('date'), generated: false, title: data.get('topic'), subject: currentExam().subjects[0], time: `${hourNum % 12 || 12}:${minute} ${hourNum >= 12 ? 'PM' : 'AM'}`, duration: Number(data.get('duration')), tone: 'blue' }); persist(); closeModal(); state.plannerTab = data.get('date') === demoTodayIso ? 'today' : 'calendar'; state.calendarOffset = (new Date(`${data.get('date')}T12:00:00`).getFullYear() - demoToday.getFullYear()) * 12 + new Date(`${data.get('date')}T12:00:00`).getMonth() - demoToday.getMonth(); go(`planner/${state.plannerTab}`); showToast(`Study session scheduled for ${new Date(`${data.get('date')}T12:00:00`).toLocaleDateString('en-IN', { dateStyle: 'medium' })}.`); },
      'toggle-task': () => { const task = state.tasks.find(item => item.id === Number(actionEl.dataset.id)); if (task) { const completing = !task.done; task.done = completing; if (completing && !task.credited) { state.studyMinutes += 15; task.credited = true; } persist(); renderProduct(); showToast(task.done ? 'Task complete — nice work!' : 'Task moved back to your plan.'); } },
      'view-planner': () => go('planner'), 'continue-plan': () => go('planner/today'), 'view-syllabus': () => go('syllabus'), 'view-progress': () => go('progress'),
      'start-focus': () => { state.plannerTab = 'timer'; go('planner/timer'); },
      'planner-tab': () => { state.plannerTab = actionEl.dataset.tab; go(`planner/${state.plannerTab}`); },
      'calendar-prev': () => { state.calendarOffset -= 1; persist(); renderProduct(); }, 'calendar-next': () => { state.calendarOffset += 1; persist(); renderProduct(); },
      'kanban-move': () => { const task = state.kanbanTasks.find(item => item.id === Number(actionEl.dataset.id)); if (!task) return; task.status = task.status === 'todo' ? 'progress' : task.status === 'progress' ? 'done' : 'todo'; persist(); renderProduct(); showToast(`Task moved to ${task.status === 'progress' ? 'In progress' : task.status === 'done' ? 'Completed' : 'To do'}.`); },
      'revision-feedback': () => { const topic = actionEl.dataset.topic; const result = actionEl.dataset.result; state.revisionFeedback[topic] = result; if (result === 'forgot') state.bookmarkedTopics = [...new Set([...state.bookmarkedTopics, topic])]; persist(); renderProduct(); showToast(result === 'remembered' ? 'Recall recorded. Next review moved later.' : 'Added to tomorrow’s revision queue.'); },
      'auto-plan-revision': () => { if (!state.sessions.some(session => session.title === 'Spaced revision block')) state.sessions.push({ id: Date.now(), date: demoTodayIso, generated: false, title: 'Spaced revision block', subject: state.weakSubjects[0] || currentExam().subjects[0], time: '6:00 PM', duration: 30, tone: 'orange' }); persist(); showToast('Revision block added to today’s plan.'); },
      'timer-toggle': () => { if (state.timerRunning) stopTimer(); else startTimer(); persist(); renderProduct(); },
      'timer-reset': () => { stopTimer(); state.timerSeconds = 25 * 60; persist(); renderProduct(); showToast('Timer reset.'); },
      'toggle-subject': () => { const name = actionEl.dataset.subject; state.expandedSubjects = state.expandedSubjects.includes(name) ? state.expandedSubjects.filter(item => item !== name) : [...state.expandedSubjects, name]; persist(); renderProduct(); },
      'toggle-topic': () => { const topic = actionEl.dataset.topic; state.completedTopics = state.completedTopics.includes(topic) ? state.completedTopics.filter(item => item !== topic) : [...state.completedTopics, topic]; persist(); renderProduct(); showToast(state.completedTopics.includes(topic) ? 'Topic marked complete.' : 'Topic marked incomplete.'); },
      'toggle-bookmark': () => { const topic = actionEl.dataset.topic; state.bookmarkedTopics = state.bookmarkedTopics.includes(topic) ? state.bookmarkedTopics.filter(item => item !== topic) : [...state.bookmarkedTopics, topic]; persist(); renderProduct(); showToast(state.bookmarkedTopics.includes(topic) ? 'Topic bookmarked.' : 'Bookmark removed.'); },
      'study-topic': () => { activateLearningTopic(actionEl.dataset.topic || 'Recommended topic'); state.learnView = 'player'; persist(); go('learn/player'); showToast(`Opening a lesson for ${state.selectedLearningTopic}.`); },
      'download-syllabus': () => downloadText('preppath-syllabus.txt', `${state.exam} syllabus\n\n${getSyllabusData().map(([subject, , topics]) => `${subject}\n${topics.map(topic => `- ${topic}`).join('\n')}`).join('\n\n')}`, 'Syllabus downloaded.'), 'create-syllabus-plan': openPlanSetup, 'learn-current-affairs': () => { activateLearningTopic('Current Affairs'); state.learnView = 'player'; persist(); go('learn/player'); },
      'resume-lesson': () => { if (actionEl.dataset.topic) activateLearningTopic(actionEl.dataset.topic); if (el.modal.innerHTML) closeModal(); state.learnView = 'player'; persist(); go('learn/player'); }, 'open-course': () => { activateLearningTopic(actionEl.dataset.topic || actionEl.dataset.subject || 'Course lesson'); state.learnView = 'player'; persist(); go('learn/player'); }, 'back-library': () => { stopVideo(); persist(); state.learnView = 'library'; go('learn'); },
      'select-lesson': () => { stopVideo(); state.activeLesson = Number(actionEl.dataset.index); state.videoProgress = 0; persist(); renderProduct(); },
      'toggle-video': () => { if (state.videoPlaying) stopVideo(); else startVideo(); persist(); renderProduct(); showToast(state.videoPlaying ? 'Lesson playback started.' : 'Lesson paused.', 'info'); },
      'video-skip': () => { state.videoProgress = Math.max(0, Math.min(100, state.videoProgress + Number(actionEl.dataset.amount))); persist(); renderProduct(); },
      'create-playlist': openPlaylistModal,
      'save-playlist': () => { const form = document.getElementById('playlistForm'); if (!form.reportValidity()) return; const data = new FormData(form); state.playlists.push({ id: Date.now(), name: data.get('name'), lessons: Number(data.get('lessons')) }); persist(); closeModal(); renderProduct(); showToast('Playlist created and saved.'); },
      'open-playlist': () => { const list = state.playlists.find(item => item.id === Number(actionEl.dataset.id)); openSimpleInfo(list?.name || 'Playlist', `<p>${list?.lessons || 0} lessons are ready in this study queue.</p><button class="btn btn-soft btn-block" data-action="resume-lesson">Start first lesson</button>`); },
      'mark-lesson': () => { if (!state.completedLessons.includes(state.activeLesson)) { state.completedLessons.push(state.activeLesson); state.studyMinutes += 8; } if (state.activeLesson < 5) state.activeLesson += 1; persist(); renderProduct(); showToast('Lesson complete. Next lesson is ready.'); },
      'open-notes': () => { const topic = actionEl.dataset.topic || state.selectedLearningTopic; const note = learningNote(topic); openSimpleInfo(`${topic} notes`, `<h3>${esc(note.title)}</h3><p>${esc(note.body)}</p><div class="demo-note"><span>Use this note for focused recall, then answer a timed check without reopening it.</span></div>`, 'Got it'); },
      'save-lesson': () => { if (!state.savedLessons.includes(state.activeLesson)) state.savedLessons.push(state.activeLesson); persist(); showToast('Lesson saved for later.'); }, 'share-lesson': async () => { const link = `${location.origin}${location.pathname}#/learn/player`; try { await navigator.clipboard.writeText(link); showToast('Lesson link copied.'); } catch (_) { openSimpleInfo('Share lesson', `<p>Copy this link: <strong>${esc(link)}</strong></p>`); } }, 'show-downloads': () => openSimpleInfo('Offline downloads', '<div class="empty"><div class="empty-icon">↓</div><h3>Nothing downloaded yet</h3><p>Downloads are simulated in this standalone prototype.</p></div>'), 'view-all-courses': () => showToast('All recommended courses are shown below.', 'info'),
      'start-quiz': startQuiz, 'start-subject-quiz': () => startSubjectQuiz(actionEl.dataset.subject),
      'select-answer': () => { state.quizAnswers[activeQuestionId()] = Number(actionEl.dataset.index); persist(); renderProduct(); },
      'quiz-prev': () => { if (state.quizIndex > 0) state.quizIndex -= 1; renderProduct(); },
      'quiz-next': () => { if (state.quizIndex < state.quizQueue.length - 1) { state.quizIndex += 1; renderProduct(); } else { state.quizFinished = true; state.practiceView = 'results'; persist(); go('practice/results'); } },
      'toggle-save-question': () => { const index = activeQuestionId(); state.savedQuestions = state.savedQuestions.includes(index) ? state.savedQuestions.filter(item => item !== index) : [...state.savedQuestions, index]; persist(); renderProduct(); },
      'toggle-flag-question': () => { const index = activeQuestionId(); state.flaggedQuestions = state.flaggedQuestions.includes(index) ? state.flaggedQuestions.filter(item => item !== index) : [...state.flaggedQuestions, index]; persist(); renderProduct(); showToast(state.flaggedQuestions.includes(index) ? 'Question flagged for review.' : 'Flag removed.'); },
      'exit-quiz': () => { state.practiceView = 'dashboard'; go('practice'); },
      'review-quiz': () => { state.practiceView = 'review'; go('practice/review'); }, 'back-results': () => { state.practiceView = 'results'; go('practice/results'); },
      'retake-quiz': retakeQuiz,
      'toggle-saved-review': () => { const index = Number(actionEl.dataset.index); state.savedQuestions = state.savedQuestions.includes(index) ? state.savedQuestions.filter(item => item !== index) : [...state.savedQuestions, index]; persist(); renderProduct(); },
      'open-saved': () => { state.practiceView = 'saved'; go('practice/saved'); }, 'open-mocks': () => { state.practiceView = 'mocks'; go('practice/mocks'); }, 'practice-history': () => { state.practiceView = 'history'; go('practice/history'); }, 'go-practice': () => { state.practiceView = 'dashboard'; go('practice'); },
      'practice-tab': () => { const view = actionEl.dataset.view; state.practiceView = view; go(view === 'dashboard' ? 'practice' : `practice/${view}`); },
      'remove-saved': () => { state.savedQuestions = state.savedQuestions.filter(item => item !== Number(actionEl.dataset.index)); persist(); renderProduct(); showToast('Question removed from saved list.'); }, 'practice-saved': startSavedQuiz,
      'start-mock': () => setModal(modalFrame('Mock test ready', '<h3>Before you begin</h3><p>You’ll have 60 minutes for 100 questions. This prototype opens the complete five-question runner to demonstrate the flow.</p><div class="demo-note"><span>Your timer starts after you choose “Begin demo”.</span></div>', '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="begin-mock">Begin demo</button>'), false, 'Start mock test'),
      'begin-mock': () => { closeModal(); startQuiz(); },
      'review-history': () => { state.practiceView = state.quizFinished ? 'review' : 'history'; if (state.quizFinished) go('practice/review'); else showToast('Complete the quick quiz to unlock its review.', 'info'); }, 'history-details': () => openSimpleInfo('Attempt details', '<div class="grid grid-3"><div><strong>74%</strong><div class="muted">Score</div></div><div><strong>82</strong><div class="muted">Attempted</div></div><div><strong>58m</strong><div class="muted">Time</div></div></div><div class="demo-note"><span>Strong in Reasoning; revise current affairs before the next mock.</span></div>'),
      'export-report': () => downloadText('preppath-progress.txt', `PrepPath progress report\nExam: ${state.exam}\nStudy time: 17h 24m\nQuestions solved: 284\nAccuracy: 76%\nSyllabus coverage: 68%`, 'Progress report downloaded.'), 'set-goal': () => openGoalModal(), 'all-achievements': () => openSimpleInfo('Achievements', '<div class="stack"><div class="achievement"><span class="achievement-icon">🔥</span><div><strong>10-day streak</strong><div class="muted">Unlocked</div></div></div><div class="achievement"><span class="achievement-icon">🎯</span><div><strong>Accuracy climber</strong><div class="muted">Unlocked</div></div></div><div class="achievement"><span class="achievement-icon">⚡</span><div><strong>Speed solver</strong><div class="muted">8 questions to unlock</div></div></div></div>'),
      'start-revision-plan': () => { state.plannerTab = 'revision'; go('planner/revision'); showToast('Revision sprint opened. Record what you remember.'); },
      'edit-profile': () => openProfileModal(), 'change-exam': () => openExamModal(), 'change-date': () => openDateModal(), 'change-hours': () => openHoursModal(),
      'toggle-setting': () => { const key = actionEl.dataset.setting; state.settings[key] = !state.settings[key]; persist(); renderProduct(); showToast('Preference updated.'); },
      'manage-subscription': () => openSimpleInfo('PrepPath plans', '<div class="stack"><div class="card card-pad"><span class="badge green">Current</span><h3>Free</h3><p>Planner, syllabus tracking, learning, and practice.</p></div><div class="card card-pad"><span class="badge lime">Preview</span><h3>Plus</h3><p>Adaptive plans and deeper analytics are represented as demo features.</p></div></div>', 'Close'),
      'copy-referral': async () => { try { await navigator.clipboard.writeText('PREP-AARAV'); showToast('Referral code copied.'); } catch (_) { openSimpleInfo('Your referral code', '<p>Share <strong>PREP-AARAV</strong> with a study partner.</p>'); } },
      'export-data': exportData, 'confirm-reset': confirmReset, 'sign-out': () => { state.authenticated = false; persist(); history.replaceState(null, '', location.pathname); render(); showToast('Signed out.'); },
      'command-go': () => { const route = actionEl.dataset.route; closeModal(); go(route); },
      'save-goal': () => { const hours = Number(document.getElementById('goalHours')?.value); const questions = Number(document.getElementById('goalQuestions')?.value); if (!hours || !questions) return; state.weeklyGoal = { hours, questions }; persist(); closeModal(); renderProduct(); showToast('Weekly goal updated.'); },
      'save-profile': () => { const form = document.getElementById('profileForm'); if (!form.reportValidity()) return; const data = new FormData(form); state.profile.name = data.get('name'); state.profile.email = data.get('email'); persist(); closeModal(); renderProduct(); showToast('Profile updated.'); },
      'save-exam': () => { state.exam = document.getElementById('modalExam').value; state.weakSubjects = currentExam().subjects.slice(0, 2); state.learnSubject = 'all'; state.syllabusSubject = 'all'; persist(); closeModal(); renderProduct(); showToast('Primary exam updated.'); },
      'save-date': () => { const form = document.getElementById('dateForm'); if (!form.reportValidity()) return; state.examDate = document.getElementById('modalDate').value; persist(); closeModal(); renderProduct(); showToast('Target date updated.'); },
      'save-hours': () => { const form = document.getElementById('hoursForm'); if (!form.reportValidity()) return; state.dailyHours = Number(document.getElementById('modalHours').value); persist(); closeModal(); renderProduct(); showToast('Daily target updated.'); },
      'reset-data': () => { localStorage.removeItem(STORAGE_KEY); location.hash = ''; location.reload(); }
    };
    if (actions[action]) actions[action]();
  });

  function openGoalModal() { setModal(modalFrame('Set weekly goal', `<div class="stack"><div class="field"><label for="goalHours">Study hours</label><input class="input" id="goalHours" type="number" min="1" max="70" value="${state.weeklyGoal.hours}"></div><div class="field"><label for="goalQuestions">Questions to solve</label><input class="input" id="goalQuestions" type="number" min="10" step="10" value="${state.weeklyGoal.questions}"></div></div>`, '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-goal">Save goal</button>'), false, 'Set weekly goal'); }
  function openProfileModal() { setModal(modalFrame('Edit profile', `<form id="profileForm" class="stack"><div class="field"><label for="profileName">Name</label><input class="input" id="profileName" name="name" value="${esc(state.profile.name)}" required></div><div class="field"><label for="profileEmail">Email</label><input class="input" id="profileEmail" name="email" type="email" value="${esc(state.profile.email)}" required></div></form>`, '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-profile">Save changes</button>'), false, 'Edit profile'); }
  function openExamModal() { setModal(modalFrame('Change primary exam', `<div class="field"><label for="modalExam">Exam</label><select class="select" id="modalExam">${exams.map(exam => `<option${exam.name === state.exam ? ' selected' : ''}>${exam.name}</option>`).join('')}</select></div>`, '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-exam">Update exam</button>'), false, 'Change exam'); }
  function openDateModal() { setModal(modalFrame('Change target date', `<form id="dateForm"><div class="field"><label for="modalDate">Exam date</label><input class="input" id="modalDate" type="date" value="${esc(state.examDate)}" min="${demoTodayIso}" required></div></form>`, '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-date">Update date</button>'), false, 'Change target date'); }
  function openHoursModal() { setModal(modalFrame('Daily study target', `<form id="hoursForm"><div class="field"><label for="modalHours">Hours per day</label><input class="input" id="modalHours" type="number" min="1" max="8" value="${state.dailyHours}" required></div></form>`, '<button class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="save-hours">Update target</button>'), false, 'Daily study target'); }
  function confirmReset() { setModal(modalFrame('Reset prototype?', '<p>This will permanently clear your local plan, quiz attempts, settings, and onboarding progress from this browser.</p><div class="demo-note"><span>This action cannot be undone.</span></div>', '<button class="btn btn-ghost" data-action="close-modal">Keep my data</button><button class="btn btn-danger" data-action="reset-data">Reset everything</button>'), false, 'Confirm reset'); }
  function downloadText(filename, content, successMessage) {
    try {
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); showToast(successMessage);
    } catch (_) { showToast('Download is unavailable in this browser.', 'info'); }
  }
  function exportData() {
    const summary = `PrepPath prototype summary\nExam: ${state.exam}\nTarget: ${state.examDate}\nStudy streak: ${state.streak} days\nSyllabus coverage: 68%\nQuestions this week: 284`;
    downloadText('preppath-summary.txt', summary, 'Prototype data exported.');
  }

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (state.authenticated && state.onboarded) openCommand(); }
    if (event.key === 'Tab' && el.modal.innerHTML) {
      const focusable = [...el.modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]')];
      if (focusable.length) {
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    if (event.key === 'Escape') { if (el.modal.innerHTML) closeModal(); else document.getElementById('notificationPanel')?.remove(); }
  });
  window.addEventListener('hashchange', () => { if (state.authenticated && state.onboarded) renderProduct(); });

  render();
})();
