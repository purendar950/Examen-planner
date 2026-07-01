/* ══════════════════════════════════════════════
   EXAM DATA — RRB NTPC
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.ntpc = {
    name: 'RRB NTPC',
    fullName: 'RRB NTPC 2025',
    badge: 'RRB NTPC',
    color: '#3B82F6',
    examDate: '2025-09-01',
    patternHtml: `
      <div class="info-card">
        <h3>📌 CBT 1 – Stage I</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>Mathematics</td><td>30</td><td>30</td><td rowspan="3" style="vertical-align:middle;text-align:center;font-weight:700;color:var(--accent);">90 min<br><span style="font-size:0.7rem;color:var(--muted)">(120 for PwD)</span></td></tr>
            <tr><td>General Intelligence &amp; Reasoning</td><td>30</td><td>30</td></tr>
            <tr><td>General Awareness</td><td>40</td><td>40</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>100</strong></td><td><strong>100</strong></td><td></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–1/3 Negative Marking</span>
          <span class="tag tag-amber">Qualifying (Merit Based Shortlisting)</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 CBT 2 – Stage II</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>Mathematics</td><td>35</td><td>35</td><td rowspan="3" style="vertical-align:middle;text-align:center;font-weight:700;color:var(--accent);">90 min</td></tr>
            <tr><td>General Intelligence &amp; Reasoning</td><td>35</td><td>35</td></tr>
            <tr><td>General Awareness</td><td>50</td><td>50</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>120</strong></td><td><strong>120</strong></td><td></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–1/3 Negative Marking</span>
          <span class="tag tag-green">Merit-based Final Selection</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Posts &amp; Pay Scale</h3>
        <div class="table-wrap"><table>
          <tr><th>Post</th><th>Level</th><th>Pay Scale</th></tr>
          <tr><td>Junior Clerk cum Typist</td><td>Level 2</td><td>₹19,900</td></tr>
          <tr><td>Accounts Clerk cum Typist</td><td>Level 2</td><td>₹19,900</td></tr>
          <tr><td>Junior Time Keeper</td><td>Level 2</td><td>₹19,900</td></tr>
          <tr><td>Station Master</td><td>Level 6</td><td>₹35,400</td></tr>
          <tr><td>Goods Guard</td><td>Level 5</td><td>₹29,200</td></tr>
          <tr><td>Senior Commercial cum Ticket Clerk</td><td>Level 5</td><td>₹29,200</td></tr>
          <tr><td>Traffic Assistant</td><td>Level 4</td><td>₹25,500</td></tr>
          <tr><td>Senior Clerk cum Typist</td><td>Level 4</td><td>₹25,500</td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age (General – Level 2/3)</td><td>18–33 years</td></tr>
          <tr><td>Age (General – Level 4/5/6)</td><td>18–33 years</td></tr>
          <tr><td>Education (Level 2/3)</td><td>12th Pass (10+2)</td></tr>
          <tr><td>Education (Level 5/6)</td><td>Graduation</td></tr>
          <tr><td>Typing Test</td><td>Required for Clerk/Typist posts</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'ntpc_ga',
        name: 'General Awareness',
        color: '#3B82F6',
        chapters: [
          { id:'ng1', name:'Ancient India – Indus/Vedic/Maurya/Gupta', sub:'Indian History & Freedom Movement', diff:'Medium' },
          { id:'ng2', name:'Medieval – Delhi/Mughal/Maratha', sub:'Indian History & Freedom Movement', diff:'Medium' },
          { id:'ng3', name:'Modern – British/1857/National Movement', sub:'Indian History & Freedom Movement', diff:'Hard' },
          { id:'ng4', name:'Post-Independence – Nehru Era/Green Revolution', sub:'Indian History & Freedom Movement', diff:'Medium' },
          { id:'ng5', name:'Constitution – Salient Features/Preamble/FR/DPSP', sub:'Indian Polity & Constitution', diff:'Medium' },
          { id:'ng6', name:'Parliament & State Legislature', sub:'Indian Polity & Constitution', diff:'Hard' },
          { id:'ng7', name:'Executive – President/PM/Governor', sub:'Indian Polity & Constitution', diff:'Medium' },
          { id:'ng8', name:'Judiciary – SC/HC/Judicial Review', sub:'Indian Polity & Constitution', diff:'Medium' },
          { id:'ng9', name:'Physical – Himalayas/Plains/Coasts', sub:'Indian Geography & Environment', diff:'Easy' },
          { id:'ng10', name:'Indian Monsoon & Agriculture', sub:'Indian Geography & Environment', diff:'Medium' },
          { id:'ng11', name:'Minerals & Industries', sub:'Indian Geography & Environment', diff:'Medium' },
          { id:'ng12', name:'Environment – Biodiversity/Climate/National Parks', sub:'Indian Geography & Environment', diff:'Hard' },
          { id:'ng13', name:'Planning – NITI Aayog', sub:'Indian Economy & Budget', diff:'Medium' },
          { id:'ng14', name:'Budget – Revenue/Capital/Deficit', sub:'Indian Economy & Budget', diff:'Hard' },
          { id:'ng15', name:'Banking – RBI/SBI/Fiscal Policy', sub:'Indian Economy & Budget', diff:'Medium' },
          { id:'ng16', name:'Taxation – Direct/Indirect/GST', sub:'Indian Economy & Budget', diff:'Medium' },
          { id:'ng17', name:'Physics – Motion/Force/Energy/Heat/Light/Sound/Electricity', sub:'Science & Technology', diff:'Medium' },
          { id:'ng18', name:'Chemistry – Elements/Compounds/Acids-Bases/Metals', sub:'Science & Technology', diff:'Easy' },
          { id:'ng19', name:'Biology – Human Body/Diseases/Nutrition/Genetics', sub:'Science & Technology', diff:'Easy' },
          { id:'ng20', name:'Tech – ISRO/DRDO/IT/Internet/Satellites', sub:'Science & Technology', diff:'Medium' },
          { id:'ng21', name:'Schemes – PM-KISAN/Ayushman/Swachh Bharat', sub:'Current Affairs', diff:'Medium' },
          { id:'ng22', name:'Summits – G20/SCO/BRICS/COP', sub:'Current Affairs', diff:'Medium' },
          { id:'ng23', name:'Awards & Honours', sub:'Current Affairs', diff:'Easy' },
          { id:'ng24', name:'Sports – Winners/Tournaments/Olympics', sub:'Current Affairs', diff:'Easy' },
          { id:'ng25', name:'Indian Railways – Zones/Vande Bharat/Freight', sub:'Current Affairs', diff:'Medium' },
          { id:'ng26', name:'Railway Zones/Divisions/Headquarters', sub:'Railway Specific GK', diff:'Hard' },
          { id:'ng27', name:'Trains – Gatimaan/Rajdhani/Shatabdi/Vande', sub:'Railway Specific GK', diff:'Medium' },
          { id:'ng28', name:'IR Budget & Infrastructure', sub:'Railway Specific GK', diff:'Hard' },
          { id:'ng29', name:'RRB Recruitment & Exams', sub:'Railway Specific GK', diff:'Medium' },
        ]
      },
      {
        id: 'ntpc_math',
        name: 'Mathematics',
        color: '#F59E0B',
        chapters: [
          { id:'nm1', name:'HCF/LCM – Application', sub:'Number System & Simplification', diff:'Easy' },
          { id:'nm2', name:'Simplification – BODMAS/Fractions/Decimals', sub:'Number System & Simplification', diff:'Easy' },
          { id:'nm3', name:'Surds & Indices', sub:'Number System & Simplification', diff:'Medium' },
          { id:'nm4', name:'Square Roots & Cube Roots', sub:'Number System & Simplification', diff:'Easy' },
          { id:'nm5', name:'Percentage – Increase/Decrease/Application', sub:'Percentage & Ratio', diff:'Easy' },
          { id:'nm6', name:'Ratio & Proportion – Direct/Inverse', sub:'Percentage & Ratio', diff:'Easy' },
          { id:'nm7', name:'Mixtures & Alligations', sub:'Percentage & Ratio', diff:'Medium' },
          { id:'nm8', name:'Partnership – Profit Share', sub:'Percentage & Ratio', diff:'Medium' },
          { id:'nm9', name:'TSD – Average/Relative/Overtaking', sub:'Time, Speed & Distance', diff:'Medium' },
          { id:'nm10', name:'Trains – Platforms/Crossing/Relative', sub:'Time, Speed & Distance', diff:'Medium' },
          { id:'nm11', name:'Boats & Streams', sub:'Time, Speed & Distance', diff:'Medium' },
          { id:'nm12', name:'Races & Games of Skill', sub:'Time, Speed & Distance', diff:'Hard' },
          { id:'nm13', name:'Work – Efficiency/Men-Days', sub:'Time & Work', diff:'Medium' },
          { id:'nm14', name:'Pipes & Cisterns – Inlet/Outlet', sub:'Time & Work', diff:'Medium' },
          { id:'nm15', name:'Work & Wages', sub:'Time & Work', diff:'Medium' },
          { id:'nm16', name:'CP/SP/Discount/MRP/Tax/GST', sub:'Profit, Loss & Discount', diff:'Medium' },
          { id:'nm17', name:'SI/CI – Basic/Installments', sub:'Interest & Mensuration', diff:'Medium' },
          { id:'nm18', name:'Mensuration – Area of 2D (Tri/Circle/Rect/Trap)', sub:'Interest & Mensuration', diff:'Medium' },
          { id:'nm19', name:'Mensuration – Volume of 3D (Cube/Cylinder/Cone/Sphere)', sub:'Interest & Mensuration', diff:'Hard' },
          { id:'nm20', name:'DI – Tables/Bar/Line/Pie', sub:'Data Interpretation & Algebra', diff:'Medium' },
          { id:'nm21', name:'Algebra – Linear/Quadratic', sub:'Data Interpretation & Algebra', diff:'Medium' },
          { id:'nm22', name:'Geometry – Basic/Mensuration combined', sub:'Data Interpretation & Algebra', diff:'Hard' },
          { id:'nm23', name:'Probability – Basic/Coins/Dice/Cards', sub:'Data Interpretation & Algebra', diff:'Medium' },
        ]
      },
      {
        id: 'ntpc_reasoning',
        name: 'Reasoning & General Intelligence',
        color: '#00C896',
        chapters: [
          { id:'nr1', name:'Analogies – Word/Letter/Number Pairs', sub:'Verbal Reasoning – I', diff:'Easy' },
          { id:'nr2', name:'Coding-Decoding – Letter/Number/Symbol', sub:'Verbal Reasoning – I', diff:'Medium' },
          { id:'nr3', name:'Blood Relations – Family Tree', sub:'Verbal Reasoning – I', diff:'Hard' },
          { id:'nr4', name:'Direction & Distance', sub:'Verbal Reasoning – I', diff:'Medium' },
          { id:'nr5', name:'Syllogisms – Statements & Conclusions', sub:'Verbal Reasoning – I', diff:'Medium' },
          { id:'nr6', name:'Inequality – Coded/Simple', sub:'Verbal Reasoning – II', diff:'Medium' },
          { id:'nr7', name:'Order Ranking', sub:'Verbal Reasoning – II', diff:'Easy' },
          { id:'nr8', name:'Series – Number/Letter/Alphanumeric', sub:'Verbal Reasoning – II', diff:'Medium' },
          { id:'nr9', name:'Input-Output – Machine Steps', sub:'Verbal Reasoning – II', diff:'Hard' },
          { id:'nr10', name:'Data Sufficiency', sub:'Verbal Reasoning – II', diff:'Hard' },
          { id:'nr11', name:'Figure Series & Classification', sub:'Non-Verbal Reasoning', diff:'Easy' },
          { id:'nr12', name:'Mirror & Water Image', sub:'Non-Verbal Reasoning', diff:'Easy' },
          { id:'nr13', name:'Paper Folding & Cutting', sub:'Non-Verbal Reasoning', diff:'Medium' },
          { id:'nr14', name:'Counting – Lines/Figures/Triangles', sub:'Non-Verbal Reasoning', diff:'Medium' },
          { id:'nr15', name:'Embedded Figures', sub:'Non-Verbal Reasoning', diff:'Medium' },
          { id:'nr16', name:'Venn Diagrams', sub:'Non-Verbal Reasoning', diff:'Easy' },
          { id:'nr17', name:'Seating – Linear/Circular', sub:'Puzzles & Analytical', diff:'Hard' },
          { id:'nr18', name:'Scheduling – Day/Month', sub:'Puzzles & Analytical', diff:'Hard' },
          { id:'nr19', name:'Matching – Paired Items', sub:'Puzzles & Analytical', diff:'Medium' },
          { id:'nr20', name:'Matrix Arrangement', sub:'Puzzles & Analytical', diff:'Medium' },
          { id:'nr21', name:'Clock & Calendar', sub:'Puzzles & Analytical', diff:'Medium' },
        ]
      }
    ]
};
