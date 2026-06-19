/* ══════════════════════════════════════════════
   STREAK
══════════════════════════════════════════════ */
function updateStreak() {
  const today = new Date().toDateString();
  if (appState.lastStudyDate !== today) {
    const yesterday = new Date(Date.now()-86400000).toDateString();
    if (appState.lastStudyDate === yesterday) {
      appState.streak = (appState.streak || 0) + 1;
    } else if (appState.lastStudyDate !== today) {
      appState.streak = 1;
    }
    appState.lastStudyDate = today;
    saveProgress();
  }
}

