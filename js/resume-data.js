// ============================================================================
// Canonical public résumé data — SINGLE SOURCE OF TRUTH.
//
// Imported by BOTH the recruiter portfolio (portfolio.js) and the résumé page
// (career.js / resume.html). This replaces the previously-duplicated FALLBACK_*
// constants that lived independently in each file, so an Experience or Project
// record now has exactly one definition. The Career CMS (Firestore) still wins
// whenever it has matching public data; this is the verified fallback used when
// the CMS is empty (which is the live state of the deployed DB today).
//
// Content rules (unchanged from the approved portfolio pass):
//   • Every string is the Owner's own verified résumé data or the approved,
//     privacy-scrubbed portfolio wording — no fabricated metrics, dates,
//     responsibilities or expertise. The internship is anonymized identically
//     to the portfolio ("AI technology company", no client/IC/face/internal data).
//   • { en, zh } == translatable prose (the whole résumé must switch EN⇄中文
//     without reload). Bare strings == proper nouns / identifiers (HTML, SQL,
//     Firebase, place names, event names) rendered the same in both languages.
//   • Group/section LABELS are interface strings and live in locales/*.json
//     (referenced here only by i18n key, never duplicated as content).
//
// Shape notes:
//   • EXPERIENCE / PROJECTS use the nested { en, zh } shape portfolio.js already
//     consumes directly; career.js adapts them into its flat CMS-doc render shape
//     via small helpers (see career.js). PROJECTS carries an extra `category`
//     field career.js needs for its filter tabs; portfolio.js ignores it.
//   • LEADERSHIP carries a `featured` flag: portfolio.js renders only the
//     featured subset (its curated 3), the résumé renders the full list.
// ============================================================================

export const PROFILE = {
  name: "Low Fang Jun", // proper noun — identical in both languages
  headline: {
    en: "Business Information Systems Undergraduate · Web Developer",
    zh: "商业信息系统本科生 · 网页开发者",
  },
  location: {
    en: "Kuching, Sarawak, Malaysia",
    zh: "马来西亚 · 砂拉越 · 古晋",
  },
  summary: {
    en: "Business Information Systems undergraduate at UTAR with a focus on system design, data security, and web programming. Built and shipped EdenAtlas, a Firebase-backed personal life platform with role-based access and a public resume surface, end to end. Comfortable across HTML, CSS, JavaScript, Python, and SQL, with proven leadership experience chairing a 300-participant university event.",
    zh: "拉曼大学（UTAR）商业信息系统本科生，专注于系统设计、数据安全与网页编程。独立从零到一构建并上线 EdenAtlas——一个基于 Firebase、具备角色权限与公开简历入口的个人生活平台。熟练使用 HTML、CSS、JavaScript、Python 与 SQL，并具备统筹约 300 人校园活动的领导经验。",
  },
};

export const EDUCATION = [
  {
    degree: {
      en: "Bachelor of Information Systems (Honours), Business Information Systems",
      zh: "信息系统（荣誉）学士 · 商业信息系统",
    },
    institution: {
      en: "Universiti Tunku Abdul Rahman (UTAR)",
      zh: "拉曼大学（UTAR）",
    },
    dates: "2023 – 2026",
    bullets: [
      { en: "CGPA 2.86", zh: "CGPA 2.86" },
      {
        en: "Relevant coursework: system design, data security, and web programming",
        zh: "相关课程：系统设计、数据安全与网页编程",
      },
    ],
  },
  {
    degree: {
      en: "Diploma in Software Engineering",
      zh: "软件工程文凭",
    },
    institution: {
      en: "International College of Advanced Technology Sarawak (iCATS)",
      zh: "砂拉越先进科技学院（iCATS）",
    },
    dates: "2020 – 2023",
    bullets: [{ en: "CGPA 3.22", zh: "CGPA 3.22" }],
  },
];

export const EXPERIENCE = [
  {
    role: { en: "Technical & Operations Intern", zh: "技术与运维实习生" },
    company: { en: "AI technology company", zh: "AI 科技公司" },
    dates: "Jun 2026 – Present",
    location: { en: "Malaysia", zh: "马来西亚" },
    bullets: [
      {
        en: "Delivered workflow and interface improvements for internal AI verification and administration systems, including a dedicated review-discussion workflow and clearer worker identification.",
        zh: "为内部 AI 核验与管理系统交付流程与界面改进，包括专门的审核讨论流程与更清晰的操作员标识。",
      },
      {
        en: "Improved analytics reliability by replacing hard-coded category logic with configurable rules and validating consistency between APIs, dashboard totals and detailed classifications.",
        zh: "以可配置规则替换硬编码分类逻辑，并校验 API、看板汇总与明细分类之间的一致性，提升分析可靠性。",
      },
      {
        en: "Optimized data operations through incremental CSV synchronization, database indexing and a controlled full-refresh fallback, followed by data-integrity checks.",
        zh: "通过增量 CSV 同步、数据库索引与可控的全量刷新兜底优化数据处理，并进行数据完整性校验。",
      },
      {
        en: "Contributed across frontend, backend and operational workflows using TypeScript, Django-based services, Git and database validation while supporting AI annotation and dataset quality control.",
        zh: "使用 TypeScript、基于 Django 的服务、Git 与数据库校验，横跨前端、后端与运维流程贡献，同时支持 AI 标注与数据集质量控制。",
      },
    ],
    caseSlug: "enterprise-ai-ops",
  },
];

export const PROJECTS = [
  {
    slug: "edenatlas",
    category: "personal",
    featured: true,
    name: { en: "EdenAtlas", zh: "EdenAtlas" },
    tag: { en: "Personal life platform", zh: "个人生活平台" },
    problem: {
      en: "Memories, journaling, career and daily life were scattered across half a dozen apps with no private, unified home.",
      zh: "回忆、日记、职业与日常散落在多个 App 中，没有一个私密、统一的入口。",
    },
    role: {
      en: "Sole designer and developer — built the entire product end to end.",
      zh: "独立设计与开发，端到端完成整个产品。",
    },
    outcome: {
      en: "A login-first, role-based platform (Owner / Friend / Public) with a public résumé surface, English/Chinese i18n and an installable PWA.",
      zh: "一个登录优先、基于角色（Owner / Friend / Public）的平台，带公开简历入口、中英双语与可安装 PWA。",
    },
    tech: ["HTML/CSS/JS", "Firebase Auth", "Firestore", "Storage"],
  },
  {
    slug: "utar-epms",
    category: "coursework",
    featured: true,
    name: { en: "UTAR Event Planning Management System", zh: "UTAR 活动策划管理系统" },
    tag: { en: "University coursework system", zh: "大学课程项目系统" },
    problem: {
      en: "University event planning relied on manual, fragmented steps that were hard to coordinate and track.",
      zh: "大学活动策划依赖手工、割裂的步骤，难以协调与跟踪。",
    },
    role: {
      en: "Contributed to requirements analysis, system and database design, and implementation.",
      zh: "参与需求分析、系统与数据库设计及实现。",
    },
    outcome: {
      en: "A structured event planning and approval system covering the core user roles and workflow.",
      zh: "一个覆盖核心用户角色与流程的结构化活动策划与审批系统。",
    },
    tech: ["System Analysis", "Database Design", "Web"],
  },
  {
    slug: "enterprise-ai-ops",
    category: "internship",
    featured: true,
    name: { en: "Enterprise AI Platform & Operations Improvements", zh: "企业 AI 平台与运维改进" },
    tag: { en: "Internship (anonymized)", zh: "实习（已匿名）" },
    problem: {
      en: "Internal review and analytics workflows were hard to manage — some categories were hard-coded, historical data was inconsistent, and repeated CSV processing didn't scale.",
      zh: "内部审核与分析流程难以管理——部分分类硬编码、历史数据不一致，且重复的 CSV 处理难以扩展。",
    },
    role: {
      en: "Investigated existing frontend, backend, database and workflow logic; implemented scoped improvements and tested consistency.",
      zh: "梳理既有前端、后端、数据库与流程逻辑；实现范围可控的改进并验证一致性。",
    },
    outcome: {
      en: "A more maintainable review and reporting workflow with less unnecessary reprocessing — without exposing internal business data.",
      zh: "更易维护的审核与报表流程，减少不必要的重复处理——且不暴露任何内部业务数据。",
    },
    tech: ["TypeScript", "Django REST", "Vue 3", "PostgreSQL", "Redis", "Celery"],
  },
];

export const LEADERSHIP = [
  {
    role: { en: "Chairperson", zh: "主席" },
    event: { en: "UTAR Orientation Telematch (IBT 2026)", zh: "UTAR 迎新 Telematch（IBT 2026）" },
    date: "Mar 2026",
    featured: true,
    bullets: [
      {
        en: "Coordinated an orientation event for ~300 freshmen and ~500 total participants including committee and helpers.",
        zh: "统筹面向约 300 名新生、连同委员与工作人员共约 500 人的迎新活动。",
      },
      {
        en: "Led a 41–42-member committee through preparation, rehearsals and event-day execution.",
        zh: "带领 41–42 人的委员会完成筹备、彩排与活动当天的执行。",
      },
      {
        en: "Managed cross-department communication, scheduling and operational decisions.",
        zh: "负责跨部门沟通、排期与运营决策。",
      },
    ],
  },
  {
    role: { en: "Chairperson", zh: "主席" },
    event: { en: "Buddhist Society Welcoming Night", zh: "佛学会迎新之夜" },
    date: "Oct 2024",
    featured: true,
    bullets: [],
  },
  {
    role: { en: "Program Leader", zh: "节目负责人" },
    event: { en: "ISC 2025", zh: "ISC 2025" },
    date: "2025",
    featured: true,
    bullets: [],
  },
  {
    role: { en: "Technical Head", zh: "技术负责人" },
    event: { en: "Sport Glory Color Run", zh: "Sport Glory Color Run" },
    date: "—",
    featured: false,
    bullets: [],
  },
  {
    role: { en: "HR & Sponsor Committee", zh: "人事与赞助委员" },
    event: { en: "IBT", zh: "IBT" },
    date: "Feb 2025",
    featured: false,
    bullets: [],
  },
  {
    role: { en: "HR Committee", zh: "人事委员" },
    event: { en: "Warrior 3.0", zh: "Warrior 3.0" },
    date: "—",
    featured: false,
    bullets: [],
  },
];

// Résumé "Skills & Languages" groups. `labelKey` is a locale key (interface label);
// each item is either a proper-noun string (rendered identically in both languages)
// or a { en, zh } object (translated on language switch). This is a DIFFERENT grouping
// from portfolio.js's own SKILLS constant (grouped by application area) — the two are
// distinct presentations of the same underlying skills for two surfaces, not
// conflicting career records, so they are intentionally kept separate.
export const RESUME_SKILLS = [
  {
    labelKey: "career.skills_languages",
    items: [
      { en: "English", zh: "英语" },
      { en: "Mandarin", zh: "华语" },
      { en: "Malay", zh: "马来语" },
    ],
  },
  {
    labelKey: "career.skills_programming",
    items: ["HTML", "CSS", "JavaScript", "Python", "SQL"],
  },
  {
    labelKey: "career.skills_platforms",
    items: ["Firebase Auth", "Firestore", "Firebase Storage", "GitHub Pages"],
  },
  {
    labelKey: "career.skills_tools",
    items: ["Git", "GitHub", "VS Code"],
  },
  {
    labelKey: "career.skills_soft",
    items: [
      { en: "Leadership", zh: "领导力" },
      { en: "Communication", zh: "沟通" },
      { en: "Documentation", zh: "文档撰写" },
      { en: "Coordination", zh: "统筹协调" },
    ],
  },
];
