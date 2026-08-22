/* ══════════════════════════════════════════════
   FOCUS CIRCLE — UI controller
   Depends on: FocusCircleData, appState, currentUser,
   showToast, escapeHtml, saveProgress, onPageActivated
══════════════════════════════════════════════ */
(function() {
'use strict';

let fcActiveTab = 'my';
let fcCurrentDetail = null;
let fcSearchTimer = null;
const D = () => window.FocusCircleData;

function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(String(s||'')) : String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

function fcSwitchTab(tab) {
  fcActiveTab = tab;
  document.querySelectorAll('#fc-tabs-row .fc-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.style.background = on ? 'var(--accent-dim)' : 'var(--surface)';
    b.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    b.style.color = on ? 'var(--accent)' : 'var(--text)';
  });
  ['my','discover','join'].forEach(t => {
    const el = document.getElementById('fc-panel-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'my') fcRenderMy();
  if (tab === 'discover') fcRenderDiscover();
}

async function fcRenderMy() {
  const el = document.getElementById('fc-my-list');
  if (!el) return;
  try {
    const circles = await D().getMyCircles();
    if (!circles.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.82rem;">No circles yet. Create one or discover public circles.</p>';
      return;
    }
    el.innerHTML = circles.map(c => `
      <div class="fc-circle-card" onclick="fcOpenDetail('${c.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:.88rem;color:var(--text);">${esc(c.name)}${c.isPinned?' 📌':''}</span>
          <span style="font-size:.72rem;color:var(--muted);">${c.memberCount}${c.maxMembers?'/'+c.maxMembers:''} members</span>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;align-items:center;">
          <span class="fc-badge ${c.visibility==='public'?'fc-badge-public':'fc-badge-private'}">${c.visibility}</span>
          ${c.focusingCount>0?`<span style="font-size:.68rem;color:#22c55e;font-weight:600;">● ${c.focusingCount} focusing</span>`:''}
          ${c.joinCode&&c.visibility==='private'?`<span style="font-size:.65rem;color:var(--muted);">code: <b>${esc(c.joinCode)}</b></span>`:''}
        </div>
      </div>`).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);font-size:.78rem;">'+esc(e.message)+'</p>'; }
}

async function fcRenderDiscover() {
  const el = document.getElementById('fc-discover-list');
  if (!el) return;
  const q = (document.getElementById('fc-search')||{}).value || '';
  try {
    const res = await D().listPublicCircles(1, q);
    if (!res.circles.length) { el.innerHTML = '<p style="color:var(--muted);font-size:.82rem;">No public circles found.</p>'; return; }
    el.innerHTML = res.circles.map(c => `
      <div class="fc-circle-card" onclick="${c.joined?`fcOpenDetail('${c.id}')`:`fcDoJoinPublic('${c.id}')`}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:.85rem;color:var(--text);">${esc(c.name)}</span>
          ${c.joined?'<button disabled style="font-size:.68rem;background:var(--accent-dim);color:var(--accent);border:none;border-radius:99px;padding:3px 10px;">Joined</button>':'<button style="font-size:.68rem;background:var(--accent);color:#fff;border:none;border-radius:99px;padding:3px 12px;cursor:pointer;" onclick="event.stopPropagation();fcDoJoinPublic(\''+c.id+'\')">Join</button>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:3px;align-items:center;font-size:.7rem;color:var(--muted);">
          <span>by ${esc(c.ownerName)}</span>
          <span>${c.memberCount}${c.maxMembers?'/'+c.maxMembers:''} members</span>
          ${c.focusingCount>0?`<span style="color:#22c55e;">● ${c.focusingCount} focusing</span>`:''}
        </div>
      </div>`).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);font-size:.78rem;">'+esc(e.message)+'</p>'; }
}

function fcDebounceSearch() {
  clearTimeout(fcSearchTimer);
  fcSearchTimer = setTimeout(fcRenderDiscover, 350);
}

async function fcDoJoinPublic(cid) {
  try {
    await D().joinPublic(cid);
    showToast('Joined circle! 🎉', 'success');
    fcRenderDiscover(); fcRenderMy(); fcRefreshLive();
  } catch(e) { showToast(e.message, 'error'); }
}

async function fcJoinByCode() {
  const input = document.getElementById('fc-join-code');
  const err = document.getElementById('fc-join-error');
  err.style.display = 'none';
  const code = (input.value || '').trim().toUpperCase();
  if (code.length !== 6) { err.textContent = 'Code must be 6 characters.'; err.style.display = ''; return; }
  try {
    const res = await D().joinByCode(code);
    showToast(res.alreadyMember ? 'Already a member!' : 'Joined! 🎉', res.alreadyMember ? 'info' : 'success');
    input.value = '';
    fcSwitchTab('my'); fcRefreshLive();
  } catch(e) { err.textContent = e.message; err.style.display = ''; }
}

function fcOpenCreateModal() {
  const gate = document.getElementById('fc-create-gate');
  const elig = D().creationEligibility();
  if (!elig.allowed) {
    gate.style.display = '';
    document.getElementById('fc-gate-text').textContent = `You need a ${elig.requiredStreak}-day streak to create a circle (${elig.currentStreak}/${elig.requiredStreak}).`;
    document.getElementById('fc-gate-bar').style.width = Math.min(100, (elig.currentStreak/elig.requiredStreak*100)) + '%';
  } else { gate.style.display = 'none'; }
  document.getElementById('fc-create-overlay').style.display = 'flex';
}

function fcCloseCreateModal() { document.getElementById('fc-create-overlay').style.display = 'none'; }

async function fcDoCreate() {
  const name = document.getElementById('fc-new-name').value.trim();
  const vis = document.getElementById('fc-new-vis').value;
  if (!name) { showToast('Enter a circle name.', 'error'); return; }
  try {
    const res = await D().createCircle(name, vis);
    fcCloseCreateModal();
    showToast(vis === 'private' ? `Circle created! Code: ${res.joinCode}` : 'Circle created! 🎉', 'success');
    document.getElementById('fc-new-name').value = '';
    fcSwitchTab('my');
  } catch(e) { showToast(e.message, 'error'); }
}

async function fcOpenDetail(cid) {
  try {
    const detail = await D().getCircleDetail(cid);
    if (!detail) return;
    fcCurrentDetail = detail;
    document.getElementById('fc-detail-name').textContent = detail.name + (detail.isPinned ? ' 📌' : '');
    document.getElementById('fc-detail-meta').textContent = `${detail.visibility} · ${detail.memberCount} members · ${detail.focusingCount} focusing`;
    document.getElementById('fc-detail-members').innerHTML = (detail.members || []).map(m => {
      const isMe = m.uid === (currentUser && currentUser.uid);
      const canRemove = detail.ownerId === (currentUser && currentUser.uid) && !isMe && m.role !== 'owner';
      return `<div class="fc-member-card">
        <img class="fc-avatar" src="${esc(m.avatar)}" alt="" onerror="this.style.display='none'">
        <div style="flex:1;">
          <span style="font-size:.82rem;font-weight:600;color:var(--text);">${esc(m.name)}${isMe?' (you)':''}</span>
          <div style="display:flex;gap:4px;margin-top:2px;">
            ${m.role==='owner'?'<span class="fc-badge fc-badge-owner">👑 owner</span>':''}
            ${m.isPremium?'<span class="fc-badge fc-badge-premium">PRO</span>':''}
          </div>
        </div>
        <span class="${m.isFocusing?'fc-dot-focusing':'fc-dot-idle'}" title="${m.isFocusing?'Studying now':'Idle'}"></span>
        ${canRemove?`<button onclick="fcDoRemoveMember('${cid}','${m.uid}')" title="Remove" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.75rem;">✕</button>`:''}
      </div>`;
    }).join('');
    const actions = [];
    actions.push(`<button onclick="fcDoTogglePin('${cid}',${!detail.isPinned})" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 12px;font-size:.72rem;cursor:pointer;">${detail.isPinned?'📌 Unpin':'📌 Pin'}</button>`);
    if (detail.ownerId === (currentUser && currentUser.uid)) {
      actions.push(`<button onclick="fcDoToggleVis('${cid}','${detail.visibility==='public'?'private':'public'}')" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 12px;font-size:.72rem;cursor:pointer;">Make ${detail.visibility==='public'?'Private':'Public'}</button>`);
    }
    if (detail.ownerId !== (currentUser && currentUser.uid)) {
      actions.push(`<button onclick="fcDoLeave('${cid}')" style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:#ef4444;border-radius:6px;padding:5px 14px;font-size:.72rem;cursor:pointer;font-weight:600;">Leave</button>`);
    }
    document.getElementById('fc-detail-actions').innerHTML = actions.join('');
    document.getElementById('fc-detail-overlay').style.display = 'flex';
  } catch(e) { showToast(e.message, 'error'); }
}

function fcCloseDetail() { document.getElementById('fc-detail-overlay').style.display = 'none'; }

async function fcDoLeave(cid) {
  if (!confirm('Leave this circle?')) return;
  try { await D().leaveCircle(cid); fcCloseDetail(); showToast('Left circle.', 'info'); fcRenderMy(); fcRefreshLive(); } catch(e) { showToast(e.message,'error'); }
}
async function fcDoTogglePin(cid, pinned) { await D().togglePin(cid, pinned); fcCloseDetail(); fcOpenDetail(cid); }
async function fcDoToggleVis(cid, vis) { await D().setVisibility(cid, vis); fcCloseDetail(); fcOpenDetail(cid); showToast('Visibility updated.', 'success'); }
async function fcDoRemoveMember(cid, uid) { if(!confirm('Remove this member?'))return; await D().removeMember(cid, uid); fcCloseDetail(); fcOpenDetail(cid); }

async function fcRefreshLive() {
  try {
    const s = await D().getLiveSummary();
    const txt = document.getElementById('fc-live-text');
    if (txt) txt.textContent = s.totalFocusing > 0
      ? `${s.totalFocusing} studying across ${s.activeCirclesCount} circles right now`
      : 'No one is studying right now — be the first!';
  } catch(e) {}
}

onPageActivated('study-circle', function() {
  fcSwitchTab(fcActiveTab);
  fcRefreshLive();
});

window.fcSwitchTab = fcSwitchTab;
window.fcOpenCreateModal = fcOpenCreateModal;
window.fcCloseCreateModal = fcCloseCreateModal;
window.fcDoCreate = fcDoCreate;
window.fcJoinByCode = fcJoinByCode;
window.fcDoJoinPublic = fcDoJoinPublic;
window.fcDebounceSearch = fcDebounceSearch;
window.fcOpenDetail = fcOpenDetail;
window.fcCloseDetail = fcCloseDetail;
window.fcDoLeave = fcDoLeave;
window.fcDoTogglePin = fcDoTogglePin;
window.fcDoToggleVis = fcDoToggleVis;
window.fcDoRemoveMember = fcDoRemoveMember;
window.fcRefreshLive = fcRefreshLive;
})();
