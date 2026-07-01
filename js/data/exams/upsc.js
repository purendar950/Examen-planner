/* ══════════════════════════════════════════════
   EXAM DATA — UPSC CSE
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.upsc = {
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
};
