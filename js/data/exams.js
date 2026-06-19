/* ══════════════════════════════════════════════
   MULTI-EXAM DATA
══════════════════════════════════════════════ */
let currentExam = 'cgl';

const ALL_EXAMS = {
  cgl: {
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
  },
  ntpc: {
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
  },
  gd: {
    name: 'SSC GD',
    fullName: 'SSC GD Constable 2025',
    badge: 'SSC GD',
    color: '#EF4444',
    examDate: '2025-11-01',
    patternHtml: `
      <div class="info-card">
        <h3>📌 CBT (Computer Based Test)</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>General Intelligence &amp; Reasoning</td><td>20</td><td>40</td><td rowspan="4" style="vertical-align:middle;text-align:center;font-weight:700;color:var(--red);">60 min<br><span style="font-size:0.7rem;color:var(--muted)">(80 for PwD)</span></td></tr>
            <tr><td>General Knowledge &amp; Awareness</td><td>20</td><td>40</td></tr>
            <tr><td>Elementary Mathematics</td><td>20</td><td>40</td></tr>
            <tr><td>English / Hindi</td><td>20</td><td>40</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>80</strong></td><td><strong>160</strong></td><td></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.5 Negative Marking</span>
          <span class="tag tag-amber">2 marks per correct answer</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Selection Stages</h3>
        <div class="table-wrap"><table>
          <tr><th>Stage</th><th>Details</th></tr>
          <tr><td>1. CBT</td><td>80 Qs, 160 Marks, 60 mins</td></tr>
          <tr><td>2. Physical Efficiency Test (PET)</td><td>Race, Long Jump, High Jump</td></tr>
          <tr><td>3. Physical Standard Test (PST)</td><td>Height, Chest measurement</td></tr>
          <tr><td>4. Medical Exam</td><td>Fitness standards</td></tr>
          <tr><td>5. Document Verification</td><td>Final selection</td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility &amp; Physical Standards</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Male</th><th>Female</th></tr>
          <tr><td>Age</td><td colspan="2">18–23 years (General)</td></tr>
          <tr><td>Education</td><td colspan="2">10th Pass (Matriculation)</td></tr>
          <tr><td>Height</td><td>170 cm</td><td>157 cm</td></tr>
          <tr><td>Chest</td><td>80 cm (5 cm exp.)</td><td>Not applicable</td></tr>
          <tr><td>Race (PET)</td><td>5 km in 24 mins</td><td>1.6 km in 8.5 mins</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'gd_reasoning',
        name: 'General Intelligence & Reasoning',
        color: '#00C896',
        chapters: [
          { id:'gdr1', name:'Word/Synonym/Antonym Analogy', sub:'Analogy & Classification', diff:'Easy' },
          { id:'gdr2', name:'Number/Letters Analogy', sub:'Analogy & Classification', diff:'Easy' },
          { id:'gdr3', name:'Odd One – Word/Number/Letter/Figure', sub:'Analogy & Classification', diff:'Easy' },
          { id:'gdr4', name:'Letter/Number Coded Patterns', sub:'Coding-Decoding & Series', diff:'Medium' },
          { id:'gdr5', name:'Figure Series Completion', sub:'Coding-Decoding & Series', diff:'Easy' },
          { id:'gdr6', name:'Number/Letter/Alphanumeric Series', sub:'Coding-Decoding & Series', diff:'Medium' },
          { id:'gdr7', name:'Direction & Distance', sub:'Direction, Blood & Syllogism', diff:'Medium' },
          { id:'gdr8', name:'Blood Relations & Family Tree', sub:'Direction, Blood & Syllogism', diff:'Hard' },
          { id:'gdr9', name:'Statements & Conclusions', sub:'Direction, Blood & Syllogism', diff:'Medium' },
          { id:'gdr10', name:'Mirror Image & Water Reflection', sub:'Non-Verbal Reasoning', diff:'Easy' },
          { id:'gdr11', name:'Paper Folding & Cutting', sub:'Non-Verbal Reasoning', diff:'Medium' },
          { id:'gdr12', name:'Figure Counting – Lines/Triangles', sub:'Non-Verbal Reasoning', diff:'Medium' },
          { id:'gdr13', name:'Order & Ranking', sub:'Puzzles & Other', diff:'Easy' },
          { id:'gdr14', name:'Dice & Cube', sub:'Puzzles & Other', diff:'Medium' },
          { id:'gdr15', name:'Calendar & Clock Basics', sub:'Puzzles & Other', diff:'Medium' },
          { id:'gdr16', name:'Venn Diagrams', sub:'Puzzles & Other', diff:'Easy' },
          { id:'gdr17', name:'Matrix Arrangement', sub:'Puzzles & Other', diff:'Medium' },
        ]
      },
      {
        id: 'gd_gk',
        name: 'General Knowledge & Awareness',
        color: '#3B82F6',
        chapters: [
          { id:'gdk1', name:'Ancient – Indus/Vedic/Maurya/Gupta', sub:'History & Freedom Struggle', diff:'Medium' },
          { id:'gdk2', name:'Medieval – Delhi/Mughal', sub:'History & Freedom Struggle', diff:'Easy' },
          { id:'gdk3', name:'Modern – British/1857/National Movement', sub:'History & Freedom Struggle', diff:'Medium' },
          { id:'gdk4', name:'Constitution – FR/DPSP/Parliament', sub:'Polity & Constitution', diff:'Medium' },
          { id:'gdk5', name:'Government Bodies', sub:'Polity & Constitution', diff:'Easy' },
          { id:'gdk6', name:'Panchayati Raj', sub:'Polity & Constitution', diff:'Easy' },
          { id:'gdk7', name:'Physical – Mountains/Rivers/Climate', sub:'Geography & Environment', diff:'Easy' },
          { id:'gdk8', name:'Agriculture/Population', sub:'Geography & Environment', diff:'Medium' },
          { id:'gdk9', name:'Biodiversity – Parks/Sanctuaries', sub:'Geography & Environment', diff:'Medium' },
          { id:'gdk10', name:'Basic Concepts – GDP/Inflation', sub:'Economy & Budget', diff:'Easy' },
          { id:'gdk11', name:'Budget/Schemes', sub:'Economy & Budget', diff:'Medium' },
          { id:'gdk12', name:'Banking – RBI/Fiscal', sub:'Economy & Budget', diff:'Medium' },
          { id:'gdk13', name:'Physics – Force/Motion/Energy', sub:'Science & Tech', diff:'Easy' },
          { id:'gdk14', name:'Chemistry – Acids/Bases/Metals', sub:'Science & Tech', diff:'Easy' },
          { id:'gdk15', name:'Biology – Body/Nutrition/Disease', sub:'Science & Tech', diff:'Easy' },
          { id:'gdk16', name:'Space/Defence', sub:'Science & Tech', diff:'Medium' },
          { id:'gdk17', name:'National/State Schemes', sub:'Current Affairs', diff:'Medium' },
          { id:'gdk18', name:'Sports – Tournaments/Winners', sub:'Current Affairs', diff:'Easy' },
          { id:'gdk19', name:'Awards/Books/Appointments', sub:'Current Affairs', diff:'Easy' },
        ]
      },
      {
        id: 'gd_math',
        name: 'Elementary Mathematics',
        color: '#F59E0B',
        chapters: [
          { id:'gdm1', name:'HCF/LCM', sub:'Number System & Simplification', diff:'Easy' },
          { id:'gdm2', name:'BODMAS/Approximation', sub:'Number System & Simplification', diff:'Easy' },
          { id:'gdm3', name:'Surds/Indices', sub:'Number System & Simplification', diff:'Medium' },
          { id:'gdm4', name:'Percentage – Profit-Loss/Discount', sub:'Percentage, Ratio & Average', diff:'Easy' },
          { id:'gdm5', name:'Ratio & Mixtures', sub:'Percentage, Ratio & Average', diff:'Medium' },
          { id:'gdm6', name:'Average – Weighted/Ages', sub:'Percentage, Ratio & Average', diff:'Easy' },
          { id:'gdm7', name:'Work & Pipes', sub:'Time, Work & Speed', diff:'Medium' },
          { id:'gdm8', name:'Speed/Trains/Boats', sub:'Time, Work & Speed', diff:'Medium' },
          { id:'gdm9', name:'Distance & Races', sub:'Time, Work & Speed', diff:'Medium' },
          { id:'gdm10', name:'Simple/Compound Interest', sub:'SI/CI & Mensuration', diff:'Medium' },
          { id:'gdm11', name:'Mensuration – Area/Volume 2D/3D', sub:'SI/CI & Mensuration', diff:'Medium' },
          { id:'gdm12', name:'DI – Tables/Bar/Pie', sub:'Data Interpretation & Algebra', diff:'Medium' },
          { id:'gdm13', name:'Algebra – Linear/Quadratic', sub:'Data Interpretation & Algebra', diff:'Medium' },
          { id:'gdm14', name:'Geometry – Triangles/Angles/Circles', sub:'Data Interpretation & Algebra', diff:'Hard' },
          { id:'gdm15', name:'Probability', sub:'Data Interpretation & Algebra', diff:'Medium' },
        ]
      },
      {
        id: 'gd_english',
        name: 'English Language',
        color: '#A855F7',
        chapters: [
          { id:'gde1', name:'Noun/Pronoun/Verb/Adverb/Adjective', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
          { id:'gde2', name:'Tenses – All Forms', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
          { id:'gde3', name:'Active/Passive Voice', sub:'Grammar – Parts of Speech & Tenses', diff:'Medium' },
          { id:'gde4', name:'Subject-Verb Agreement', sub:'Grammar – Parts of Speech & Tenses', diff:'Medium' },
          { id:'gde5', name:'Direct/Indirect Narration', sub:'Grammar – Sentences & Narration', diff:'Medium' },
          { id:'gde6', name:'Modals & Conditionals', sub:'Grammar – Sentences & Narration', diff:'Medium' },
          { id:'gde7', name:'Prepositions & Conjunctions', sub:'Grammar – Sentences & Narration', diff:'Easy' },
          { id:'gde8', name:'Synonyms/Antonyms', sub:'Vocabulary & Comprehension', diff:'Easy' },
          { id:'gde9', name:'Idioms & Phrases', sub:'Vocabulary & Comprehension', diff:'Medium' },
          { id:'gde10', name:'One Word Substitution', sub:'Vocabulary & Comprehension', diff:'Medium' },
          { id:'gde11', name:'Spelling', sub:'Vocabulary & Comprehension', diff:'Easy' },
          { id:'gde12', name:'Reading Comprehension – Passages', sub:'Vocabulary & Comprehension', diff:'Medium' },
          { id:'gde13', name:'Error/Correction', sub:'Error Detection & Para Jumbles', diff:'Hard' },
          { id:'gde14', name:'Cloze Test', sub:'Error Detection & Para Jumbles', diff:'Medium' },
          { id:'gde15', name:'Para Jumbles – Order/Connectors', sub:'Error Detection & Para Jumbles', diff:'Hard' },
        ]
      },
      {
        id: 'gd_hindi',
        name: 'हिंदी भाषा',
        color: '#F97316',
        chapters: [
          { id:'gdh1', name:'संज्ञा – भेद व प्रयोग (Noun types & usage)', sub:'व्याकरण – शब्द भेद', diff:'Easy' },
          { id:'gdh2', name:'सर्वनाम – भेद व प्रयोग (Pronoun types)', sub:'व्याकरण – शब्द भेद', diff:'Easy' },
          { id:'gdh3', name:'विशेषण – भेद व प्रयोग (Adjective)', sub:'व्याकरण – शब्द भेद', diff:'Easy' },
          { id:'gdh4', name:'क्रिया – सकर्मक/अकर्मक (Verb types)', sub:'व्याकरण – शब्द भेद', diff:'Easy' },
          { id:'gdh5', name:'क्रिया विशेषण (Adverb)', sub:'व्याकरण – शब्द भेद', diff:'Easy' },
          { id:'gdh6', name:'समास – भेद व विग्रह (Compound words)', sub:'व्याकरण – शब्द रचना', diff:'Hard' },
          { id:'gdh7', name:'उपसर्ग व प्रत्यय (Prefix & Suffix)', sub:'व्याकरण – शब्द रचना', diff:'Medium' },
          { id:'gdh8', name:'संधि – स्वर/व्यंजन/विसर्ग (Sandhi)', sub:'व्याकरण – शब्द रचना', diff:'Hard' },
          { id:'gdh9', name:'वाक्य शुद्धि – अशुद्ध वाक्य सुधार (Sentence correction)', sub:'वाक्य रचना व शुद्धि', diff:'Hard' },
          { id:'gdh10', name:'वर्तनी शुद्धि – अशुद्ध वर्तनी (Spelling errors)', sub:'वाक्य रचना व शुद्धि', diff:'Medium' },
          { id:'gdh11', name:'काल – भूत/वर्तमान/भविष्य (Tenses)', sub:'वाक्य रचना व शुद्धि', diff:'Easy' },
          { id:'gdh12', name:'वाच्य – कर्तृ/कर्म/भाव वाच्य (Voice)', sub:'वाक्य रचना व शुद्धि', diff:'Hard' },
          { id:'gdh13', name:'पर्यायवाची शब्द (Synonyms)', sub:'शब्द भंडार', diff:'Medium' },
          { id:'gdh14', name:'विलोम शब्द (Antonyms)', sub:'शब्द भंडार', diff:'Medium' },
          { id:'gdh15', name:'अनेकार्थी शब्द (Multiple meanings)', sub:'शब्द भंडार', diff:'Hard' },
          { id:'gdh16', name:'एकार्थक शब्द – शब्दों में अंतर (Word distinction)', sub:'शब्द भंडार', diff:'Hard' },
          { id:'gdh17', name:'मुहावरे (Idioms & Proverbs)', sub:'मुहावरे व लोकोक्तियाँ', diff:'Medium' },
          { id:'gdh18', name:'लोकोक्तियाँ (Proverbs)', sub:'मुहावरे व लोकोक्तियाँ', diff:'Medium' },
          { id:'gdh19', name:'अपठित गद्यांश – बोध प्रश्न (Reading Comprehension)', sub:'गद्यांश व पद्यांश', diff:'Medium' },
          { id:'gdh20', name:'अपठित पद्यांश (Poetry Comprehension)', sub:'गद्यांश व पद्यांश', diff:'Hard' },
          { id:'gdh21', name:'रिक्त स्थान पूर्ति (Fill in the blanks)', sub:'प्रायोगिक हिंदी', diff:'Easy' },
          { id:'gdh22', name:'निर्देशानुसार वाक्य परिवर्तन (Sentence transformation)', sub:'प्रायोगिक हिंदी', diff:'Hard' },
        ]
      }
    ]
  },
  ibps: {
    name: 'IBPS PO',
    fullName: 'IBPS PO 2025',
    badge: 'IBPS PO',
    color: '#A855F7',
    examDate: '2025-10-15',
    patternHtml: `
      <div class="info-card">
        <h3>📌 Prelims – Phase I</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>English Language</td><td>30</td><td>30</td><td>20 min</td></tr>
            <tr><td>Quantitative Aptitude</td><td>35</td><td>35</td><td>20 min</td></tr>
            <tr><td>Reasoning Ability</td><td>35</td><td>35</td><td>20 min</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>100</strong></td><td><strong>100</strong></td><td><strong>60 min</strong></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.25 Negative Marking</span>
          <span class="tag tag-amber">Sectional Cutoffs Apply</span>
          <span class="tag tag-green">Qualifying (Shortlisting)</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Mains – Phase II</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Section</th><th>Questions</th><th>Marks</th><th>Time</th></tr>
            <tr><td>Reasoning &amp; Computer Aptitude</td><td>45</td><td>60</td><td>60 min</td></tr>
            <tr><td>English Language</td><td>35</td><td>40</td><td>40 min</td></tr>
            <tr><td>Data Analysis &amp; Interpretation</td><td>35</td><td>60</td><td>45 min</td></tr>
            <tr><td>General Economy &amp; Banking Awareness</td><td>40</td><td>40</td><td>35 min</td></tr>
            <tr><td><strong>Total (Objective)</strong></td><td><strong>155</strong></td><td><strong>200</strong></td><td><strong>180 min</strong></td></tr>
            <tr><td>Descriptive (Letter+Essay)</td><td>2</td><td>25</td><td>30 min</td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.25 Negative Marking</span>
          <span class="tag tag-green">Merit-based Final Selection</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Phase III – Interview</h3>
        <div class="table-wrap"><table>
          <tr><th>Stage</th><th>Marks</th><th>Weightage</th></tr>
          <tr><td>Mains Exam</td><td>200+25</td><td>80%</td></tr>
          <tr><td>Interview</td><td>100</td><td>20%</td></tr>
          <tr><td>Final Merit</td><td>Composite Score</td><td>80:20 ratio</td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age</td><td>20–30 years (General)</td></tr>
          <tr><td>Age (OBC)</td><td>20–33 years</td></tr>
          <tr><td>Age (SC/ST)</td><td>20–35 years</td></tr>
          <tr><td>Education</td><td>Graduation in any discipline</td></tr>
          <tr><td>Computer Knowledge</td><td>Preferred/Essential</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'ibps_reasoning',
        name: 'Reasoning & Computer Aptitude',
        color: '#00C896',
        chapters: [
          { id:'ibr1', name:'Floor/Box Based Puzzles', sub:'Puzzles – Advanced', diff:'Hard' },
          { id:'ibr2', name:'Day/Month/Year Scheduling', sub:'Puzzles – Advanced', diff:'Hard' },
          { id:'ibr3', name:'Comparison Puzzles', sub:'Puzzles – Advanced', diff:'Hard' },
          { id:'ibr4', name:'Designation Based', sub:'Puzzles – Advanced', diff:'Hard' },
          { id:'ibr5', name:'Flat/Colour/Category Puzzles', sub:'Puzzles – Advanced', diff:'Hard' },
          { id:'ibr6', name:'Linear – Single/Double Row (Facing North/South)', sub:'Seating Arrangements', diff:'Hard' },
          { id:'ibr7', name:'Circular – Symmetrical/Asymmetrical/Inward-Outward', sub:'Seating Arrangements', diff:'Hard' },
          { id:'ibr8', name:'Rectangular – 8 Person around Table', sub:'Seating Arrangements', diff:'Hard' },
          { id:'ibr9', name:'Misc – Triangular/Hexagonal', sub:'Seating Arrangements', diff:'Hard' },
          { id:'ibr10', name:'Syllogisms – Only/Exception/Cannot Say', sub:'Logic – Syllogism/Inequality/Input', diff:'Medium' },
          { id:'ibr11', name:'Coded Inequalities', sub:'Logic – Syllogism/Inequality/Input', diff:'Medium' },
          { id:'ibr12', name:'Inequality – Reverse/Coded', sub:'Logic – Syllogism/Inequality/Input', diff:'Hard' },
          { id:'ibr13', name:'Input-Output – Single/Multi Step', sub:'Logic – Syllogism/Inequality/Input', diff:'Hard' },
          { id:'ibr14', name:'Blood Relations – Family Tree/Coded', sub:'Data Sufficiency & Blood Relations', diff:'Hard' },
          { id:'ibr15', name:'Direction & Distance', sub:'Data Sufficiency & Blood Relations', diff:'Medium' },
          { id:'ibr16', name:'Data Sufficiency – 2 Statements', sub:'Data Sufficiency & Blood Relations', diff:'Hard' },
          { id:'ibr17', name:'Order & Ranking', sub:'Data Sufficiency & Blood Relations', diff:'Medium' },
          { id:'ibr18', name:'Mirror/Water Image & Paper Fold', sub:'Non-Verbal & Computer Apt', diff:'Easy' },
          { id:'ibr19', name:'Figure Series & Counting', sub:'Non-Verbal & Computer Apt', diff:'Medium' },
          { id:'ibr20', name:'Computer – Hardware/Software/Networks', sub:'Non-Verbal & Computer Apt', diff:'Medium' },
          { id:'ibr21', name:'Memory/OS/Computer Aptitude', sub:'Non-Verbal & Computer Apt', diff:'Medium' },
        ]
      },
      {
        id: 'ibps_quant',
        name: 'Quantitative Aptitude / DI',
        color: '#F59E0B',
        chapters: [
          { id:'ibq1', name:'BODMAS/Approximation/Missing Term', sub:'Simplification & Number System', diff:'Easy' },
          { id:'ibq2', name:'HCF/LCM/Divisibility', sub:'Simplification & Number System', diff:'Medium' },
          { id:'ibq3', name:'Surds & Indices', sub:'Simplification & Number System', diff:'Medium' },
          { id:'ibq4', name:'Quadratic – Root Comparison', sub:'Simplification & Number System', diff:'Hard' },
          { id:'ibq5', name:'Percentage & Ratio', sub:'Arithmetic – I', diff:'Medium' },
          { id:'ibq6', name:'Average & Ages', sub:'Arithmetic – I', diff:'Easy' },
          { id:'ibq7', name:'Mixtures & Alligations', sub:'Arithmetic – I', diff:'Hard' },
          { id:'ibq8', name:'Partnership', sub:'Arithmetic – I', diff:'Medium' },
          { id:'ibq9', name:'TSD – Speed/Trains/Boats', sub:'Arithmetic – II', diff:'Medium' },
          { id:'ibq10', name:'Work & Pipes', sub:'Arithmetic – II', diff:'Medium' },
          { id:'ibq11', name:'Profit-Loss & Discount', sub:'Arithmetic – II', diff:'Medium' },
          { id:'ibq12', name:'SI/CI – Difference/Installments', sub:'Interest, Mensuration, Probability', diff:'Hard' },
          { id:'ibq13', name:'Mensuration – 2D/3D Combos', sub:'Interest, Mensuration, Probability', diff:'Hard' },
          { id:'ibq14', name:'Probability & Permutations', sub:'Interest, Mensuration, Probability', diff:'Hard' },
          { id:'ibq15', name:'Tables – Simple/Missing', sub:'Data Interpretation', diff:'Medium' },
          { id:'ibq16', name:'Bar/Line/Pie Charts', sub:'Data Interpretation', diff:'Medium' },
          { id:'ibq17', name:'Caselet DI', sub:'Data Interpretation', diff:'Hard' },
          { id:'ibq18', name:'Radar/Radial DI', sub:'Data Interpretation', diff:'Hard' },
          { id:'ibq19', name:'Multi-Source Data', sub:'Data Interpretation', diff:'Hard' },
        ]
      },
      {
        id: 'ibps_english',
        name: 'English Language',
        color: '#A855F7',
        chapters: [
          { id:'ibe1', name:'Banking/Economy/Policy Passages', sub:'Reading Comprehension', diff:'Medium' },
          { id:'ibe2', name:'Business/IT Passages', sub:'Reading Comprehension', diff:'Medium' },
          { id:'ibe3', name:'Inference/Theme/Vocab Questions', sub:'Reading Comprehension', diff:'Hard' },
          { id:'ibe4', name:'Error Detection – Subject-Verb/Modifier/Tense', sub:'Grammar & Error Spotting', diff:'Hard' },
          { id:'ibe5', name:'Phrase Replacement – Idioms/Collocations', sub:'Grammar & Error Spotting', diff:'Hard' },
          { id:'ibe6', name:'Fillers – Double/Multiple Blanks', sub:'Grammar & Error Spotting', diff:'Medium' },
          { id:'ibe7', name:'Cloze Test – Contextual/Word Choice', sub:'Verbal Ability', diff:'Medium' },
          { id:'ibe8', name:'Para Jumbles – Coherence/Connectors', sub:'Verbal Ability', diff:'Hard' },
          { id:'ibe9', name:'Para/Sentence Completion', sub:'Verbal Ability', diff:'Hard' },
          { id:'ibe10', name:'Odd One Out', sub:'Verbal Ability', diff:'Medium' },
        ]
      },
      {
        id: 'ibps_banking',
        name: 'Banking & Financial Awareness',
        color: '#3B82F6',
        chapters: [
          { id:'ibb1', name:'RBI – Functions/MPC/Monetary Tools', sub:'Indian Banking System', diff:'Hard' },
          { id:'ibb2', name:'NABARD/SIDBI/EXIM/NHB', sub:'Indian Banking System', diff:'Hard' },
          { id:'ibb3', name:'Public/Private/Co-operative Banks', sub:'Indian Banking System', diff:'Medium' },
          { id:'ibb4', name:'Small Finance/Payments Banks', sub:'Indian Banking System', diff:'Medium' },
          { id:'ibb5', name:'Schemes – PMJDY/PMJJBY/PMSBY/APY', sub:'Financial Awareness', diff:'Medium' },
          { id:'ibb6', name:'Acts – Banking/Lokpal/FEMA/Insolvency', sub:'Financial Awareness', diff:'Hard' },
          { id:'ibb7', name:'Rates – Repo/Reverse/MSF/CRR/SLR', sub:'Financial Awareness', diff:'Medium' },
          { id:'ibb8', name:'Budget – Direct/Indirect Highlights', sub:'Financial Awareness', diff:'Hard' },
          { id:'ibb9', name:'National News – Govt Schemes/Policy', sub:'Current Affairs', diff:'Medium' },
          { id:'ibb10', name:'International – Relations/Summits', sub:'Current Affairs', diff:'Medium' },
          { id:'ibb11', name:'Sports & Awards', sub:'Current Affairs', diff:'Easy' },
          { id:'ibb12', name:'Science & Tech – Digital/Startups/ISRO', sub:'Current Affairs', diff:'Medium' },
        ]
      }
    ]
  },

  upsc: {
    name: 'UPSC CSE',
    fullName: 'UPSC CSE 2026',
    badge: 'UPSC CSE',
    color: '#A855F7',
    examDate: '2026-06-01',
    patternHtml: `
      <div class="info-card">
        <h3>📌 Prelims (Stage I) – Objective</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>Paper I – General Studies</td><td>100</td><td>200</td><td>2 hrs</td></tr>
            <tr><td>Paper II – CSAT</td><td>80</td><td>200</td><td>2 hrs</td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.66 Negative Marking (GS)</span>
          <span class="tag tag-amber">CSAT is qualifying (33%)</span>
          <span class="tag tag-green">Merit on GS Paper I only</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Mains (Stage II) – Descriptive</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Subject</th><th>Marks</th><th>Time</th></tr>
            <tr><td>Essay (A)</td><td>Essay</td><td>250</td><td>3 hrs</td></tr>
            <tr><td>GS Paper I</td><td>History, Culture &amp; Geography</td><td>250</td><td>3 hrs</td></tr>
            <tr><td>GS Paper II</td><td>Polity, Governance &amp; IR</td><td>250</td><td>3 hrs</td></tr>
            <tr><td>GS Paper III</td><td>Economy, S&amp;T, Environment</td><td>250</td><td>3 hrs</td></tr>
            <tr><td>GS Paper IV</td><td>Ethics, Integrity &amp; Aptitude</td><td>250</td><td>3 hrs</td></tr>
            <tr><td>Optional Paper I &amp; II</td><td>Chosen Subject</td><td>500</td><td>3 hrs each</td></tr>
            <tr><td>Language Papers</td><td>Qualifying (Indian + English)</td><td>300+300</td><td>3 hrs each</td></tr>
            <tr><td><strong>Written Total</strong></td><td></td><td><strong>1750</strong></td><td></td></tr>
          </table>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Stage III – Personality Test (Interview)</h3>
        <div class="table-wrap"><table>
          <tr><th>Stage</th><th>Marks</th></tr>
          <tr><td>Mains Written</td><td>1750</td></tr>
          <tr><td>Personality Test / Interview</td><td>275</td></tr>
          <tr><td><strong>Grand Total</strong></td><td><strong>2025</strong></td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age (General)</td><td>21–32 years</td></tr>
          <tr><td>Age (OBC)</td><td>21–35 years</td></tr>
          <tr><td>Age (SC/ST)</td><td>21–37 years</td></tr>
          <tr><td>Education</td><td>Graduation (any stream)</td></tr>
          <tr><td>Attempts (General)</td><td>6 attempts</td></tr>
          <tr><td>Attempts (OBC)</td><td>9 attempts</td></tr>
          <tr><td>Attempts (SC/ST)</td><td>Unlimited till age limit</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'upsc_gsi',
        name: 'GS I – History, Culture & Geography',
        color: '#A855F7',
        chapters: [
          { id:'u1', name:'Prehistoric & Indus Valley', sub:'Ancient India', diff:'Hard' },
          { id:'u2', name:'Vedic Period', sub:'Ancient India', diff:'Easy' },
          { id:'u3', name:'Mahajanapadas & Magadha', sub:'Ancient India', diff:'Hard' },
          { id:'u4', name:'Mauryan Empire', sub:'Ancient India', diff:'Hard' },
          { id:'u5', name:'Post-Mauryan (Sunga/Satavahana/Kushan)', sub:'Ancient India', diff:'Hard' },
          { id:'u6', name:'Gupta & Post-Gupta', sub:'Ancient India', diff:'Easy' },
          { id:'u7', name:'Early Medieval (Rashtrakuta/Pala/Chola)', sub:'Ancient India', diff:'Easy' },
          { id:'u8', name:'Delhi Sultanate – Slave/Khilji/Tughlaq/Sayyid/Lodi', sub:'Medieval India', diff:'Hard' },
          { id:'u9', name:'Vijayanagara & Bahmani', sub:'Medieval India', diff:'Medium' },
          { id:'u10', name:'Mughal Empire – Babur to Aurangzeb', sub:'Medieval India', diff:'Medium' },
          { id:'u11', name:'Bhakti & Sufi Movements', sub:'Medieval India', diff:'Hard' },
          { id:'u12', name:'Maratha Confederacy', sub:'Medieval India', diff:'Medium' },
          { id:'u13', name:'Sikh Empire', sub:'Medieval India', diff:'Hard' },
          { id:'u14', name:'Decline of Mughals', sub:'Medieval India', diff:'Easy' },
          { id:'u15', name:'British Expansion – Carnatic/Bengal/Mysore/Maratha/Sikh', sub:'Modern India & National Movement', diff:'Medium' },
          { id:'u16', name:'Economic Impact – Drain/Land Revenue/Deindustrialisation', sub:'Modern India & National Movement', diff:'Hard' },
          { id:'u17', name:'1857 Revolt – Causes/Spread/Nature', sub:'Modern India & National Movement', diff:'Medium' },
          { id:'u18', name:'Socio-Religious Reforms – Brahmo/Arya/Ramakrishna', sub:'Modern India & National Movement', diff:'Medium' },
          { id:'u19', name:'INC – Moderate/Extremist/Revolutionary Phase', sub:'Modern India & National Movement', diff:'Hard' },
          { id:'u20', name:'Gandhian Phase – Non-Cooperation/CDM/Quit India', sub:'Modern India & National Movement', diff:'Hard' },
          { id:'u21', name:'Partition & Independence', sub:'Modern India & National Movement', diff:'Easy' },
          { id:'u22', name:'Post-Independence Consolidation', sub:'Modern India & National Movement', diff:'Medium' },
          { id:'u23', name:'Temple Architecture – Nagara/Dravidian/Vesara', sub:'Art, Culture & Architecture', diff:'Easy' },
          { id:'u24', name:'Cave & Rock-cut Architecture', sub:'Art, Culture & Architecture', diff:'Medium' },
          { id:'u25', name:'School of Painting', sub:'Art, Culture & Architecture', diff:'Easy' },
          { id:'u26', name:'Music – Hindustani/Carnatic/Folk', sub:'Art, Culture & Architecture', diff:'Hard' },
          { id:'u27', name:'Dance & Theatre Forms', sub:'Art, Culture & Architecture', diff:'Easy' },
          { id:'u28', name:'UNESCO World Heritage Sites in India', sub:'Art, Culture & Architecture', diff:'Easy' },
          { id:'u29', name:'Geomorphology – Earth Structure/Plate Tectonics/Volcanism', sub:'Physical Geography', diff:'Easy' },
          { id:'u30', name:'Climatology – Atmosphere/Weather/Climate Types', sub:'Physical Geography', diff:'Medium' },
          { id:'u31', name:'Oceanography – Currents/Tides/Ocean Relief', sub:'Physical Geography', diff:'Easy' },
          { id:'u32', name:'Biogeography – Biomes/Soils/Vegetation', sub:'Physical Geography', diff:'Hard' },
          { id:'u33', name:'Physiographic Divisions – Himalayas/Plains/Peninsula/Coasts/Islands', sub:'Indian Geography', diff:'Medium' },
          { id:'u34', name:'River Systems – Himalayan/Peninsular', sub:'Indian Geography', diff:'Easy' },
          { id:'u35', name:'Indian Monsoon & Climate', sub:'Indian Geography', diff:'Easy' },
          { id:'u36', name:'Agriculture – Cropping/Green Revolution/Agri Reforms', sub:'Indian Geography', diff:'Medium' },
          { id:'u37', name:'Mineral & Energy Resources', sub:'Indian Geography', diff:'Hard' },
          { id:'u38', name:'Transport & Trade Routes', sub:'Indian Geography', diff:'Easy' },
          { id:'u39', name:'Continents – Physical/Political Overview', sub:'World Geography', diff:'Medium' },
          { id:'u40', name:'World Climate & Biomes', sub:'World Geography', diff:'Medium' },
          { id:'u41', name:'Resources & Industries', sub:'World Geography', diff:'Medium' },
          { id:'u42', name:'Population & Migration', sub:'World Geography', diff:'Medium' },
          { id:'u43', name:'Geopolitical Regions', sub:'World Geography', diff:'Hard' },
        ]
      },
      {
        id: 'upsc_gsii',
        name: 'GS II – Polity, Governance & IR',
        color: '#3B82F6',
        chapters: [
          { id:'u44', name:'Historical Background – Acts 1773-1935', sub:'Indian Constitution – Evolution & Philosophy', diff:'Hard' },
          { id:'u45', name:'Constituent Assembly & Debates', sub:'Indian Constitution – Evolution & Philosophy', diff:'Easy' },
          { id:'u46', name:'Preamble & Basic Structure', sub:'Indian Constitution – Evolution & Philosophy', diff:'Hard' },
          { id:'u47', name:'Citizenship & FRs Art 12-35', sub:'Indian Constitution – Evolution & Philosophy', diff:'Easy' },
          { id:'u48', name:'DPSP & Fundamental Duties', sub:'Indian Constitution – Evolution & Philosophy', diff:'Medium' },
          { id:'u49', name:'Amendment Procedure & Landmark Amendments', sub:'Indian Constitution – Evolution & Philosophy', diff:'Hard' },
          { id:'u50', name:'President – Election/Powers/Impeachment', sub:'Union & State Executive', diff:'Easy' },
          { id:'u51', name:'PM & Council of Ministers', sub:'Union & State Executive', diff:'Medium' },
          { id:'u52', name:'Governor & CM', sub:'Union & State Executive', diff:'Medium' },
          { id:'u53', name:'Parliament – RS/LS/Committees/Proceedings', sub:'Union & State Executive', diff:'Hard' },
          { id:'u54', name:'State Legislature', sub:'Union & State Executive', diff:'Hard' },
          { id:'u55', name:'Supreme Court & High Courts – Powers/Jurisdiction', sub:'Union & State Executive', diff:'Medium' },
          { id:'u56', name:'Centre-State Relations – Legislative/Admin/Financial', sub:'Federalism & Local Govt', diff:'Medium' },
          { id:'u57', name:'Inter-State Council & Zonal Councils', sub:'Federalism & Local Govt', diff:'Easy' },
          { id:'u58', name:'Panchayati Raj – 73rd Amendment', sub:'Federalism & Local Govt', diff:'Medium' },
          { id:'u59', name:'Municipalities – 74th Amendment', sub:'Federalism & Local Govt', diff:'Medium' },
          { id:'u60', name:'Language Policy', sub:'Federalism & Local Govt', diff:'Easy' },
          { id:'u61', name:'E-governance & Digital India', sub:'Governance & Social Justice', diff:'Medium' },
          { id:'u62', name:'Citizens Charters & RTI', sub:'Governance & Social Justice', diff:'Hard' },
          { id:'u63', name:'Lokpal & Lokayukta', sub:'Governance & Social Justice', diff:'Easy' },
          { id:'u64', name:'Welfare Schemes – Education/Health/Nutrition', sub:'Governance & Social Justice', diff:'Hard' },
          { id:'u65', name:'Social Justice – SC/ST/OBC/Minorities/Women/Children', sub:'Governance & Social Justice', diff:'Medium' },
          { id:'u66', name:'NGOs & Civil Society', sub:'Governance & Social Justice', diff:'Hard' },
          { id:'u67', name:'India Foreign Policy – Basics', sub:'International Relations', diff:'Hard' },
          { id:'u68', name:'Neighbours – Pak/China/Bangla/Nepal/Sri Lanka/Myanmar', sub:'International Relations', diff:'Hard' },
          { id:'u69', name:'Major Powers – US/Russia/EU/Japan/Australia', sub:'International Relations', diff:'Medium' },
          { id:'u70', name:'Multilateral – UN/IMF/WB/WTO/G20/SCO/BRICS', sub:'International Relations', diff:'Easy' },
          { id:'u71', name:'Security – Nuclear/CTBT/India & Terrorism', sub:'International Relations', diff:'Hard' },
          { id:'u72', name:'Global Commons – Arctic/Oceans/Cyberspace', sub:'International Relations', diff:'Hard' },
        ]
      },
      {
        id: 'upsc_gsiii',
        name: 'GS III – Economy, S&T, Environment & Security',
        color: '#F59E0B',
        chapters: [
          { id:'u73', name:'National Income – GDP/GNP/Inflation', sub:'Indian Economy – Macro', diff:'Hard' },
          { id:'u74', name:'Budget – Receipts/Expenditure/Deficit', sub:'Indian Economy – Macro', diff:'Medium' },
          { id:'u75', name:'Banking – RBI/NBFCs/Fintech', sub:'Indian Economy – Macro', diff:'Easy' },
          { id:'u76', name:'Monetary & Fiscal Policy', sub:'Indian Economy – Macro', diff:'Easy' },
          { id:'u77', name:'Financial Markets – Capital/Money/Insurance', sub:'Indian Economy – Macro', diff:'Medium' },
          { id:'u78', name:'Agriculture – MSP/PM-KISAN/Fertiliser/Livestock', sub:'Indian Economy – Sectors', diff:'Hard' },
          { id:'u79', name:'Industry – IPR/Startups/SEZs/PLI', sub:'Indian Economy – Sectors', diff:'Hard' },
          { id:'u80', name:'Infrastructure – Energy/Transport/Telecom/PPP', sub:'Indian Economy – Sectors', diff:'Easy' },
          { id:'u81', name:'External Sector – BoP/FDI/FEMA/EXIM', sub:'Indian Economy – Sectors', diff:'Hard' },
          { id:'u82', name:'Space – ISRO/Gaganyaan/Missions', sub:'Science & Technology', diff:'Medium' },
          { id:'u83', name:'Defence – Missiles/Nuclear/DRDO/Cyber', sub:'Science & Technology', diff:'Hard' },
          { id:'u84', name:'Biotech – GMO/Vaccine/Stem Cell', sub:'Science & Technology', diff:'Hard' },
          { id:'u85', name:'IT & Digital – AI/Block-chain/5G/Cloud', sub:'Science & Technology', diff:'Medium' },
          { id:'u86', name:'Environment – Biodiversity/Hotspots/IUCN', sub:'Environment & Ecology', diff:'Medium' },
          { id:'u87', name:'Climate Change – IPCC/Paris/NDC/Net-Zero', sub:'Environment & Ecology', diff:'Easy' },
          { id:'u88', name:'Pollution – Air/Water/Soil/Noise', sub:'Environment & Ecology', diff:'Medium' },
          { id:'u89', name:'Protected Areas – National Parks/Biosphere Reserves', sub:'Environment & Ecology', diff:'Easy' },
          { id:'u90', name:'International Conventions – CITES/Ramsar/CBD/UNFCCC', sub:'Environment & Ecology', diff:'Medium' },
          { id:'u91', name:'Disaster Management – NDMA/SDMA/Sendai', sub:'Internal Security', diff:'Medium' },
          { id:'u92', name:'Left Wing Extremism & Border Issues', sub:'Internal Security', diff:'Hard' },
          { id:'u93', name:'Terrorism & Organized Crime', sub:'Internal Security', diff:'Hard' },
          { id:'u94', name:'Cybersecurity & Media Challenges', sub:'Internal Security', diff:'Medium' },
          { id:'u95', name:'Money Laundering & Human Trafficking', sub:'Internal Security', diff:'Hard' },
          { id:'u96', name:'Defence – Civil-Military Relations', sub:'Internal Security', diff:'Hard' },
          { id:'u97', name:'Border Management & Agencies', sub:'Internal Security', diff:'Medium' },
        ]
      },
      {
        id: 'upsc_gsiv',
        name: 'GS IV – Ethics, Integrity & Aptitude',
        color: '#EF4444',
        chapters: [
          { id:'u98', name:'Essence & Determinants of Ethics', sub:'Ethics & Moral Philosophy', diff:'Medium' },
          { id:'u99', name:'Human Values – Lessons from Lives & Teachings', sub:'Ethics & Moral Philosophy', diff:'Easy' },
          { id:'u100', name:'Attitude – Content/Structure/Function/Change', sub:'Ethics & Moral Philosophy', diff:'Medium' },
          { id:'u101', name:'Moral Thinkers – Western & Indian', sub:'Ethics & Moral Philosophy', diff:'Hard' },
          { id:'u102', name:'Aptitude & Foundational Values for Civil Services', sub:'Civil Service Values', diff:'Easy' },
          { id:'u103', name:'Integrity, Impartiality & Dedication to Public Service', sub:'Civil Service Values', diff:'Easy' },
          { id:'u104', name:'Empathy, Tolerance & Compassion', sub:'Civil Service Values', diff:'Easy' },
          { id:'u105', name:'Emotional Intelligence – Concepts & Utility', sub:'Civil Service Values', diff:'Medium' },
          { id:'u106', name:'Probity in Governance – Concept of Public Service', sub:'Governance & Ethics', diff:'Medium' },
          { id:'u107', name:'Philosophical Basis of Governance', sub:'Governance & Ethics', diff:'Hard' },
          { id:'u108', name:'Information Sharing & Transparency', sub:'Governance & Ethics', diff:'Medium' },
          { id:'u109', name:'Codes of Ethics – Citizens Charter/Work Culture', sub:'Governance & Ethics', diff:'Medium' },
          { id:'u110', name:'Ethics in Public/Private Relations', sub:'Applied Ethics', diff:'Hard' },
          { id:'u111', name:'Corporate Governance', sub:'Applied Ethics', diff:'Medium' },
          { id:'u112', name:'Social Audit/Accountability Mechanisms', sub:'Applied Ethics', diff:'Medium' },
          { id:'u113', name:'Case Studies – Ethical Dilemmas', sub:'Applied Ethics', diff:'Hard' },
          { id:'u114', name:'Whistle Blowing & Conflict of Interest', sub:'Applied Ethics', diff:'Hard' },
          { id:'u115', name:'Laws/Rules/Regulations & Conscience', sub:'Applied Ethics', diff:'Hard' },
          { id:'u116', name:'International Relations & Funding Bodies – Ethical Issues', sub:'Applied Ethics', diff:'Hard' },
          { id:'u117', name:'Corruption – Causes/Remedies/Case Studies', sub:'Applied Ethics', diff:'Hard' },
          { id:'u118', name:'Ethics in Governance – Models/Frameworks', sub:'Applied Ethics', diff:'Hard' },
        ]
      },
      {
        id: 'upsc_csat',
        name: 'CSAT – Paper II (Qualifying)',
        color: '#00C896',
        chapters: [
          { id:'u119', name:'Reading Comprehension – Inference/Theme', sub:'Comprehension', diff:'Medium' },
          { id:'u120', name:'Reading Comprehension – Vocab/Tone', sub:'Comprehension', diff:'Medium' },
          { id:'u121', name:'Logical Reasoning – Syllogism/Assumptions', sub:'Reasoning', diff:'Medium' },
          { id:'u122', name:'Analytical Ability – Statements & Arguments', sub:'Reasoning', diff:'Hard' },
          { id:'u123', name:'Decision Making & Problem Solving', sub:'Reasoning', diff:'Hard' },
          { id:'u124', name:'Number System & Simplification', sub:'Basic Numeracy', diff:'Easy' },
          { id:'u125', name:'Data Interpretation – Tables/Bar/Pie', sub:'Basic Numeracy', diff:'Medium' },
          { id:'u126', name:'Percentage/Ratio/Proportion/Average', sub:'Basic Numeracy', diff:'Easy' },
          { id:'u127', name:'Time/Speed/Distance/Work', sub:'Basic Numeracy', diff:'Medium' },
          { id:'u128', name:'Profit-Loss/SI-CI/Mensuration', sub:'Basic Numeracy', diff:'Medium' },
          { id:'u129', name:'Series – Number/Letter', sub:'General Mental Ability', diff:'Easy' },
          { id:'u130', name:'Coding-Decoding & Analogy', sub:'General Mental Ability', diff:'Easy' },
          { id:'u131', name:'Direction & Blood Relations', sub:'General Mental Ability', diff:'Medium' },
          { id:'u132', name:'Clocks & Calendar', sub:'General Mental Ability', diff:'Medium' },
          { id:'u133', name:'Seating Arrangements & Puzzles', sub:'General Mental Ability', diff:'Hard' },
          { id:'u134', name:'English Communication – Basic Grammar/Vocabulary', sub:'Comprehension', diff:'Easy' },
        ]
      }
    ]
  },

  uppcs: {
    name: 'UPPCS',
    fullName: 'UPPCS (UPPSC PCS) 2026',
    badge: 'UPPCS',
    color: '#EA580C',
    examDate: '2026-03-22',
    patternHtml: `
      <div class="info-card">
        <h3>📌 Stage I – Preliminary Examination (Objective)</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>Paper I – General Studies</td><td>150</td><td>200</td><td>2 hrs</td></tr>
            <tr><td>Paper II – CSAT (Qualifying)</td><td>100</td><td>200</td><td>2 hrs</td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–0.33 Negative Marking</span>
          <span class="tag tag-amber">CSAT qualifying (min 33%)</span>
          <span class="tag tag-green">Merit on GS Paper I only</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Stage II – Mains Examination (Descriptive)</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Subject</th><th>Marks</th><th>Time</th></tr>
            <tr><td>Paper 1</td><td>General Hindi</td><td>150</td><td>3 hrs</td></tr>
            <tr><td>Paper 2</td><td>Essay</td><td>150</td><td>3 hrs</td></tr>
            <tr><td>Paper 3</td><td>General Studies I</td><td>200</td><td>3 hrs</td></tr>
            <tr><td>Paper 4</td><td>General Studies II</td><td>200</td><td>3 hrs</td></tr>
            <tr><td>Paper 5</td><td>General Studies III</td><td>200</td><td>3 hrs</td></tr>
            <tr><td>Paper 6</td><td>General Studies IV (Ethics)</td><td>200</td><td>3 hrs</td></tr>
            <tr><td>Paper 7</td><td>General Studies V (UP Special)</td><td>200</td><td>3 hrs</td></tr>
            <tr><td>Paper 8</td><td>General Studies VI (UP Special)</td><td>200</td><td>3 hrs</td></tr>
            <tr><td><strong>Total</strong></td><td></td><td><strong>1500</strong></td><td></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-green">No Negative Marking</span>
          <span class="tag tag-amber">Optional removed since 2023</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Stage III – Interview / Personality Test</h3>
        <div class="table-wrap"><table>
          <tr><th>Stage</th><th>Marks</th></tr>
          <tr><td>Mains Written</td><td>1500</td></tr>
          <tr><td>Interview / Personality Test</td><td>100</td></tr>
          <tr><td><strong>Grand Total</strong></td><td><strong>1600</strong></td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age (General)</td><td>21–40 years</td></tr>
          <tr><td>Age Relaxation</td><td>+5 yrs (SC/ST/OBC of UP), as per rules</td></tr>
          <tr><td>Education</td><td>Bachelor's Degree (any stream)</td></tr>
          <tr><td>Nationality</td><td>Indian Citizen</td></tr>
          <tr><td>Conducting Body</td><td>UPPSC (uppsc.up.nic.in)</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'uppcs_history',
        name: 'History & National Movement',
        color: '#A855F7',
        chapters: [
          { id:'upph1', name:'Sources of Ancient Indian History', sub:'Ancient India', diff:'Easy' },
          { id:'upph2', name:'Indus Valley Civilization', sub:'Ancient India', diff:'Medium' },
          { id:'upph3', name:'Vedic Age – Early & Later', sub:'Ancient India', diff:'Medium' },
          { id:'upph4', name:'Buddhism & Jainism', sub:'Ancient India', diff:'Medium' },
          { id:'upph5', name:'Mahajanapadas & Rise of Magadha', sub:'Ancient India', diff:'Hard' },
          { id:'upph6', name:'Mauryan Empire – Chandragupta/Ashoka/Dhamma', sub:'Ancient India', diff:'Medium' },
          { id:'upph7', name:'Post-Mauryan – Sungas/Kushanas/Satavahanas', sub:'Ancient India', diff:'Hard' },
          { id:'upph8', name:'Gupta Empire – Golden Age', sub:'Ancient India', diff:'Easy' },
          { id:'upph9', name:'Sangam Age & South India', sub:'Ancient India', diff:'Medium' },
          { id:'upph10', name:'Arab, Ghazni & Ghorid Invasions', sub:'Medieval India', diff:'Medium' },
          { id:'upph11', name:'Delhi Sultanate – Slave to Lodi', sub:'Medieval India', diff:'Hard' },
          { id:'upph12', name:'Bhakti Movement', sub:'Medieval India', diff:'Medium' },
          { id:'upph13', name:'Sufi Movement', sub:'Medieval India', diff:'Medium' },
          { id:'upph14', name:'Vijayanagara & Bahmani Kingdoms', sub:'Medieval India', diff:'Medium' },
          { id:'upph15', name:'Mughal Empire – Babur to Aurangzeb', sub:'Medieval India', diff:'Medium' },
          { id:'upph16', name:'Mughal Art, Architecture & Culture', sub:'Medieval India', diff:'Easy' },
          { id:'upph17', name:'Marathas & Shivaji', sub:'Medieval India', diff:'Medium' },
          { id:'upph18', name:'Decline of the Mughal Empire', sub:'Medieval India', diff:'Easy' },
          { id:'upph19', name:'Advent of Europeans', sub:'Modern India & Freedom Struggle', diff:'Easy' },
          { id:'upph20', name:'British Expansion – Plassey & Buxar', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph21', name:'British Administrative & Economic Policies', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'upph22', name:'Socio-Religious Reform Movements', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph23', name:'Revolt of 1857 (incl. UP\u2019s role)', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph24', name:'Rise of Nationalism & INC (1885)', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph25', name:'Moderate & Extremist Phases', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'upph26', name:'Partition of Bengal & Swadeshi (1905)', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph27', name:'Gandhian Movements – NCM/CDM/Quit India', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'upph28', name:'Revolutionary Nationalism', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph29', name:'Subhas Chandra Bose & INA', sub:'Modern India & Freedom Struggle', diff:'Easy' },
          { id:'upph30', name:'Government of India Act 1935', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'upph31', name:'Independence, Partition & Integration of States', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph32', name:'Post-Independence Consolidation (till 1965)', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'upph33', name:'Industrial Revolution', sub:'World History', diff:'Medium' },
          { id:'upph34', name:'French Revolution', sub:'World History', diff:'Medium' },
          { id:'upph35', name:'World War I & Treaty of Versailles', sub:'World History', diff:'Medium' },
          { id:'upph36', name:'Russian Revolution (1917)', sub:'World History', diff:'Hard' },
          { id:'upph37', name:'Rise of Fascism & Nazism', sub:'World History', diff:'Medium' },
          { id:'upph38', name:'World War II & Cold War', sub:'World History', diff:'Medium' },
          { id:'upph39', name:'Decolonization – Asia & Africa', sub:'World History', diff:'Hard' },
          { id:'upph40', name:'Indian Architecture & Sculpture', sub:'Art & Culture', diff:'Medium' },
          { id:'upph41', name:'Indian Painting Traditions', sub:'Art & Culture', diff:'Easy' },
          { id:'upph42', name:'Classical & Folk Music', sub:'Art & Culture', diff:'Hard' },
          { id:'upph43', name:'Classical & Folk Dance', sub:'Art & Culture', diff:'Easy' },
          { id:'upph44', name:'Indian Literature & Religions', sub:'Art & Culture', diff:'Medium' },
        ]
      },
      {
        id: 'uppcs_geo',
        name: 'Geography',
        color: '#0EA5E9',
        chapters: [
          { id:'uppg1', name:'Geomorphology – Earth Structure & Landforms', sub:'Physical Geography', diff:'Medium' },
          { id:'uppg2', name:'Climatology – Atmosphere & Weather', sub:'Physical Geography', diff:'Medium' },
          { id:'uppg3', name:'Oceanography – Currents & Tides', sub:'Physical Geography', diff:'Easy' },
          { id:'uppg4', name:'Physiographic Divisions of India', sub:'Indian Geography', diff:'Medium' },
          { id:'uppg5', name:'Drainage System & River Systems', sub:'Indian Geography', diff:'Easy' },
          { id:'uppg6', name:'Indian Monsoon & Climate', sub:'Indian Geography', diff:'Medium' },
          { id:'uppg7', name:'Soils & Natural Vegetation', sub:'Indian Geography', diff:'Easy' },
          { id:'uppg8', name:'Agriculture & Cropping Patterns', sub:'Indian Geography', diff:'Medium' },
          { id:'uppg9', name:'Minerals & Industries', sub:'Indian Geography', diff:'Hard' },
          { id:'uppg10', name:'Transport, Ports & Trade', sub:'Indian Geography', diff:'Easy' },
          { id:'uppg11', name:'Population & Census', sub:'Indian Geography', diff:'Medium' },
          { id:'uppg12', name:'Major Physical Features of the World', sub:'World Geography', diff:'Medium' },
          { id:'uppg13', name:'World Climatic Zones & Biomes', sub:'World Geography', diff:'Medium' },
          { id:'uppg14', name:'World Resources & Industries', sub:'World Geography', diff:'Medium' },
          { id:'uppg15', name:'Countries, Capitals & Geopolitics', sub:'World Geography', diff:'Hard' },
          { id:'uppg16', name:'Important Rivers, Lakes, Straits & Passes', sub:'World Geography', diff:'Medium' },
        ]
      },
      {
        id: 'uppcs_polity',
        name: 'Polity & Governance',
        color: '#3B82F6',
        chapters: [
          { id:'uppp1', name:'Making & Features of the Constitution', sub:'Constitution', diff:'Easy' },
          { id:'uppp2', name:'Preamble, FR, DPSP & Fundamental Duties', sub:'Constitution', diff:'Medium' },
          { id:'uppp3', name:'Important Constitutional Amendments', sub:'Constitution', diff:'Hard' },
          { id:'uppp4', name:'President, Vice-President & Governor', sub:'Union & State Government', diff:'Medium' },
          { id:'uppp5', name:'PM, CM & Council of Ministers', sub:'Union & State Government', diff:'Easy' },
          { id:'uppp6', name:'Parliament & State Legislature', sub:'Union & State Government', diff:'Hard' },
          { id:'uppp7', name:'Supreme Court & High Courts', sub:'Judiciary & Federalism', diff:'Medium' },
          { id:'uppp8', name:'Centre-State Relations', sub:'Judiciary & Federalism', diff:'Medium' },
          { id:'uppp9', name:'Emergency Provisions', sub:'Judiciary & Federalism', diff:'Medium' },
          { id:'uppp10', name:'Panchayati Raj & Local Self-Government', sub:'Judiciary & Federalism', diff:'Medium' },
          { id:'uppp11', name:'Constitutional & Statutory Bodies (EC/CAG/UPSC/FC)', sub:'Governance & Rights', diff:'Hard' },
          { id:'uppp12', name:'NITI Aayog & Non-Constitutional Bodies', sub:'Governance & Rights', diff:'Easy' },
          { id:'uppp13', name:'Governance – RTI/e-Governance/Citizens Charter', sub:'Governance & Rights', diff:'Medium' },
          { id:'uppp14', name:'Rights Issues – Women/SC-ST/Consumer', sub:'Governance & Rights', diff:'Medium' },
          { id:'uppp15', name:'Probity, Lokpal & Anti-Corruption', sub:'Governance & Rights', diff:'Medium' },
          { id:'uppp16', name:'India & International Relations (Mains GS II)', sub:'Governance & Rights', diff:'Hard' },
        ]
      },
      {
        id: 'uppcs_economy',
        name: 'Economy & Social Development',
        color: '#F59E0B',
        chapters: [
          { id:'uppe1', name:'Basic Concepts – GDP/National Income/Inflation', sub:'Macro Economy', diff:'Hard' },
          { id:'uppe2', name:'Economic Planning & NITI Aayog', sub:'Macro Economy', diff:'Easy' },
          { id:'uppe3', name:'Banking & RBI / Monetary Policy', sub:'Macro Economy', diff:'Medium' },
          { id:'uppe4', name:'Budget, Fiscal Policy & Taxation (GST)', sub:'Macro Economy', diff:'Hard' },
          { id:'uppe5', name:'Financial Markets & External Sector', sub:'Macro Economy', diff:'Medium' },
          { id:'uppe6', name:'Agriculture & Rural Economy', sub:'Sectors & Infrastructure', diff:'Medium' },
          { id:'uppe7', name:'Industry, MSME & Infrastructure', sub:'Sectors & Infrastructure', diff:'Easy' },
          { id:'uppe8', name:'Energy & Transport Infrastructure', sub:'Sectors & Infrastructure', diff:'Medium' },
          { id:'uppe9', name:'Poverty, Unemployment & Inequality', sub:'Social Development', diff:'Hard' },
          { id:'uppe10', name:'Inclusive Growth – SHGs / Microfinance', sub:'Social Development', diff:'Medium' },
          { id:'uppe11', name:'Government Schemes & Social Sector', sub:'Social Development', diff:'Medium' },
          { id:'uppe12', name:'Sustainable Development Goals & HDI', sub:'Social Development', diff:'Easy' },
          { id:'uppe13', name:'Demographic Dividend & Population', sub:'Social Development', diff:'Medium' },
        ]
      },
      {
        id: 'uppcs_env',
        name: 'Environment, Ecology & Disaster Mgmt',
        color: '#10B981',
        chapters: [
          { id:'uppv1', name:'Ecosystem – Components & Functions', sub:'Ecology & Biodiversity', diff:'Easy' },
          { id:'uppv2', name:'Biodiversity – Hotspots & Threats', sub:'Ecology & Biodiversity', diff:'Medium' },
          { id:'uppv3', name:'Conservation – Parks/Sanctuaries/Acts', sub:'Ecology & Biodiversity', diff:'Easy' },
          { id:'uppv4', name:'Climate Change & Global Warming', sub:'Climate & Pollution', diff:'Medium' },
          { id:'uppv5', name:'Pollution – Air/Water/Soil/Noise', sub:'Climate & Pollution', diff:'Medium' },
          { id:'uppv6', name:'Environmental Laws & Institutions (NGT/EIA)', sub:'Climate & Pollution', diff:'Hard' },
          { id:'uppv7', name:'International Conventions (Paris/CITES/Ramsar)', sub:'Climate & Pollution', diff:'Medium' },
          { id:'uppv8', name:'Disaster Management – NDMA & Cycle', sub:'Disaster Management', diff:'Medium' },
          { id:'uppv9', name:'Natural Disasters – Floods/Droughts/Earthquakes', sub:'Disaster Management', diff:'Easy' },
        ]
      },
      {
        id: 'uppcs_science',
        name: 'General Science & Technology',
        color: '#14B8A6',
        chapters: [
          { id:'upps1', name:'Physics – Motion/Force/Energy', sub:'Physics', diff:'Medium' },
          { id:'upps2', name:'Physics – Light/Sound/Electricity/Magnetism', sub:'Physics', diff:'Medium' },
          { id:'upps3', name:'Chemistry – Periodic Table & Reactions', sub:'Chemistry', diff:'Easy' },
          { id:'upps4', name:'Chemistry – Acids/Bases/Metals/Carbon Compounds', sub:'Chemistry', diff:'Easy' },
          { id:'upps5', name:'Biology – Cell & Plant Physiology', sub:'Biology', diff:'Medium' },
          { id:'upps6', name:'Biology – Human Physiology & Systems', sub:'Biology', diff:'Medium' },
          { id:'upps7', name:'Biology – Genetics, Health & Diseases', sub:'Biology', diff:'Easy' },
          { id:'upps8', name:'Space Technology – ISRO & Missions', sub:'Science & Technology', diff:'Medium' },
          { id:'upps9', name:'Defence Technology – DRDO & Missiles', sub:'Science & Technology', diff:'Medium' },
          { id:'upps10', name:'IT, AI, Biotech & Nanotech', sub:'Science & Technology', diff:'Hard' },
          { id:'upps11', name:'Nuclear Technology', sub:'Science & Technology', diff:'Hard' },
        ]
      },
      {
        id: 'uppcs_ca',
        name: 'Current Affairs',
        color: '#EC4899',
        chapters: [
          { id:'uppc1', name:'National Affairs & Government Schemes', sub:'Current Affairs', diff:'Medium' },
          { id:'uppc2', name:'International Affairs & Summits', sub:'Current Affairs', diff:'Medium' },
          { id:'uppc3', name:'Economy & Banking News', sub:'Current Affairs', diff:'Medium' },
          { id:'uppc4', name:'Science & Technology News', sub:'Current Affairs', diff:'Easy' },
          { id:'uppc5', name:'Sports – Events & Winners', sub:'Current Affairs', diff:'Easy' },
          { id:'uppc6', name:'Awards & Honours', sub:'Current Affairs', diff:'Easy' },
          { id:'uppc7', name:'Persons, Books & Important Days', sub:'Current Affairs', diff:'Medium' },
          { id:'uppc8', name:'Reports & Indices', sub:'Current Affairs', diff:'Hard' },
        ]
      },
      {
        id: 'uppcs_ethics',
        name: 'Ethics, Integrity & Aptitude (GS IV)',
        color: '#EF4444',
        chapters: [
          { id:'upet1', name:'Essence & Determinants of Ethics', sub:'Ethics & Attitude', diff:'Medium' },
          { id:'upet2', name:'Attitude – Content/Structure/Change', sub:'Ethics & Attitude', diff:'Medium' },
          { id:'upet3', name:'Aptitude & Foundational Values (Integrity/Impartiality)', sub:'Ethics & Attitude', diff:'Easy' },
          { id:'upet4', name:'Emotional Intelligence', sub:'Ethics & Attitude', diff:'Medium' },
          { id:'upet5', name:'Moral Thinkers – Indian & Western', sub:'Governance & Ethics', diff:'Hard' },
          { id:'upet6', name:'Public Service Values & Ethics in Administration', sub:'Governance & Ethics', diff:'Medium' },
          { id:'upet7', name:'Probity in Governance', sub:'Governance & Ethics', diff:'Medium' },
          { id:'upet8', name:'Case Studies – Ethical Dilemmas', sub:'Governance & Ethics', diff:'Hard' },
        ]
      },
      {
        id: 'uppcs_csat',
        name: 'CSAT – Paper II (Qualifying)',
        color: '#00C896',
        chapters: [
          { id:'upcs1', name:'Reading Comprehension (Hindi & English)', sub:'Comprehension & Communication', diff:'Medium' },
          { id:'upcs2', name:'Interpersonal & Communication Skills', sub:'Comprehension & Communication', diff:'Easy' },
          { id:'upcs3', name:'Logical Reasoning & Analytical Ability', sub:'Reasoning & Mental Ability', diff:'Medium' },
          { id:'upcs4', name:'Decision Making & Problem Solving', sub:'Reasoning & Mental Ability', diff:'Hard' },
          { id:'upcs5', name:'General Mental Ability – Series/Coding/Analogy', sub:'Reasoning & Mental Ability', diff:'Easy' },
          { id:'upcs6', name:'Blood Relations, Direction & Syllogism', sub:'Reasoning & Mental Ability', diff:'Medium' },
          { id:'upcs7', name:'Arithmetic – Percentage/Ratio/Average/TSD', sub:'Basic Numeracy', diff:'Medium' },
          { id:'upcs8', name:'Algebra, Geometry & Mensuration', sub:'Basic Numeracy', diff:'Medium' },
          { id:'upcs9', name:'Data Interpretation & Statistics', sub:'Basic Numeracy', diff:'Medium' },
          { id:'upcs10', name:'General Hindi (Class X Level)', sub:'Language (Hindi/English)', diff:'Easy' },
          { id:'upcs11', name:'General English (Class X Level)', sub:'Language (Hindi/English)', diff:'Easy' },
        ]
      },
      {
        id: 'uppcs_up',
        name: '⭐ Uttar Pradesh Special (GS V & VI)',
        color: '#EA580C',
        chapters: [
          { id:'upup1', name:'Ancient & Medieval UP – Ayodhya/Sarnath/Agra/Lucknow', sub:'UP History & Culture', diff:'Medium' },
          { id:'upup2', name:'UP in the Freedom Struggle', sub:'UP History & Culture', diff:'Medium' },
          { id:'upup3', name:'UP Folk Art, Dance & Music (Nautanki/Kajri/Birha)', sub:'UP History & Culture', diff:'Hard' },
          { id:'upup4', name:'UP Festivals – Kumbh/Kartik Purnima', sub:'UP History & Culture', diff:'Easy' },
          { id:'upup5', name:'Languages & Dialects of UP (Awadhi/Braj/Bhojpuri/Bundeli)', sub:'UP History & Culture', diff:'Medium' },
          { id:'upup6', name:'Physical Features & Rivers of UP', sub:'UP Geography & Resources', diff:'Easy' },
          { id:'upup7', name:'Agriculture of UP – Wheat/Sugarcane/Potato', sub:'UP Geography & Resources', diff:'Medium' },
          { id:'upup8', name:'Forests, Wildlife & Resources of UP', sub:'UP Geography & Resources', diff:'Medium' },
          { id:'upup9', name:'Climate & Disaster-Prone Regions of UP', sub:'UP Geography & Resources', diff:'Medium' },
          { id:'upup10', name:'UP Vidhan Sabha & Vidhan Parishad', sub:'UP Polity & Administration', diff:'Medium' },
          { id:'upup11', name:'Governor, CM & UP Administration', sub:'UP Polity & Administration', diff:'Easy' },
          { id:'upup12', name:'UPPSC, UP Lokayukta & Allahabad High Court', sub:'UP Polity & Administration', diff:'Medium' },
          { id:'upup13', name:'UP Police & Law-and-Order Machinery', sub:'UP Polity & Administration', diff:'Medium' },
          { id:'upup14', name:'Economy of UP – GSDP/Sectors/Budget', sub:'UP Economy & Schemes', diff:'Hard' },
          { id:'upup15', name:'Industries of UP – ODOP/Leather/Glass/Carpet', sub:'UP Economy & Schemes', diff:'Medium' },
          { id:'upup16', name:'UP Expressways, Metro & Airports', sub:'UP Economy & Schemes', diff:'Easy' },
          { id:'upup17', name:'UP Energy & Power Projects', sub:'UP Economy & Schemes', diff:'Medium' },
          { id:'upup18', name:'UP Welfare Schemes – Mission Shakti/Kanya Sumangala/Abhyudaya', sub:'UP Economy & Schemes', diff:'Medium' },
          { id:'upup19', name:'Tourism of UP – Religious/Heritage/Buddhist Circuit', sub:'UP Tourism & Current Affairs', diff:'Easy' },
          { id:'upup20', name:'UP Current Affairs & Investment Summits', sub:'UP Tourism & Current Affairs', diff:'Medium' },
        ]
      },
      {
        id: 'uppcs_hindi',
        name: 'General Hindi & Essay (Mains)',
        color: '#F97316',
        chapters: [
          { id:'uphn1', name:'वर्णमाला, शब्द विचार व वर्तनी शुद्धि', sub:'सामान्य हिंदी (General Hindi)', diff:'Easy' },
          { id:'uphn2', name:'शब्द-भंडार – पर्यायवाची/विलोम/अनेकार्थी', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'uphn3', name:'संधि व समास', sub:'सामान्य हिंदी (General Hindi)', diff:'Hard' },
          { id:'uphn4', name:'शब्द-रूप, क्रिया व वाक्य रचना', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'uphn5', name:'मुहावरे व लोकोक्तियाँ', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'uphn6', name:'पत्र लेखन (सरकारी/अर्धसरकारी)', sub:'सामान्य हिंदी (General Hindi)', diff:'Easy' },
          { id:'uphn7', name:'गद्यांश अवबोध व संक्षेपण', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'uphn8', name:'उत्तर प्रदेश की बोलियाँ (अवधी/ब्रज/भोजपुरी/बुंदेली)', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'uphn9', name:'निबंध – साहित्य/संस्कृति/राजनीति', sub:'निबंध (Essay)', diff:'Medium' },
          { id:'uphn10', name:'निबंध – विज्ञान/पर्यावरण/अर्थव्यवस्था', sub:'निबंध (Essay)', diff:'Medium' },
          { id:'uphn11', name:'निबंध – सामाजिक/राष्ट्रीय घटनाएँ/आपदाएँ', sub:'निबंध (Essay)', diff:'Hard' },
        ]
      }
    ]
  },

  bpsc: {
    name: 'BPSC',
    fullName: 'BPSC (Combined Competitive Exam) 2026',
    badge: 'BPSC',
    color: '#0891B2',
    examDate: '2026-05-10',
    patternHtml: `
      <div class="info-card">
        <h3>📌 Stage I – Preliminary Examination (Objective)</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Questions</th><th>Max Marks</th><th>Time</th></tr>
            <tr><td>General Studies</td><td>150</td><td>150</td><td>2 hrs</td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-red">–1/3 Negative Marking</span>
          <span class="tag tag-amber">Qualifying (Shortlisting)</span>
          <span class="tag tag-green">Single GS Paper</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Stage II – Mains Examination (Descriptive)</h3>
        <div class="table-wrap">
          <table>
            <tr><th>Paper</th><th>Subject</th><th>Marks</th><th>Type</th></tr>
            <tr><td>Paper 1</td><td>General Hindi</td><td>100</td><td>Qualifying (min 30%)</td></tr>
            <tr><td>Paper 2</td><td>General Studies I</td><td>300</td><td>Merit</td></tr>
            <tr><td>Paper 3</td><td>General Studies II</td><td>300</td><td>Merit</td></tr>
            <tr><td>Paper 4</td><td>Essay</td><td>300</td><td>Merit</td></tr>
            <tr><td>Paper 5</td><td>Optional Subject</td><td>100</td><td>Qualifying (MCQ)</td></tr>
            <tr><td><strong>Total</strong></td><td></td><td><strong>1100</strong></td><td><strong>900 for merit</strong></td></tr>
          </table>
        </div>
        <div style="margin-top:0.85rem;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="tag tag-green">No Negative Marking (Descriptive)</span>
          <span class="tag tag-amber">Essay carries highest weight (300)</span>
        </div>
      </div>
      <div class="info-card">
        <h3>📌 Stage III – Interview / Personality Test</h3>
        <div class="table-wrap"><table>
          <tr><th>Stage</th><th>Marks</th></tr>
          <tr><td>Mains (Merit)</td><td>900</td></tr>
          <tr><td>Interview / Personality Test</td><td>120</td></tr>
          <tr><td><strong>Final Merit Total</strong></td><td><strong>1020</strong></td></tr>
        </table></div>
      </div>
      <div class="info-card">
        <h3>📌 Eligibility</h3>
        <div class="table-wrap"><table>
          <tr><th>Criteria</th><th>Details</th></tr>
          <tr><td>Age (Minimum)</td><td>20–22 years (post-dependent)</td></tr>
          <tr><td>Age (Maximum, General Male)</td><td>37 years</td></tr>
          <tr><td>Age Relaxation</td><td>+ years for women/OBC/SC/ST as per rules</td></tr>
          <tr><td>Education</td><td>Bachelor's Degree (any stream)</td></tr>
          <tr><td>Conducting Body</td><td>BPSC (bpsc.bihar.gov.in)</td></tr>
        </table></div>
      </div>`,
    subjects: [
      {
        id: 'bpsc_history',
        name: 'History & National Movement',
        color: '#A855F7',
        chapters: [
          { id:'bpsh1', name:'Indus Valley & Vedic Civilization', sub:'Ancient India', diff:'Medium' },
          { id:'bpsh2', name:'Mahajanapadas & Rise of Magadha', sub:'Ancient India', diff:'Hard' },
          { id:'bpsh3', name:'Mauryan Empire – Pataliputra/Ashoka', sub:'Ancient India', diff:'Medium' },
          { id:'bpsh4', name:'Buddhism & Jainism (Bihar origin)', sub:'Ancient India', diff:'Easy' },
          { id:'bpsh5', name:'Gupta Period & Nalanda University', sub:'Ancient India', diff:'Medium' },
          { id:'bpsh6', name:'Delhi Sultanate', sub:'Medieval India', diff:'Medium' },
          { id:'bpsh7', name:'Mughal Empire', sub:'Medieval India', diff:'Medium' },
          { id:'bpsh8', name:'Bhakti & Sufi Movements', sub:'Medieval India', diff:'Medium' },
          { id:'bpsh9', name:'Pala Dynasty & Vikramshila University (Bihar)', sub:'Medieval India', diff:'Hard' },
          { id:'bpsh10', name:'Advent of Europeans & British Expansion', sub:'Modern India & Freedom Struggle', diff:'Easy' },
          { id:'bpsh11', name:'Socio-Religious Reform Movements', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'bpsh12', name:'Revolt of 1857', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'bpsh13', name:'Rise of INC & Nationalism (1885)', sub:'Modern India & Freedom Struggle', diff:'Medium' },
          { id:'bpsh14', name:'Moderate, Extremist & Swadeshi Phase', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'bpsh15', name:'Gandhian Movements – NCM/CDM/Quit India', sub:'Modern India & Freedom Struggle', diff:'Hard' },
          { id:'bpsh16', name:'Santhal Uprising (1855-56)', sub:'Bihar in History', diff:'Medium' },
          { id:'bpsh17', name:'Revolt of 1857 in Bihar – Kunwar Singh', sub:'Bihar in History', diff:'Medium' },
          { id:'bpsh18', name:'Birsa Munda Movement (Ulgulan)', sub:'Bihar in History', diff:'Hard' },
          { id:'bpsh19', name:'Champaran Satyagraha (1917)', sub:'Bihar in History', diff:'Easy' },
          { id:'bpsh20', name:'Quit India (1942) & JP Narayan in Bihar', sub:'Bihar in History', diff:'Medium' },
          { id:'bpsh21', name:'Mauryan & Pala Art', sub:'Indian Culture', diff:'Medium' },
          { id:'bpsh22', name:'Madhubani/Mithila & Patna Kalam Painting', sub:'Indian Culture', diff:'Easy' },
          { id:'bpsh23', name:'Bihar Festivals – Chhath/Sonepur Mela', sub:'Indian Culture', diff:'Easy' },
          { id:'bpsh24', name:'Bihar Literature – Maithili/Bhojpuri/Magahi', sub:'Indian Culture', diff:'Medium' },
          { id:'bpsh25', name:'Heritage – Nalanda/Bodh Gaya/Vaishali', sub:'Indian Culture', diff:'Easy' },
        ]
      },
      {
        id: 'bpsc_geo',
        name: 'Geography',
        color: '#0EA5E9',
        chapters: [
          { id:'bpsg1', name:'Physical Features of India', sub:'Physical & Indian Geography', diff:'Medium' },
          { id:'bpsg2', name:'Drainage & River Systems', sub:'Physical & Indian Geography', diff:'Easy' },
          { id:'bpsg3', name:'Climate & Monsoon', sub:'Physical & Indian Geography', diff:'Medium' },
          { id:'bpsg4', name:'Soils, Vegetation & Natural Resources', sub:'Physical & Indian Geography', diff:'Easy' },
          { id:'bpsg5', name:'Agriculture & Industries of India', sub:'Physical & Indian Geography', diff:'Medium' },
          { id:'bpsg6', name:'Population Distribution', sub:'Physical & Indian Geography', diff:'Medium' },
          { id:'bpsg7', name:'World Physical & Climatic Regions', sub:'World Geography', diff:'Medium' },
          { id:'bpsg8', name:'World Resources & Geopolitics', sub:'World Geography', diff:'Hard' },
          { id:'bpsg9', name:'Physical Divisions of Bihar', sub:'Geography of Bihar', diff:'Medium' },
          { id:'bpsg10', name:'Rivers of Bihar – Ganga/Kosi/Gandak/Sone', sub:'Geography of Bihar', diff:'Easy' },
          { id:'bpsg11', name:'Agriculture of Bihar – Paddy/Litchi/Makhana', sub:'Geography of Bihar', diff:'Medium' },
          { id:'bpsg12', name:'Minerals & Forests of Bihar', sub:'Geography of Bihar', diff:'Medium' },
          { id:'bpsg13', name:'Floods & Droughts in Bihar', sub:'Geography of Bihar', diff:'Medium' },
          { id:'bpsg14', name:'Population & Demography of Bihar', sub:'Geography of Bihar', diff:'Medium' },
        ]
      },
      {
        id: 'bpsc_polity',
        name: 'Polity & Governance',
        color: '#3B82F6',
        chapters: [
          { id:'bpsp1', name:'Constitution – Features & Preamble', sub:'Constitution', diff:'Easy' },
          { id:'bpsp2', name:'Fundamental Rights, DPSP & Duties', sub:'Constitution', diff:'Medium' },
          { id:'bpsp3', name:'Important Amendments', sub:'Constitution', diff:'Hard' },
          { id:'bpsp4', name:'President, PM & Union Executive', sub:'Union & State Government', diff:'Medium' },
          { id:'bpsp5', name:'Parliament & Legislative Process', sub:'Union & State Government', diff:'Hard' },
          { id:'bpsp6', name:'Supreme Court & Patna High Court', sub:'Union & State Government', diff:'Medium' },
          { id:'bpsp7', name:'Federal Structure & Centre-State Relations', sub:'Union & State Government', diff:'Medium' },
          { id:'bpsp8', name:'Election Commission & Electoral Reforms', sub:'Union & State Government', diff:'Medium' },
          { id:'bpsp9', name:'Constitutional Bodies – UPSC/BPSC/CAG/FC', sub:'Union & State Government', diff:'Hard' },
          { id:'bpsp10', name:'Bihar Vidhan Sabha & Vidhan Parishad', sub:'Bihar Polity & Local Govt', diff:'Medium' },
          { id:'bpsp11', name:'Governor & CM of Bihar', sub:'Bihar Polity & Local Govt', diff:'Easy' },
          { id:'bpsp12', name:'Panchayati Raj & Urban Bodies in Bihar', sub:'Bihar Polity & Local Govt', diff:'Medium' },
        ]
      },
      {
        id: 'bpsc_economy',
        name: 'Economy',
        color: '#F59E0B',
        chapters: [
          { id:'bpse1', name:'Economic Planning & NITI Aayog', sub:'Indian Economy', diff:'Easy' },
          { id:'bpse2', name:'National Income – GDP/GNP/Per Capita', sub:'Indian Economy', diff:'Hard' },
          { id:'bpse3', name:'Sectors of Economy', sub:'Indian Economy', diff:'Medium' },
          { id:'bpse4', name:'Poverty & Unemployment', sub:'Indian Economy', diff:'Medium' },
          { id:'bpse5', name:'Inflation, Banking & RBI', sub:'Indian Economy', diff:'Medium' },
          { id:'bpse6', name:'Public Finance, Budget & GST', sub:'Indian Economy', diff:'Hard' },
          { id:'bpse7', name:'International Trade & Balance of Payments', sub:'Indian Economy', diff:'Hard' },
          { id:'bpse8', name:'Features of Bihar\u2019s Economy & Budget', sub:'Economy of Bihar', diff:'Medium' },
          { id:'bpse9', name:'Agriculture & Food Processing in Bihar', sub:'Economy of Bihar', diff:'Medium' },
          { id:'bpse10', name:'Industries & Minerals of Bihar', sub:'Economy of Bihar', diff:'Medium' },
          { id:'bpse11', name:'Bihar Skill Development & Employment', sub:'Economy of Bihar', diff:'Easy' },
          { id:'bpse12', name:'Flood Management & MGNREGS in Bihar', sub:'Economy of Bihar', diff:'Medium' },
        ]
      },
      {
        id: 'bpsc_science',
        name: 'General Science & Technology',
        color: '#14B8A6',
        chapters: [
          { id:'bpss1', name:'Physics – Everyday Science', sub:'General Science', diff:'Medium' },
          { id:'bpss2', name:'Chemistry – Elements/Compounds/Acids', sub:'General Science', diff:'Easy' },
          { id:'bpss3', name:'Biology – Cell/Nutrition/Disease', sub:'General Science', diff:'Easy' },
          { id:'bpss4', name:'Space Technology – ISRO Missions', sub:'Science & Technology', diff:'Medium' },
          { id:'bpss5', name:'Defence Technology – DRDO/Indigenous Weapons', sub:'Science & Technology', diff:'Hard' },
          { id:'bpss6', name:'Biotechnology & Nanotechnology', sub:'Science & Technology', diff:'Hard' },
          { id:'bpss7', name:'IT, AI & Digital India', sub:'Science & Technology', diff:'Medium' },
          { id:'bpss8', name:'Agricultural & Medical Technology', sub:'Science & Technology', diff:'Medium' },
          { id:'bpss9', name:'S&T in Bihar – IIT/NIT/AIIMS Patna', sub:'Science & Technology', diff:'Easy' },
        ]
      },
      {
        id: 'bpsc_env',
        name: 'Environment & Ecology',
        color: '#10B981',
        chapters: [
          { id:'bpsv1', name:'Ecosystem & Biodiversity', sub:'Environment & Ecology', diff:'Easy' },
          { id:'bpsv2', name:'Climate Change & Global Warming', sub:'Environment & Ecology', diff:'Medium' },
          { id:'bpsv3', name:'Pollution & Control Measures', sub:'Environment & Ecology', diff:'Medium' },
          { id:'bpsv4', name:'Conservation & Environmental Laws', sub:'Environment & Ecology', diff:'Hard' },
          { id:'bpsv5', name:'Disaster Management (Floods in Bihar)', sub:'Environment & Ecology', diff:'Medium' },
        ]
      },
      {
        id: 'bpsc_ca',
        name: 'Current Affairs',
        color: '#EC4899',
        chapters: [
          { id:'bpsc1', name:'National Events & Schemes', sub:'Current Affairs', diff:'Medium' },
          { id:'bpsc2', name:'International Events & Summits', sub:'Current Affairs', diff:'Medium' },
          { id:'bpsc3', name:'Economy & Budget News', sub:'Current Affairs', diff:'Medium' },
          { id:'bpsc4', name:'Awards, Sports & Honours', sub:'Current Affairs', diff:'Easy' },
          { id:'bpsc5', name:'Science & Tech News', sub:'Current Affairs', diff:'Easy' },
          { id:'bpsc6', name:'Bihar-Specific Current Affairs', sub:'Current Affairs', diff:'Medium' },
        ]
      },
      {
        id: 'bpsc_gma',
        name: 'Mental Ability & Data Analysis',
        color: '#00C896',
        chapters: [
          { id:'bpsm1', name:'Number & Letter Series', sub:'Reasoning & Mental Ability', diff:'Easy' },
          { id:'bpsm2', name:'Analogy & Classification', sub:'Reasoning & Mental Ability', diff:'Easy' },
          { id:'bpsm3', name:'Coding-Decoding & Direction', sub:'Reasoning & Mental Ability', diff:'Medium' },
          { id:'bpsm4', name:'Blood Relations & Syllogism', sub:'Reasoning & Mental Ability', diff:'Medium' },
          { id:'bpsm5', name:'Basic Arithmetic – Ratio/Percentage/Average', sub:'Reasoning & Mental Ability', diff:'Easy' },
          { id:'bpsm6', name:'Data Interpretation – Tables/Bar/Pie/Line', sub:'Statistical Analysis (Mains)', diff:'Medium' },
          { id:'bpsm7', name:'Index Numbers & Census Data Interpretation', sub:'Statistical Analysis (Mains)', diff:'Hard' },
        ]
      },
      {
        id: 'bpsc_mains',
        name: 'Essay, Hindi & Optional (Mains)',
        color: '#F97316',
        chapters: [
          { id:'bpmn1', name:'हिंदी व्याकरण – संधि/समास/शुद्धि', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'bpmn2', name:'निबंध (Hindi) व पत्र लेखन', sub:'सामान्य हिंदी (General Hindi)', diff:'Easy' },
          { id:'bpmn3', name:'वाक्य-विन्यास व संक्षेपण', sub:'सामान्य हिंदी (General Hindi)', diff:'Medium' },
          { id:'bpmn4', name:'Essay – National & International Themes', sub:'निबंध (Essay)', diff:'Medium' },
          { id:'bpmn5', name:'Essay – Philosophical & Hypothetical', sub:'निबंध (Essay)', diff:'Hard' },
          { id:'bpmn6', name:'Essay – Bihar-Oriented (Mandatory)', sub:'निबंध (Essay)', diff:'Medium' },
          { id:'bpmn7', name:'Optional Subject – Strategy (MCQ, Qualifying)', sub:'Optional Subject', diff:'Hard' },
        ]
      }
    ]
  }
};

// Set CGL subjects reference after definition
ALL_EXAMS.cgl.subjects = null; // Will use SUBJECTS directly

