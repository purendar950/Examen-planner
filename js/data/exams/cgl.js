/* ══════════════════════════════════════════════
   EXAM DATA — SSC CGL
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.cgl = {
    name: 'SSC CGL',
    fullName: 'SSC CGL 2024-25',
    badge: 'SSC CGL',
    color: '#00C896',
    examDate: '2026-07-14',
    subjects: null, // will use SUBJECTS (defined below)
    patternHtml: `
      <div class="info-card">
        <h3>📌 Tier I – Computer Based Test</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>General Intelligence &amp; Reasoning</td><td>25</td><td>50</td><td rowspan="4" style="vertical-align:middle;text-align:center;font-weight:700;color:var(--accent);">60 min<br><span style="font-size:0.7rem;color:var(--muted)">(80 for PwD)</span></td></tr>
            <tr><td>General Awareness</td><td>25</td><td>50</td></tr>
            <tr><td>Quantitative Aptitude</td><td>25</td><td>50</td></tr>
            <tr><td>English Comprehension</td><td>25</td><td>50</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>100</strong></td><td><strong>200</strong></td><td></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.5 Negative Marking</span>
          <span class="tag tag-amber">CBT Mode Only</span>
          <span class="tag tag-green">Qualifying in Nature</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Tier II – Computer Based Test</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Module</th><th>Questions</th><th>Marks</th><th>Time</th></tr>
            <tr><td rowspan="2">Paper I (All posts)</td><td>Mathematical Abilities</td><td>30</td><td>90</td><td rowspan="2">1 hr each</td></tr>
            <tr><td>Reasoning &amp; GI</td><td>30</td><td>90</td></tr>
            <tr><td rowspan="2">Paper I (All posts)</td><td>English Language &amp; Comprehension</td><td>45</td><td>135</td><td rowspan="2">1 hr each</td></tr>
            <tr><td>General Awareness</td><td>25</td><td>75</td></tr>
            <tr><td>Paper I (Computer)</td><td>Computer Knowledge</td><td>20</td><td>60</td><td>15 min</td></tr>
            <tr><td>Paper II (JSO)</td><td>Statistics</td><td>100</td><td>200</td><td>2 hrs</td></tr>
            <tr><td>Paper III (AAO)</td><td>General Studies (Finance &amp; Econ)</td><td>100</td><td>200</td><td>2 hrs</td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–1 Negative Marking (Papers)</span>
          <span class="tag tag-green">Merit-based</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility &amp; Key Facts</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age (General)</td><td>18–32 years</td></tr>
          <tr><td>Education</td><td>Bachelor's Degree</td></tr>
          <tr><td>Nationality</td><td>Indian Citizen</td></tr>
          <tr><td>Attempts</td><td>No limit (until age bar)</td></tr>
        </table></div>
      </div>`
};
