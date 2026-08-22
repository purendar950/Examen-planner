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
let fcMessageUnsubscribe = null;
const fcRequestUnsubscribes = new Map();
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
    el.innerHTML = res.circles.map(c => {
      let action;
      if (c.joined) action = '<button disabled style="font-size:.68rem;background:var(--accent-dim);color:var(--accent);border:none;border-radius:99px;padding:3px 10px;">Joined</button>';
      else if (c.approvalRequired) action = '<button style="font-size:.68rem;background:var(--surface);color:var(--amber);border:1px solid var(--amber);border-radius:99px;padding:3px 12px;cursor:pointer;" onclick="event.stopPropagation();fcDoJoinPublic(\'' + c.id + '\',1)">Request</button>';
      else action = '<button style="font-size:.68rem;background:var(--accent);color:#fff;border:none;border-radius:99px;padding:3px 12px;cursor:pointer;" onclick="event.stopPropagation();fcDoJoinPublic(\'' + c.id + '\')">Join</button>';
      return `
      <div class="fc-circle-card" onclick="${c.joined?`fcOpenDetail('${c.id}')`:c.approvalRequired?`fcDoJoinPublic('${c.id}',1)`:`fcDoJoinPublic('${c.id}')`}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:.85rem;color:var(--text);">${esc(c.name)}</span>
          ${action}
        </div>
        <div style="display:flex;gap:8px;margin-top:3px;align-items:center;font-size:.7rem;color:var(--muted);">
          <span>by ${esc(c.ownerName)}</span>
          <span>${c.memberCount}${c.maxMembers?'/'+c.maxMembers:''} members</span>
          ${c.approvalRequired?'<span class="fc-badge fc-badge-private">approval</span>':''}
          ${c.focusingCount>0?`<span style="color:#22c55e;">● ${c.focusingCount} focusing</span>`:''}
        </div>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);font-size:.78rem;">'+esc(e.message)+'</p>'; }
}

function fcDebounceSearch() {
  clearTimeout(fcSearchTimer);
  fcSearchTimer = setTimeout(fcRenderDiscover, 350);
}

async function fcDoJoinPublic(cid, requiresApproval) {
  try {
    const res = await D().requestToJoin(cid);
    if (res.status === 'pending') {
      showToast('Join request sent. You will enter automatically when approved.', 'info');
      fcWatchPendingRequests();
    } else {
      showToast(res.alreadyMember || res.status === 'member' ? 'Already a member!' : 'Joined circle! 🎉', res.alreadyMember || res.status === 'member' ? 'info' : 'success');
      await fcEnterRoom(cid);
    }
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
    fcSwitchTab('my'); await fcEnterRoom(res.circleId); fcRefreshLive();
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
  const approvalRequired = document.getElementById('fc-new-approval')?.checked && vis === 'public';
  if (!name) { showToast('Enter a circle name.', 'error'); return; }
  try {
    const res = await D().createCircle(name, vis, approvalRequired);
    fcCloseCreateModal();
    showToast(vis === 'private' ? `Circle created! Code: ${res.joinCode}` : 'Circle created! 🎉', 'success');
    document.getElementById('fc-new-name').value = '';
    if (document.getElementById('fc-new-approval')) document.getElementById('fc-new-approval').checked = false;
    fcSwitchTab('my'); await fcEnterRoom(res.circleId);
  } catch(e) { showToast(e.message, 'error'); }
}

async function fcOpenDetail(cid) {
  try {
    const detail = await D().getCircleDetail(cid);
    if (!detail) return;
    const requests = detail.ownerId === (currentUser && currentUser.uid) ? await D().getJoinRequests(cid) : [];
    fcCurrentDetail = detail;
    document.getElementById('fc-detail-name').textContent = detail.name + (detail.isPinned ? ' 📌' : '');
    document.getElementById('fc-detail-meta').textContent = `${detail.visibility} · ${detail.memberCount} members · ${detail.focusingCount} focusing`;
    const requestHtml = !requests.length ? '' : `
      <h4 style="margin:.75rem 0 .5rem;font-size:.78rem;color:var(--muted);">Pending requests</h4>
      ${requests.map(request => `
        <div class="fc-member-card">
          <img class="fc-avatar" src="${esc(request.avatar)}" alt="" onerror="this.style.display='none'">
          <div style="flex:1;"><span style="font-size:.82rem;font-weight:600;color:var(--text);">${esc(request.name)}</span></div>
          <button onclick="fcDoApproveRequest('${cid}','${request.id}')" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.7rem;cursor:pointer;">Accept</button>
          <button onclick="fcDoRejectRequest('${cid}','${request.id}')" style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:#ef4444;border-radius:6px;padding:4px 10px;font-size:.7rem;cursor:pointer;">Reject</button>
        </div>`).join('')}`;
    document.getElementById('fc-detail-members').innerHTML = requestHtml + (detail.members || []).map(m => {
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
    actions.push(`<button onclick="fcEnterRoom('${cid}')" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:.72rem;cursor:pointer;font-weight:700;">💬 Open Room</button>`);
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
async function fcDoApproveRequest(cid, uid) {
  try { await D().approveJoinRequest(cid, uid); showToast('Request accepted.', 'success'); fcOpenDetail(cid); }
  catch(e) { showToast(e.message, 'error'); }
}
async function fcDoRejectRequest(cid, uid) {
  try { await D().rejectJoinRequest(cid, uid); showToast('Request rejected.', 'info'); fcOpenDetail(cid); }
  catch(e) { showToast(e.message, 'error'); }
}

function _clearRequestWatchers() {
  fcRequestUnsubscribes.forEach(unsubscribe => unsubscribe());
  fcRequestUnsubscribes.clear();
}

function fcWatchPendingRequests() {
  _clearRequestWatchers();
  const ids = ((typeof appState !== 'undefined' && appState.fcRequestIds) || []).slice(0, 10);
  ids.forEach(cid => {
    const unsubscribe = D().watchJoinRequest(cid, request => {
      if (!request || request.status === 'approved' || request.status === 'rejected') {
        const watcher = fcRequestUnsubscribes.get(cid);
        watcher && watcher();
        fcRequestUnsubscribes.delete(cid);
      }
      if (!request) return;
      if (request.status === 'approved') {
        if (typeof appState !== 'undefined') {
          appState.fcRequestIds = (appState.fcRequestIds || []).filter(id => id !== cid);
          saveProgress();
        }
        showToast('Circle request accepted — opening room!', 'success');
        const pageHidden = document.getElementById('page-study-circle')?.style.display === 'none';
        if (pageHidden && typeof switchPage === 'function') switchPage('study-circle');
        setTimeout(() => fcEnterRoom(cid), pageHidden ? 180 : 0);
      } else if (request.status === 'rejected') {
        if (typeof appState !== 'undefined') {
          appState.fcRequestIds = (appState.fcRequestIds || []).filter(id => id !== cid);
          saveProgress();
        }
        showToast('Your circle request was rejected.', 'error');
      }
    });
    fcRequestUnsubscribes.set(cid, unsubscribe);
  });
}

async function fcEnterRoom(cid) {
  try {
    if (fcMessageUnsubscribe) { fcMessageUnsubscribe(); fcMessageUnsubscribe = null; }
    const detail = fcCurrentDetail && fcCurrentDetail.id === cid ? fcCurrentDetail : await D().getCircleDetail(cid);
    if (!detail) throw new Error('Circle not found.');
    fcCurrentDetail = detail;
    document.getElementById('fc-room-name').textContent = detail.name;
    document.getElementById('fc-room-meta').textContent = `${detail.memberCount} members · only members can read messages`;
    document.getElementById('fc-room-messages').innerHTML = '<p style="color:var(--muted);font-size:.8rem;">Loading room…</p>';
    document.getElementById('fc-room-input').value = '';
    document.getElementById('fc-room-overlay').style.display = 'flex';
    fcMessageUnsubscribe = D().subscribeMessages(cid, messages => {
      const container = document.getElementById('fc-room-messages');
      container.innerHTML = messages.length ? messages.map(message => {
        const mine = message.uid === (currentUser && currentUser.uid);
        const sentAt = message.createdAt && message.createdAt.toDate ? message.createdAt.toDate() : null;
        return `
          <div style="display:flex;justify-content:${mine?'flex-end':'flex-start'};margin-bottom:10px;">
            <div style="max:min(78%,420px);background:${mine?'var(--accent)':'var(--surface)'};color:${mine?'#fff':'var(--text)'};padding:8px 11px;border-radius:12px;border:1px solid ${mine?'transparent':'var(--border)'};">
              ${mine?'':`<div style="font-size:.66rem;font-weight:700;margin-bottom:3px;">${esc(message.name)}</div>`}
              <div style="font-size:.82rem;white-space:pre-wrap;word-break:break-word;">${esc(message.text)}</div>
              ${sentAt?`<div style="font-size:.58rem;opacity:.7;text-align:right;margin-top:3px;">${sentAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>`:''}
            </div>
          </div>`;
      }).join('') : '<p style="color:var(--muted);font-size:.8rem;">No messages yet. Say hello and start your focus session!</p>';
      container.scrollTop = container.scrollHeight;
    }, error => showToast(error.message, 'error'));
  } catch(e) { showToast(e.message, 'error'); }
}

async function fcSendRoomMessage() {
  const input = document.getElementById('fc-room-input');
  const text = input.value.trim();
  if (!text || !fcCurrentDetail) return;
  input.value = '';
  try { await D().sendMessage(fcCurrentDetail.id, text); }
  catch(e) { input.value = text; showToast(e.message, 'error'); }
}

function fcCloseRoom() {
  if (fcMessageUnsubscribe) { fcMessageUnsubscribe(); fcMessageUnsubscribe = null; }
  document.getElementById('fc-room-overlay').style.display = 'none';
}

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
  fcWatchPendingRequests();
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
window.fcDoApproveRequest = fcDoApproveRequest;
window.fcDoRejectRequest = fcDoRejectRequest;
window.fcEnterRoom = fcEnterRoom;
window.fcCloseRoom = fcCloseRoom;
window.fcSendRoomMessage = fcSendRoomMessage;
window.fcRefreshLive = fcRefreshLive;
})();
