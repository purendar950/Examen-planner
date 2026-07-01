/* ══════════════════════════════════════════════
   GROUPS UI — User Interface Components
   Group browser, creation modal, and display
══════════════════════════════════════════════ */

// ── CSS Injection ──────────────────────────────
(function injectGroupsCSS() {
  const style = document.createElement('style');
  style.textContent = `
    /* Groups Page Layout */
    .groups-container {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 1.5rem;
      min-height: 500px;
    }

    @media (max-width: 900px) {
      .groups-container {
        grid-template-columns: 1fr;
      }
    }

    /* Group Cards */
    .group-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .group-card:hover {
      border-color: var(--accent);
      box-shadow: 0 4px 12px rgba(0, 200, 150, 0.1);
    }

    .group-card.selected {
      border-color: var(--accent);
      background: rgba(0, 200, 150, 0.05);
    }

    .group-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 0.75rem;
    }

    .group-card-name {
      font-weight: 700;
      font-size: 1rem;
      color: var(--text);
    }

    .group-card-exam {
      font-size: 0.72rem;
      color: var(--accent);
      background: rgba(0, 200, 150, 0.1);
      padding: 3px 8px;
      border-radius: 99px;
    }

    .group-card-meta {
      display: flex;
      gap: 12px;
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 0.6rem;
    }

    .group-card-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .group-card-desc {
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.5;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .group-card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .group-members-avatars {
      display: flex;
      align-items: center;
    }

    .group-member-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--text);
      margin-left: -8px;
      border: 2px solid var(--surface);
    }

    .group-member-avatar:first-child {
      margin-left: 0;
    }

    .group-member-avatar.more {
      background: var(--accent);
      color: #fff;
    }

    .group-badge {
      font-size: 0.7rem;
      padding: 3px 8px;
      border-radius: 99px;
      background: rgba(59, 130, 246, 0.1);
      color: #3B82F6;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }

    .group-badge.private {
      background: rgba(168, 85, 247, 0.1);
      color: #A855F7;
      border-color: rgba(168, 85, 247, 0.3);
    }

    /* Leaderboard Styles */
    .leaderboard-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      gap: 8px;
    }

    .leaderboard-header h3 {
      margin: 0;
      font-size: 1.1rem;
    }

    .leaderboard-week {
      font-size: 0.75rem;
      color: var(--muted);
    }

    .leaderboard-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 1rem;
    }

    .metric-pill {
      font-size: 0.7rem;
      padding: 4px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 99px;
      color: var(--muted);
    }

    .metric-pill strong {
      color: var(--accent);
    }

    .leaderboard-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .leaderboard-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      transition: all 0.2s ease;
    }

    .leaderboard-row:hover {
      background: rgba(0, 200, 150, 0.03);
    }

    .leaderboard-row.top-1 {
      background: linear-gradient(135deg, rgba(255, 215, 0, 0.08), rgba(255, 215, 0, 0.02));
      border-color: rgba(255, 215, 0, 0.3);
    }

    .leaderboard-row.top-2 {
      background: linear-gradient(135deg, rgba(192, 192, 192, 0.08), rgba(192, 192, 192, 0.02));
      border-color: rgba(192, 192, 192, 0.3);
    }

    .leaderboard-row.top-3 {
      background: linear-gradient(135deg, rgba(205, 127, 50, 0.08), rgba(205, 127, 50, 0.02));
      border-color: rgba(205, 127, 50, 0.3);
    }

    .leaderboard-row.current-user {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }

    .leaderboard-rank {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 50px;
    }

    .rank-number {
      font-weight: 700;
      color: var(--text);
    }

    .leaderboard-user {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }

    .leaderboard-user .user-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.9rem;
      flex-shrink: 0;
    }

    .leaderboard-user .user-info {
      min-width: 0;
    }

    .leaderboard-user .user-name {
      font-weight: 600;
      font-size: 0.88rem;
      color: var(--text);
    }

    .leaderboard-user .user-stats {
      display: flex;
      gap: 10px;
      font-size: 0.72rem;
      color: var(--muted);
    }

    .leaderboard-score {
      text-align: right;
      min-width: 60px;
    }

    .score-value {
      font-weight: 800;
      font-size: 1.1rem;
      color: var(--accent);
    }

    .score-label {
      font-size: 0.68rem;
      color: var(--muted);
    }

    .you-badge {
      background: var(--accent);
      color: #fff;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 99px;
    }

    /* Mini Leaderboard */
    .mini-leaderboard-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 0.82rem;
    }

    .mini-leaderboard-row.current-user {
      color: var(--accent);
      font-weight: 600;
    }

    .mini-rank {
      min-width: 32px;
    }

    .mini-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mini-score {
      color: var(--accent);
      font-weight: 600;
    }

    .mini-leaderboard-gap {
      text-align: center;
      color: var(--muted);
      padding: 4px 0;
    }

    /* Create Group Button */
    .create-group-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 1rem;
      background: transparent;
      border: 2px dashed var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .create-group-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0, 200, 150, 0.03);
    }

    /* Modal Styles */
    .group-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 1rem;
      opacity: 0;
      visibility: hidden;
      transition: all 0.2s ease;
    }

    .group-modal-overlay.open {
      opacity: 1;
      visibility: visible;
    }

    .group-modal {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      width: 100%;
      max-width: 520px;
      max-height: 90vh;
      overflow-y: auto;
      transform: scale(0.95);
      transition: transform 0.2s ease;
    }

    .group-modal-overlay.open .group-modal {
      transform: scale(1);
    }

    .group-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .group-modal-header h3 {
      margin: 0;
      font-size: 1.1rem;
    }

    .group-modal-close {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }

    .group-modal-close:hover {
      color: var(--text);
    }

    .group-modal-body {
      padding: 1.5rem;
    }

    .group-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border);
    }

    /* Form Elements */
    .group-form-group {
      margin-bottom: 1.25rem;
    }

    .group-form-label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }

    .group-form-input,
    .group-form-select,
    .group-form-textarea {
      width: 100%;
      padding: 0.7rem 0.9rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.88rem;
      font-family: var(--font);
      outline: none;
      transition: border-color 0.2s ease;
    }

    .group-form-input:focus,
    .group-form-select:focus,
    .group-form-textarea:focus {
      border-color: var(--accent);
    }

    .group-form-textarea {
      min-height: 80px;
      resize: vertical;
    }

    .group-form-hint {
      font-size: 0.72rem;
      color: var(--muted);
      margin-top: 4px;
    }

    .group-form-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .toggle-switch {
      position: relative;
      width: 44px;
      height: 24px;
      background: var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .toggle-switch.active {
      background: var(--accent);
    }

    .toggle-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s ease;
    }

    .toggle-switch.active::after {
      transform: translateX(20px);
    }

    /* Browse Groups */
    .browse-groups-filters {
      display: flex;
      gap: 10px;
      margin-bottom: 1rem;
    }

    .browse-groups-search {
      flex: 1;
      padding: 0.6rem 0.9rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.85rem;
    }

    .browse-groups-exam-filter {
      padding: 0.6rem 0.9rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.85rem;
    }

    .browse-groups-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 400px;
      overflow-y: auto;
    }

    .browse-group-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .browse-group-item:hover {
      border-color: var(--accent);
    }

    .browse-group-info h4 {
      margin: 0 0 4px 0;
      font-size: 0.92rem;
    }

    .browse-group-info p {
      margin: 0;
      font-size: 0.75rem;
      color: var(--muted);
    }

    .browse-group-join-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s ease;
    }

    .browse-group-join-btn:hover {
      opacity: 0.9;
    }

    /* Empty States */
    .groups-empty {
      text-align: center;
      padding: 3rem 1rem;
    }

    .groups-empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .groups-empty h3 {
      margin: 0 0 0.5rem 0;
      color: var(--text);
    }

    .groups-empty p {
      color: var(--muted);
      font-size: 0.88rem;
      margin: 0 0 1.5rem 0;
    }

    /* Dashboard Widget */
    .groups-dashboard-widget {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
    }

    .groups-dashboard-widget h3 {
      margin: 0 0 1rem 0;
      font-size: 1rem;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .groups-dashboard-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .groups-dashboard-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      background: rgba(0, 200, 150, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .groups-dashboard-item:hover {
      border-color: var(--accent);
    }

    .groups-dashboard-item .group-name {
      font-weight: 600;
      font-size: 0.88rem;
    }

    .groups-dashboard-item .group-rank {
      font-size: 0.82rem;
      color: var(--accent);
    }
  `;
  document.head.appendChild(style);
})();

// ── Page Rendering ─────────────────────────────

/**
 * Render the main groups page
 */
function renderGroupsPage() {
  const page = document.getElementById('page-groups');
  if (!page) return;

  if (userGroups.length === 0) {
    page.innerHTML = renderEmptyGroupsPage();
    return;
  }

  page.innerHTML = `
    <div class="section-title">👥 Study Groups</div>
    
    <div class="groups-container">
      <!-- Left: My Groups -->
      <div class="my-groups-panel">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0; font-size: 1rem;">My Groups</h3>
          <button class="btn-modal-save" style="padding: 6px 14px; font-size: 0.8rem;" onclick="openCreateGroupModal()">
            + Create Group
          </button>
        </div>
        
        <div class="groups-list">
          ${userGroups.map(group => renderGroupCard(group)).join('')}
          
          <div class="create-group-btn" onclick="openBrowseGroupsModal()">
            <span>🔍</span>
            <span>Browse & Join Groups</span>
          </div>
        </div>
      </div>
      
      <!-- Right: Leaderboard -->
      <div class="leaderboard-panel">
        <div id="group-leaderboard">
          ${userGroups.length > 0 ? '<div class="empty-state"><p>Select a group to view leaderboard</p></div>' : ''}
        </div>
      </div>
    </div>
  `;

  // Select first group by default
  if (userGroups.length > 0 && !selectedLeaderboardGroupId) {
    selectGroup(userGroups[0].id);
  }
}

/**
 * Render empty groups page (user has no groups yet)
 */
function renderEmptyGroupsPage() {
  return `
    <div class="groups-empty">
      <div class="groups-empty-icon">👥</div>
      <h3>Join a Study Group</h3>
      <p>Study with peers preparing for the same exam.<br>Compete on weekly leaderboards and stay motivated!</p>
      <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
        <button class="btn-modal-save" onclick="openCreateGroupModal()">+ Create a Group</button>
        <button class="btn-modal-cancel" onclick="openBrowseGroupsModal()">🔍 Browse Groups</button>
      </div>
    </div>
  `;
}

/**
 * Render a single group card
 */
function renderGroupCard(group) {
  const isSelected = selectedLeaderboardGroupId === group.id;
  const memberCount = group.members?.length || 1;
  const isPrivate = !group.isPublic;
  
  // Get first few member avatars
  const memberAvatars = Object.entries(group.memberNames || {})
    .slice(0, 5)
    .map(([uid, name]) => `<div class="group-member-avatar">${name[0]}</div>`)
    .join('');

  const moreCount = memberCount > 5 ? memberCount - 5 : 0;

  return `
    <div class="group-card ${isSelected ? 'selected' : ''}" onclick="selectGroup('${group.id}')">
      <div class="group-card-header">
        <div class="group-card-name">${escapeHtml(group.name)}</div>
        <span class="group-badge ${isPrivate ? 'private' : ''}">${isPrivate ? '🔒 Private' : '🌍 Public'}</span>
      </div>
      
      <div class="group-card-meta">
        <span>📚 ${ALL_EXAMS[group.examId]?.fullName || group.examId.toUpperCase()}</span>
        <span>📅 ${group.targetYear || '2026'}</span>
      </div>
      
      ${group.description ? `<div class="group-card-desc">${escapeHtml(group.description)}</div>` : ''}
      
      <div class="group-card-footer">
        <div class="group-members-avatars">
          ${memberAvatars}
          ${moreCount > 0 ? `<div class="group-member-avatar more">+${moreCount}</div>` : ''}
        </div>
        <span style="font-size: 0.75rem; color: var(--muted);">${memberCount} member${memberCount > 1 ? 's' : ''}</span>
      </div>
    </div>
  `;
}

/**
 * Select a group and show its leaderboard
 */
function selectGroup(groupId) {
  selectedLeaderboardGroupId = groupId;
  
  // Update selected state
  document.querySelectorAll('.group-card').forEach(card => {
    card.classList.remove('selected');
  });
  
  const selectedCard = document.querySelector(`.group-card[onclick="selectGroup('${groupId}')"]`);
  if (selectedCard) {
    selectedCard.classList.add('selected');
  }

  // Render leaderboard
  renderGroupLeaderboard(groupId);
  subscribeToLeaderboard(groupId);
}

// ── Modal Functions ────────────────────────────

/**
 * Open create group modal
 */
function openCreateGroupModal() {
  const modal = document.createElement('div');
  modal.className = 'group-modal-overlay open';
  modal.id = 'create-group-modal';
  modal.innerHTML = `
    <div class="group-modal">
      <div class="group-modal-header">
        <h3>➕ Create Study Group</h3>
        <button class="group-modal-close" onclick="closeCreateGroupModal()">×</button>
      </div>
      
      <div class="group-modal-body">
        <div class="group-form-group">
          <label class="group-form-label">Group Name *</label>
          <input type="text" class="group-form-input" id="cg-name" placeholder="e.g., UPSC 2026 Grind" maxlength="50">
          <div class="group-form-hint">3-50 characters, letters, numbers, spaces, - and _ allowed</div>
        </div>
        
        <div class="group-form-group">
          <label class="group-form-label">Exam *</label>
          <select class="group-form-select" id="cg-exam">
            ${Object.entries(ALL_EXAMS).map(([id, exam]) => `
              <option value="${id}" ${id === currentExam ? 'selected' : ''}>${exam.fullName}</option>
            `).join('')}
          </select>
        </div>
        
        <div class="group-form-group">
          <label class="group-form-label">Target Year</label>
          <select class="group-form-select" id="cg-year">
            <option value="2026">2026</option>
            <option value="2027">2027</option>
            <option value="2028">2028</option>
          </select>
        </div>
        
        <div class="group-form-group">
          <label class="group-form-label">Description <span style="color: var(--muted);">(optional)</span></label>
          <textarea class="group-form-textarea" id="cg-desc" placeholder="What's your group's study focus?" maxlength="200"></textarea>
        </div>
        
        <div class="group-form-group">
          <label class="group-form-label">Visibility</label>
          <div class="group-form-toggle" onclick="toggleGroupVisibility()">
            <div class="toggle-switch active" id="cg-visibility-toggle"></div>
            <span id="cg-visibility-label">Public — Anyone can find and join</span>
          </div>
        </div>
        
        <div class="group-form-group">
          <label class="group-form-label">Max Members</label>
          <input type="number" class="group-form-input" id="cg-max-members" value="50" min="2" max="100" style="max-width: 150px;">
          <div class="group-form-hint">2-100 members</div>
        </div>
      </div>
      
      <div class="group-modal-footer">
        <button class="btn-modal-cancel" onclick="closeCreateGroupModal()">Cancel</button>
        <button class="btn-modal-save" onclick="submitCreateGroup()">Create Group</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCreateGroupModal();
  });
}

function closeCreateGroupModal() {
  const modal = document.getElementById('create-group-modal');
  if (modal) modal.remove();
}

function toggleGroupVisibility() {
  const toggle = document.getElementById('cg-visibility-toggle');
  const label = document.getElementById('cg-visibility-label');
  
  toggle.classList.toggle('active');
  const isPublic = toggle.classList.contains('active');
  
  label.textContent = isPublic 
    ? 'Public — Anyone can find and join' 
    : 'Private — Invite code required to join';
}

async function submitCreateGroup() {
  const name = document.getElementById('cg-name').value.trim();
  const examId = document.getElementById('cg-exam').value;
  const targetYear = parseInt(document.getElementById('cg-year').value);
  const description = document.getElementById('cg-desc').value.trim();
  const isPublic = document.getElementById('cg-visibility-toggle').classList.contains('active');
  const maxMembers = parseInt(document.getElementById('cg-max-members').value);

  const result = await createGroup({
    name,
    examId,
    targetYear,
    description,
    isPublic,
    maxMembers
  });

  if (result) {
    closeCreateGroupModal();
    renderGroupsPage();
  }
}

/**
 * Open browse groups modal
 */
async function openBrowseGroupsModal() {
  const publicGroups = await getPublicGroups(currentExam);

  const modal = document.createElement('div');
  modal.className = 'group-modal-overlay open';
  modal.id = 'browse-groups-modal';
  modal.innerHTML = `
    <div class="group-modal" style="max-width: 600px;">
      <div class="group-modal-header">
        <h3>🔍 Browse Groups</h3>
        <button class="group-modal-close" onclick="closeBrowseGroupsModal()">×</button>
      </div>
      
      <div class="group-modal-body">
        <div class="browse-groups-filters">
          <input type="text" class="browse-groups-search" id="bg-search" placeholder="Search groups..." oninput="filterBrowseGroups()">
          <select class="browse-groups-exam-filter" id="bg-exam" onchange="filterBrowseGroups()">
            <option value="">All Exams</option>
            ${Object.entries(ALL_EXAMS).map(([id, exam]) => `
              <option value="${id}" ${id === currentExam ? 'selected' : ''}>${exam.fullName}</option>
            `).join('')}
          </select>
        </div>
        
        <div class="browse-groups-list" id="bg-list">
          ${publicGroups.length > 0 
            ? publicGroups.map(group => renderBrowseGroupItem(group)).join('')
            : '<div class="empty-state"><p>No public groups found. Create one!</p></div>'
          }
        </div>
        
        <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
          <div class="group-form-label" style="margin-bottom: 8px;">Have an invite code?</div>
          <div style="display: flex; gap: 8px;">
            <input type="text" class="group-form-input" id="bg-invite-code" placeholder="Enter code" style="text-transform: uppercase; max-width: 150px;">
            <button class="btn-modal-save" style="padding: 6px 14px;" onclick="joinByInviteCode()">Join</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeBrowseGroupsModal();
  });
}

function renderBrowseGroupItem(group) {
  const memberCount = group.members?.length || 1;
  
  return `
    <div class="browse-group-item">
      <div class="browse-group-info">
        <h4>${escapeHtml(group.name)}</h4>
        <p>${ALL_EXAMS[group.examId]?.fullName || group.examId.toUpperCase()} · ${memberCount} member${memberCount > 1 ? 's' : ''}</p>
      </div>
      <button class="browse-group-join-btn" onclick="joinGroupFromBrowse('${group.id}')">Join</button>
    </div>
  `;
}

async function filterBrowseGroups() {
  const search = document.getElementById('bg-search').value.toLowerCase();
  const examId = document.getElementById('bg-exam').value;
  
  const allGroups = await getPublicGroups(examId || null, 50);
  const filtered = allGroups.filter(g => 
    g.name.toLowerCase().includes(search) || 
    (g.description && g.description.toLowerCase().includes(search))
  );

  const list = document.getElementById('bg-list');
  list.innerHTML = filtered.length > 0 
    ? filtered.map(group => renderBrowseGroupItem(group)).join('')
    : '<div class="empty-state"><p>No matching groups found.</p></div>';
}

async function joinGroupFromBrowse(groupId) {
  const success = await joinGroup(groupId);
  if (success) {
    closeBrowseGroupsModal();
    renderGroupsPage();
  }
}

async function joinByInviteCode() {
  const code = document.getElementById('bg-invite-code').value.trim();
  if (!code) {
    showToast('Please enter an invite code.', 'error');
    return;
  }

  const success = await joinGroupByInviteCode(code);
  if (success) {
    closeBrowseGroupsModal();
    renderGroupsPage();
  }
}

function closeBrowseGroupsModal() {
  const modal = document.getElementById('browse-groups-modal');
  if (modal) modal.remove();
}

// ── Dashboard Widget ───────────────────────────

/**
 * Render groups dashboard widget
 */
async function renderGroupsDashboardWidget() {
  const container = document.getElementById('groups-dashboard-widget');
  if (!container) return;

  if (userGroups.length === 0) {
    container.innerHTML = `
      <h3>👥 Study Groups</h3>
      <div style="text-align: center; padding: 1rem 0;">
        <p style="color: var(--muted); font-size: 0.85rem; margin: 0 0 1rem 0;">Join a group to compete with peers!</p>
        <button class="btn-modal-save" style="padding: 8px 16px; font-size: 0.82rem;" onclick="switchPage('groups')">Explore Groups</button>
      </div>
    `;
    return;
  }

  // Get leaderboard for first group
  const weekStart = getWeekStart();
  const leaderboard = userGroups.length > 0 ? await getGroupLeaderboard(userGroups[0].id, weekStart) : [];

  container.innerHTML = `
    <h3>👥 Study Groups</h3>
    <div class="groups-dashboard-list">
      ${userGroups.slice(0, 3).map(group => {
        const userEntry = leaderboard.find(u => u.uid === currentUser?.uid);
        return `
          <div class="groups-dashboard-item" onclick="switchPage('groups')">
            <span class="group-name">${escapeHtml(group.name)}</span>
            <span class="group-rank">${userEntry ? `#${userEntry.rank}` : 'View'}</span>
          </div>
        `;
      }).join('')}
      
      ${userGroups.length > 3 ? `<div style="font-size: 0.78rem; color: var(--muted); text-align: center; padding: 4px 0;">+${userGroups.length - 3} more</div>` : ''}
    </div>
    
    ${leaderboard.length > 0 ? `
      <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
        <div style="font-size: 0.78rem; color: var(--muted); margin-bottom: 8px;">Top ${userGroups[0] ? escapeHtml(userGroups[0].name) : 'Group'}</div>
        ${renderMiniLeaderboard(leaderboard, 5)}
      </div>
    ` : ''}
  `;
}

// ── Initialize on Load ─────────────────────────

// Render groups page when switching to it
const _originalSwitchPageGroups = typeof switchPage === 'function' ? switchPage : null;
if (_originalSwitchPageGroups) {
  window.switchPage = function(page) {
    _originalSwitchPageGroups(page);
    if (page === 'groups') {
      renderGroupsPage();
    }
  };
}
