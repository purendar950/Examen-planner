/* ══════════════════════════════════════════════
   EXAM DATA — UPPCS
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.uppcs = {
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
};
