/* ══════════════════════════════════════════════
   EXAM DATA — IBPS PO
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.ibps = {
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
};
