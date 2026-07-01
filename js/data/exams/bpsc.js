/* ══════════════════════════════════════════════
   EXAM DATA — BPSC
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.bpsc = {
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
};
