/* ══════════════════════════════════════════════
   EXAM DATA — SSC GD
   Split from the original monolithic js/data/exams.js (see
   js/data/exams/index.js header comment for the full file list).
   Contributes one property to the shared ALL_EXAMS map.
══════════════════════════════════════════════ */
window.ALL_EXAMS_PARTS = window.ALL_EXAMS_PARTS || {};
window.ALL_EXAMS_PARTS.gd = {
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
};
