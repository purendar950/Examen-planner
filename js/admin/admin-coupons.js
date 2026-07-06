/* PrepPath Admin — COUPONS: coupon status + redemption analytics helpers,
   the Coupons tab renderer, create/toggle/delete handlers, and redemptions
   CSV export.
   Depends on globals from admin-core.js (COUPONS, REDEMPTIONS, esc, fmtDate,
   showToast, loadAll, render). */

/* ═══ COUPON HELPERS ═══ */
function couponStatus(c) {
  if (c.enabled === false) return { label: 'Disabled', cls: 'badge-red' };
  if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < new Date()) return { label: 'Expired', cls: 'badge-red' };
  if (c.expiresAt && !c.expiresAt.toDate && c.expiresAt < Date.now()) return { label: 'Expired', cls: 'badge-red' };
  if (c.maxUses && (c.usedCount || 0) >= c.maxUses) return { label: 'Exhausted', cls: 'badge-amber' };
  return { label: 'Active', cls: 'badge-green' };
}
function couponRedemptions(code) { return REDEMPTIONS.filter(r => (r.couponCode || '').toLowerCase() === code.toLowerCase()); }
function couponRevenueLost(code) {
  return couponRedemptions(code).reduce((s, r) => s + (Number(r.discountAmount) || 0), 0);
}

function renderCoupons() {
  // Top stat cards
  const active = COUPONS.filter(c => couponStatus(c).label === 'Active').length;
  const totalRedemptions = REDEMPTIONS.length;
  const totalDiscountGiven = REDEMPTIONS.reduce((s, r) => s + (Number(r.discountAmount) || 0), 0);
  const totalRevenue = REDEMPTIONS.reduce((s, r) => s + (Number(r.finalAmount) || 0), 0);

  let h = '<div class="recon-grid">' +
    '<div class="recon-stat good"><b>' + active + '</b><div>Active coupons</div></div>' +
    '<div class="recon-stat"><b>' + COUPONS.length + '</b><div>Total coupons</div></div>' +
    '<div class="recon-stat"><b>' + totalRedemptions + '</b><div>Total redemptions</div></div>' +
    '<div class="recon-stat warn"><b>\u20b9' + totalDiscountGiven.toLocaleString('en-IN') + '</b><div>Discount given out</div></div>' +
    '<div class="recon-stat good"><b>\u20b9' + totalRevenue.toLocaleString('en-IN') + '</b><div>Coupon revenue (post-discount)</div></div>' +
    '</div>';

  // Create form
  h += '<div class="recon-card">' +
    '<h3>\u2795 Create Coupon</h3>' +
    '<div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;">' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Code (uppercase)<input id="cp-code" placeholder="DIWALI50" style="text-transform:uppercase;width:140px;font-weight:700;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">% Off<input id="cp-pct" type="number" min="1" max="100" placeholder="50" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Max uses<input id="cp-max" type="number" min="1" placeholder="100" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Expires on<input id="cp-exp" type="date" style="width:150px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Min amount \u20b9<input id="cp-min" type="number" min="0" placeholder="0" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Internal note<input id="cp-note" placeholder="Diwali promo / Influencer X" style="width:200px;"></label>' +
    '</div>' +
    '<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:14px;align-items:center;">' +
      '<label style="font-size:0.82rem;display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cp-first" style="width:16px;height:16px;accent-color:var(--accent);"> First-time buyers only</label>' +
      '<button class="btn btn-green" onclick="createCoupon()">\u2795 Create Coupon</button>' +
    '</div>' +
    '<input type="hidden" id="cp-edit-id">' +
  '</div>';

  // List
  h += '<div class="recon-card"><h3>\ud83c\udf9f️ All Coupons (' + COUPONS.length + ')</h3>';
  if (!COUPONS.length) {
    h += '<div class="empty">Abhi koi coupon nahi. Upar se pehla coupon banao (e.g. DIWALI50 \u00b7 50% off \u00b7 100 uses).</div>';
  } else {
    h += COUPONS.map(c => {
      const st = couponStatus(c);
      const expDate = c.expiresAt && c.expiresAt.toDate ? c.expiresAt.toDate().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'}) : (c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : 'No expiry');
      const used = c.usedCount || 0;
      const max = c.maxUses || '\u221e';
      const redCount = couponRedemptions(c.id).length;
      const lost = couponRevenueLost(c.id);
      const usagePct = c.maxUses ? Math.min(100, Math.round((used / c.maxUses) * 100)) : 0;
      return '<div class="recon-card" style="margin-bottom:10px;padding:0.85rem 1rem;">' +
        '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:flex-start;">' +
          '<div style="flex:1;min-width:240px;">' +
            '<strong style="font-size:1.05rem;letter-spacing:0.5px;">' + esc(c.id) + '</strong> ' +
            '<span class="badge ' + st.cls + '">' + st.label + '</span> ' +
            '<span class="badge badge-blue">' + (c.percentOff || 0) + '% OFF</span> ' +
            (c.firstTimeOnly ? '<span class="badge badge-amber">1st time only</span>' : '') +
            '<div class="muted" style="margin-top:4px;">' +
              (c.note ? esc(c.note) + ' \u00b7 ' : '') +
              'Expires: ' + expDate + ' \u00b7 ' +
              'Min \u20b9' + (c.minAmount || 0) + ' \u00b7 ' +
              'Used ' + used + '/' + max +
            '</div>' +
            (c.maxUses ? '<div style="background:#EEF2F6;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;max-width:300px;"><div class="bar-mini" style="width:' + usagePct + '%;height:6px;background:' + (usagePct >= 100 ? 'var(--red)' : (usagePct >= 75 ? 'var(--amber)' : 'var(--accent)')) + ';"></div></div>' : '') +
            '<div class="muted" style="margin-top:6px;">\ud83d\udcca ' + redCount + ' redemptions \u00b7 \u20b9' + lost.toLocaleString('en-IN') + ' discount given</div>' +
          '</div>' +
          '<div class="row" style="flex-shrink:0;">' +
            '<button class="btn btn-gray" onclick="toggleCouponEnabled(\'' + c.id + '\',' + (c.enabled === false) + ')" title="' + (c.enabled === false ? 'Enable' : 'Disable') + '">' + (c.enabled === false ? '\u2705 Enable' : '\u23f8 Disable') + '</button>' +
            '<button class="btn btn-red" onclick="deleteCoupon(\'' + c.id + '\')" title="Delete">\ud83d\uddd1</button>' +
          '</div>' +
        '</div>' +
        (redCount ? '<details style="margin-top:10px;"><summary class="muted" style="cursor:pointer;">\ud83d\udc47 View ' + redCount + ' redemption' + (redCount > 1 ? 's' : '') + '</summary>' +
          '<div style="margin-top:8px;">' +
          couponRedemptions(c.id).slice(0, 50).map(r =>
            '<div class="muted" style="padding:4px 0;border-bottom:1px solid var(--border);">' +
              '<strong>' + esc(r.email || r.uid || '?') + '</strong> \u00b7 ' + esc(r.planName || r.planId || '?') +
              ' \u00b7 \u20b9' + (r.originalAmount || 0) + ' \u2192 \u20b9' + (r.finalAmount || 0) +
              ' (\u2212\u20b9' + (r.discountAmount || 0) + ') \u00b7 ' + fmtDate(r.createdAt) +
            '</div>'
          ).join('') +
          (redCount > 50 ? '<div class="muted" style="margin-top:6px;">+ ' + (redCount - 50) + ' more \u2014 export CSV for full list</div>' : '') +
          '</div></details>' : '') +
      '</div>';
    }).join('');
  }
  h += '</div>';

  // Redemptions log (cross-coupon, newest first)
  h += '<div class="recon-card"><h3>\ud83d\udcdd Redemption Log (' + REDEMPTIONS.length + ')</h3>';
  if (!REDEMPTIONS.length) {
    h += '<div class="muted">Abhi koi redemption nahi hua. Jaise hi user coupon use karega, yahan dikhega.</div>';
  } else {
    h += '<div class="row" style="margin-bottom:8px;"><button class="btn btn-blue" onclick="exportRedemptionsCSV()">\u2b07 Export ' + REDEMPTIONS.length + ' redemptions CSV</button></div>';
    h += '<div style="max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">' +
      REDEMPTIONS.slice(0, 100).map(r =>
        '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:0.85rem;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
          '<div><strong>' + esc(r.email || r.uid || '?') + '</strong> used <code style="background:#EEF2F6;padding:1px 6px;border-radius:3px;">' + esc(r.couponCode || '?') + '</code> on ' + esc(r.planName || r.planId || '?') + '</div>' +
          '<div class="muted">\u20b9' + (r.originalAmount || 0) + ' \u2192 \u20b9' + (r.finalAmount || 0) + ' (\u2212\u20b9' + (r.discountAmount || 0) + ') \u00b7 ' + fmtDate(r.createdAt) + '</div>' +
        '</div>'
      ).join('') +
    '</div>' +
    (REDEMPTIONS.length > 100 ? '<div class="muted" style="margin-top:6px;">Showing latest 100 of ' + REDEMPTIONS.length + '. CSV export for full list.</div>' : '') +
    '</div>';
  }
  h += '</div>';

  return h;
}

async function createCoupon() {
  const codeEl = document.getElementById('cp-code');
  const codeRaw = (codeEl.value || '').trim().toUpperCase();
  if (!codeRaw) { showToast('Code dalo.'); return; }
  if (!/^[A-Z0-9_-]{3,32}$/.test(codeRaw)) { showToast('Code 3-32 chars, sirf A-Z, 0-9, _, -'); return; }
  const pct = parseInt(document.getElementById('cp-pct').value);
  if (!pct || pct < 1 || pct > 100) { showToast('% off 1-100 ke beech dalo.'); return; }
  const max = parseInt(document.getElementById('cp-max').value) || null;
  const exp = document.getElementById('cp-exp').value;
  const min = parseInt(document.getElementById('cp-min').value) || 0;
  const note = document.getElementById('cp-note').value.trim();
  const first = document.getElementById('cp-first').checked;
  const editId = document.getElementById('cp-edit-id').value;
  const targetId = editId || codeRaw;
  const data = {
    code: codeRaw,
    percentOff: pct,
    maxUses: max,
    minAmount: min,
    firstTimeOnly: first,
    note: note,
    enabled: true,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (exp) data.expiresAt = firebase.firestore.Timestamp.fromDate(new Date(exp + 'T23:59:59'));
  try {
    await db.collection('coupons').doc(targetId).set(data, { merge: true });
    if (!editId) {
      // Only set createdAt on first create
      await db.collection('coupons').doc(targetId).set({ createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: (firebase.auth().currentUser || {}).email || 'admin' }, { merge: true });
    }
    codeEl.value = ''; document.getElementById('cp-pct').value = '';
    document.getElementById('cp-max').value = ''; document.getElementById('cp-exp').value = '';
    document.getElementById('cp-min').value = ''; document.getElementById('cp-note').value = '';
    document.getElementById('cp-first').checked = false;
    document.getElementById('cp-edit-id').value = '';
    showToast(editId ? '\u2705 Coupon updated' : '\u2705 Coupon ' + codeRaw + ' created');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

async function toggleCouponEnabled(id, enable) {
  try {
    await db.collection('coupons').doc(id).update({ enabled: enable, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    showToast(enable ? '\u2705 Enabled' : '\u23f8 Disabled');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

async function deleteCoupon(id) {
  if (!confirm('Coupon "' + id + '" delete karein? Redemptions ka record rahega.')) return;
  try {
    await db.collection('coupons').doc(id).delete();
    showToast('\ud83d\uddd1 Deleted');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

function exportRedemptionsCSV() {
  if (!REDEMPTIONS.length) { showToast('Koi redemption nahi.'); return; }
  const headers = ['couponCode','email','uid','planId','planName','originalAmount','discountAmount','finalAmount','createdAt'];
  const rows = REDEMPTIONS.map(r => headers.map(h => {
    let v = r[h];
    if (v && typeof v === 'object' && v.toDate) v = v.toDate().toISOString();
    else if (v && typeof v === 'object' && v.seconds) v = new Date(v.seconds * 1000).toISOString();
    if (v == null) v = '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }).join(','));
  const csv = headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'preppath-redemptions-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('\u2705 Exported ' + REDEMPTIONS.length + ' redemptions');
}
