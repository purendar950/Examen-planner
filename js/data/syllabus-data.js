/* ══════════════════════════════════════════════
   DATA — SSC CGL 161 Chapters
══════════════════════════════════════════════ */
const SUBJECTS = [
  {
    id: 'reasoning',
    name: 'Reasoning & General Intelligence',
    color: '#00C896',
    chapters: [
      // Verbal Reasoning – I
      { id:'r1', name:'Analogy – Word Analogy', sub:'Verbal Reasoning – I', diff:'Easy' },
      { id:'r2', name:'Analogy – Number Analogy', sub:'Verbal Reasoning – I', diff:'Easy' },
      { id:'r3', name:'Analogy – Alphabet Analogy', sub:'Verbal Reasoning – I', diff:'Hard' },
      { id:'r4', name:'Synonym/Antonym Based Analogy', sub:'Verbal Reasoning – I', diff:'Hard' },
      { id:'r5', name:'Classification – Odd One Out (Words)', sub:'Verbal Reasoning – I', diff:'Easy' },
      { id:'r6', name:'Classification – Numbers', sub:'Verbal Reasoning – I', diff:'Easy' },
      { id:'r7', name:'Classification – Alphabet/Letter Groups', sub:'Verbal Reasoning – I', diff:'Easy' },
      { id:'r8', name:'Coding-Decoding – Letter Coding', sub:'Verbal Reasoning – I', diff:'Medium' },
      { id:'r9', name:'Coding-Decoding – Number Coding', sub:'Verbal Reasoning – I', diff:'Medium' },
      { id:'r10', name:'Coding-Decoding – Symbol Coding', sub:'Verbal Reasoning – I', diff:'Medium' },
      { id:'r11', name:'Coding-Decoding – Matrix Coding', sub:'Verbal Reasoning – I', diff:'Medium' },
      { id:'r12', name:'Coding-Decoding – Chinese Coding', sub:'Verbal Reasoning – I', diff:'Hard' },
      { id:'r13', name:'Mathematical Operations', sub:'Verbal Reasoning – I', diff:'Hard' },
      { id:'r14', name:'Dictionary/Alphabetical Order', sub:'Verbal Reasoning – I', diff:'Hard' },
      // Verbal Reasoning – II
      { id:'r15', name:'Blood Relations & Family Tree', sub:'Verbal Reasoning – II', diff:'Hard' },
      { id:'r16', name:'Direction & Distance', sub:'Verbal Reasoning – II', diff:'Hard' },
      { id:'r17', name:'Syllogisms – Statements/Conclusions/Possibility', sub:'Verbal Reasoning – II', diff:'Hard' },
      { id:'r18', name:'Inequality – Coded/Direct', sub:'Verbal Reasoning – II', diff:'Medium' },
      { id:'r19', name:'Order/Ranking', sub:'Verbal Reasoning – II', diff:'Medium' },
      // Verbal Reasoning – III
      { id:'r20', name:'Series – Number/Letter/Alphanumeric', sub:'Verbal Reasoning – III', diff:'Hard' },
      { id:'r21', name:'Input-Output – Machine Steps', sub:'Verbal Reasoning – III', diff:'Medium' },
      { id:'r22', name:'Data Sufficiency', sub:'Verbal Reasoning – III', diff:'Medium' },
      { id:'r23', name:'Venn Diagrams – Logical/Figurative', sub:'Verbal Reasoning – III', diff:'Medium' },
      // Non-Verbal Reasoning
      { id:'r24', name:'Figure Series & Classification', sub:'Non-Verbal Reasoning', diff:'Easy' },
      { id:'r25', name:'Mirror Image & Water Reflection', sub:'Non-Verbal Reasoning', diff:'Medium' },
      { id:'r26', name:'Paper Folding & Cutting', sub:'Non-Verbal Reasoning', diff:'Hard' },
      { id:'r27', name:'Figure Counting – Lines/Triangles/Squares', sub:'Non-Verbal Reasoning', diff:'Hard' },
      { id:'r28', name:'Embedded Figures', sub:'Non-Verbal Reasoning', diff:'Medium' },
      { id:'r29', name:'Figure Counting – Triangles', sub:'Non-Verbal Reasoning', diff:'Easy' },
      { id:'r30', name:'Figure Counting – Squares/Rectangles', sub:'Non-Verbal Reasoning', diff:'Easy' },
      { id:'r31', name:'Pattern Completion', sub:'Non-Verbal Reasoning', diff:'Easy' },
      { id:'r32', name:'Image Formation', sub:'Non-Verbal Reasoning', diff:'Easy' },
      { id:'r33', name:'Cube & Dice', sub:'Non-Verbal Reasoning', diff:'Hard' },
      { id:'r34', name:'Cube Cutting & Painting', sub:'Non-Verbal Reasoning', diff:'Hard' },
      { id:'r35', name:'Grouping of Figures', sub:'Non-Verbal Reasoning', diff:'Medium' },
      // Puzzles
      { id:'r36', name:'Seating – Linear/Circular/Mixed', sub:'Puzzles & Analytical Reasoning', diff:'Medium' },
      { id:'r37', name:'Scheduling – Day/Month', sub:'Puzzles & Analytical Reasoning', diff:'Medium' },
      { id:'r38', name:'Floor/Box Puzzles', sub:'Puzzles & Analytical Reasoning', diff:'Hard' },
      { id:'r39', name:'Clock & Calendar', sub:'Puzzles & Analytical Reasoning', diff:'Medium' },
    ]
  },
  {
    id: 'ga',
    name: 'General Awareness',
    color: '#3B82F6',
    chapters: [
      // History – Ancient
      { id:'g1', name:'Indus Valley & Vedic', sub:'History – Ancient India', diff:'Hard' },
      { id:'g2', name:'Mauryan & Gupta', sub:'History – Ancient India', diff:'Easy' },
      { id:'g3', name:'Delhi Sultanate & Mughal', sub:'History – Ancient India', diff:'Easy' },
      { id:'g4', name:'Maratha & Sikh', sub:'History – Ancient India', diff:'Hard' },
      // Medieval
      { id:'g5', name:'Delhi Sultanate', sub:'History – Medieval India', diff:'Easy' },
      { id:'g6', name:'Mughal Empire', sub:'History – Medieval India', diff:'Medium' },
      { id:'g7', name:'Vijayanagara Empire', sub:'History – Medieval India', diff:'Medium' },
      { id:'g8', name:'Bhakti & Sufi Movements', sub:'History – Medieval India', diff:'Hard' },
      { id:'g9', name:'Marathas', sub:'History – Medieval India', diff:'Hard' },
      { id:'g10', name:'Sikh Empire', sub:'History – Medieval India', diff:'Hard' },
      // Modern
      { id:'g11', name:'Advent of Europeans', sub:'History – Modern India & Freedom Struggle', diff:'Medium' },
      { id:'g12', name:'British Expansion in India', sub:'History – Modern India & Freedom Struggle', diff:'Hard' },
      { id:'g13', name:'Revolt of 1857', sub:'History – Modern India & Freedom Struggle', diff:'Hard' },
      { id:'g14', name:'INC Sessions', sub:'History – Modern India & Freedom Struggle', diff:'Easy' },
      { id:'g15', name:'Moderate & Extremist Phase', sub:'History – Modern India & Freedom Struggle', diff:'Hard' },
      { id:'g16', name:'Gandhian Movements', sub:'History – Modern India & Freedom Struggle', diff:'Easy' },
      { id:'g17', name:'Revolutionary Movements', sub:'History – Modern India & Freedom Struggle', diff:'Hard' },
      { id:'g18', name:'Constitutional Reforms', sub:'History – Modern India & Freedom Struggle', diff:'Medium' },
      { id:'g19', name:'Partition & Independence', sub:'History – Modern India & Freedom Struggle', diff:'Easy' },
      // Polity
      { id:'g20', name:'Constitution – Assembly/FR/DPSP/Preamble', sub:'Polity & Constitution', diff:'Medium' },
      { id:'g21', name:'Parliament – RS/LS/Committees', sub:'Polity & Constitution', diff:'Hard' },
      { id:'g22', name:'Government – President/PM/Cabinet', sub:'Polity & Constitution', diff:'Easy' },
      { id:'g23', name:'Judiciary – SC/HC/Lok Adalat', sub:'Polity & Constitution', diff:'Medium' },
      { id:'g24', name:'Federalism & Local Govt', sub:'Polity & Constitution', diff:'Hard' },
      // Geography
      { id:'g25', name:'Earth Structure', sub:'Geography – India & World', diff:'Easy' },
      { id:'g26', name:'Mountains & Plateaus', sub:'Geography – India & World', diff:'Hard' },
      { id:'g27', name:'Rivers & Lakes', sub:'Geography – India & World', diff:'Hard' },
      { id:'g28', name:'Climate & Monsoon', sub:'Geography – India & World', diff:'Hard' },
      { id:'g29', name:'Soils of India', sub:'Geography – India & World', diff:'Hard' },
      { id:'g30', name:'Agriculture & Crops', sub:'Geography – India & World', diff:'Medium' },
      { id:'g31', name:'Mineral & Power Resources', sub:'Geography – India & World', diff:'Medium' },
      { id:'g32', name:'World – Continents/Oceans/Climate Zones', sub:'Geography – India & World', diff:'Easy' },
      // Economy
      { id:'g33', name:'Basic Concepts – GDP/GNP/Inflation', sub:'Economy & Budget', diff:'Medium' },
      { id:'g34', name:'Budget – Revenue/Capital/Deficit', sub:'Economy & Budget', diff:'Hard' },
      { id:'g35', name:'Banking – RBI/NBFC/Schedule', sub:'Economy & Budget', diff:'Easy' },
      { id:'g36', name:'Taxation – Direct/Indirect/GST', sub:'Economy & Budget', diff:'Easy' },
      // Physics
      { id:'g37', name:'Motion & Laws of Motion', sub:'Science – Physics', diff:'Hard' },
      { id:'g38', name:'Work, Power & Energy', sub:'Science – Physics', diff:'Hard' },
      { id:'g39', name:'Heat & Thermodynamics', sub:'Science – Physics', diff:'Easy' },
      { id:'g40', name:'Sound Waves', sub:'Science – Physics', diff:'Hard' },
      { id:'g41', name:'Light – Reflection/Refraction', sub:'Science – Physics', diff:'Hard' },
      { id:'g42', name:'Electricity', sub:'Science – Physics', diff:'Hard' },
      { id:'g43', name:'Magnetism', sub:'Science – Physics', diff:'Easy' },
      { id:'g44', name:'Modern Physics Basics', sub:'Science – Physics', diff:'Easy' },
      // Chemistry
      { id:'g45', name:'Structure of Atom', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g46', name:'Elements & Compounds', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g47', name:'Chemical Bonding', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g48', name:'Acids, Bases & Salts', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g49', name:'Metals & Non-Metals', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g50', name:'Carbon & Compounds', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g51', name:'Periodic Table', sub:'Science – Chemistry', diff:'Easy' },
      { id:'g52', name:'Chemical Reactions', sub:'Science – Chemistry', diff:'Easy' },
      // Biology
      { id:'g53', name:'Cell & Cell Structure', sub:'Science – Biology', diff:'Easy' },
      { id:'g54', name:'Human Body Systems', sub:'Science – Biology', diff:'Easy' },
      { id:'g55', name:'Nutrition', sub:'Science – Biology', diff:'Easy' },
      { id:'g56', name:'Diseases & Immunity', sub:'Science – Biology', diff:'Easy' },
      { id:'g57', name:'Plant Physiology', sub:'Science – Biology', diff:'Easy' },
      { id:'g58', name:'Genetics Basics', sub:'Science – Biology', diff:'Easy' },
      { id:'g59', name:'Vitamins & Deficiency Diseases', sub:'Science – Biology', diff:'Easy' },
      { id:'g60', name:'Biotechnology Basics', sub:'Science – Biology', diff:'Easy' },
      // Current Affairs
      { id:'g61', name:'National – Schemes/Budget/Policy', sub:'Current Affairs', diff:'Medium' },
      { id:'g62', name:'International – Summits/Treaties', sub:'Current Affairs', diff:'Medium' },
      { id:'g63', name:'Sports – Events/Winners', sub:'Current Affairs', diff:'Medium' },
      { id:'g64', name:'Awards/Honours & Appointments', sub:'Current Affairs', diff:'Medium' },
    ]
  },
  {
    id: 'quant',
    name: 'Quantitative Aptitude',
    color: '#F59E0B',
    chapters: [
      // Number System
      { id:'q1', name:'HCF/LCM/Divisibility/Simplification', sub:'Number System & Algebra', diff:'Easy' },
      { id:'q2', name:'Surds & Indices', sub:'Number System & Algebra', diff:'Easy' },
      { id:'q3', name:'Quadratic Equations & Inequalities', sub:'Number System & Algebra', diff:'Medium' },
      { id:'q4', name:'Algebraic Identities & Factorization', sub:'Number System & Algebra', diff:'Medium' },
      // Commercial Maths
      { id:'q5', name:'Percentage & Ratio/Proportion', sub:'Commercial Mathematics', diff:'Easy' },
      { id:'q6', name:'Profit/Loss/Discount/GST', sub:'Commercial Mathematics', diff:'Medium' },
      { id:'q7', name:'SI/CI/Installments', sub:'Commercial Mathematics', diff:'Medium' },
      { id:'q8', name:'Mixtures & Alligations', sub:'Commercial Mathematics', diff:'Hard' },
      // Arithmetic Applications
      { id:'q9', name:'Average', sub:'Arithmetic Applications', diff:'Easy' },
      { id:'q10', name:'Time & Work', sub:'Arithmetic Applications', diff:'Medium' },
      { id:'q11', name:'Pipes & Cisterns', sub:'Arithmetic Applications', diff:'Medium' },
      { id:'q12', name:'Time, Speed & Distance', sub:'Arithmetic Applications', diff:'Medium' },
      { id:'q13', name:'Trains', sub:'Arithmetic Applications', diff:'Easy' },
      { id:'q14', name:'Boats & Streams', sub:'Arithmetic Applications', diff:'Medium' },
      { id:'q15', name:'Relative Speed', sub:'Arithmetic Applications', diff:'Medium' },
      { id:'q16', name:'Ages', sub:'Arithmetic Applications', diff:'Easy' },
      // Geometry
      { id:'q17', name:'Lines & Angles', sub:'Geometry & Mensuration', diff:'Easy' },
      { id:'q18', name:'Triangles', sub:'Geometry & Mensuration', diff:'Hard' },
      { id:'q19', name:'Quadrilaterals', sub:'Geometry & Mensuration', diff:'Medium' },
      { id:'q20', name:'Circles & Tangents', sub:'Geometry & Mensuration', diff:'Hard' },
      { id:'q21', name:'Polygon Basics', sub:'Geometry & Mensuration', diff:'Medium' },
      { id:'q22', name:'Coordinate Geometry', sub:'Geometry & Mensuration', diff:'Medium' },
      { id:'q23', name:'Mensuration – 2D', sub:'Geometry & Mensuration', diff:'Medium' },
      { id:'q24', name:'Mensuration – 3D', sub:'Geometry & Mensuration', diff:'Hard' },
      { id:'q25', name:'Geometry Theorems', sub:'Geometry & Mensuration', diff:'Hard' },
      // Trigonometry
      { id:'q26', name:'Trigonometric Ratios', sub:'Trigonometry', diff:'Medium' },
      { id:'q27', name:'Trigonometric Identities', sub:'Trigonometry', diff:'Hard' },
      { id:'q28', name:'Heights & Distances', sub:'Trigonometry', diff:'Hard' },
      { id:'q29', name:'Complementary Angles', sub:'Trigonometry', diff:'Medium' },
      // DI
      { id:'q30', name:'DI – Tables/Bar/Line/Pie', sub:'Data Interpretation & Probability', diff:'Medium' },
      { id:'q31', name:'Probability – Balls/Cards/Dice', sub:'Data Interpretation & Probability', diff:'Medium' },
      { id:'q32', name:'Co-ordinate Geometry – Points/Lines', sub:'Data Interpretation & Probability', diff:'Medium' },
    ]
  },
  {
    id: 'english',
    name: 'English Language',
    color: '#A855F7',
    chapters: [
      // Grammar
      { id:'e1', name:'Noun', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e2', name:'Pronoun', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e3', name:'Verb', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e4', name:'Adjective', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e5', name:'Adverb', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e6', name:'Preposition', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e7', name:'Conjunction', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e8', name:'Interjection', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e9', name:'Tenses', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e10', name:'Subject-Verb Agreement', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      { id:'e11', name:'Modals & Conditionals', sub:'Grammar – Parts of Speech & Tenses', diff:'Easy' },
      // Sentences
      { id:'e12', name:'Direct/Indirect Narration', sub:'Grammar – Sentences & Narration', diff:'Medium' },
      { id:'e13', name:'Prepositions & Conjunctions', sub:'Grammar – Sentences & Narration', diff:'Medium' },
      { id:'e14', name:'Sentence Structure & Clauses', sub:'Grammar – Sentences & Narration', diff:'Medium' },
      { id:'e15', name:'Phrase & Idiom Usage', sub:'Grammar – Sentences & Narration', diff:'Medium' },
      // Vocabulary
      { id:'e16', name:'Synonyms/Antonyms', sub:'Vocabulary', diff:'Medium' },
      { id:'e17', name:'One Word Substitution', sub:'Vocabulary', diff:'Medium' },
      { id:'e18', name:'Idioms & Phrases', sub:'Vocabulary', diff:'Medium' },
      { id:'e19', name:'Fill in the Blanks', sub:'Vocabulary', diff:'Medium' },
      { id:'e20', name:'Spelling Detection', sub:'Vocabulary', diff:'Easy' },
      { id:'e21', name:'Cloze Test', sub:'Vocabulary', diff:'Medium' },
      { id:'e22', name:'Reading Comprehension', sub:'Vocabulary', diff:'Medium' },
      // Error Detection
      { id:'e23', name:'Error Detection – Sentence Correction', sub:'Writing & Error Detection', diff:'Hard' },
      { id:'e24', name:'Para Jumbles – Logical Order', sub:'Writing & Error Detection', diff:'Hard' },
      { id:'e25', name:'Sentence Improvement', sub:'Writing & Error Detection', diff:'Hard' },
      { id:'e26', name:'Active/Passive & Direct/Indirect Transformation', sub:'Writing & Error Detection', diff:'Hard' },
    ]
  }
];

