// EdenAtlas Atlas Assistant — deterministic retrieval-intent and record-ranking layer.
//
// This module never touches Firestore. It receives only the allowlisted AtlasContextItem
// objects produced by atlas-context.js after the verified uid + consent-scope collectors have
// run. It cannot select a uid, collection, document path, query operator, or raw field.

const {
  DEFAULT_TIME_ZONE,
  MS_PER_DAY,
  daysInMonth,
  localDateParts,
  localMidnightUtc,
  monthRange,
  yearRange,
  resolveRelativePeriod,
} = require("./date-utils");

const MAX_RETRIEVAL_RESULTS = 5;

const SOURCE_PATTERNS = {
  memories: /\b(memory|memories|photos?|gallery)\b|回忆|照片|相册/iu,
  journal: /\b(journals?|diary|entries|notes?|reflections?)\b|日记|日志|笔记|反思/iu,
  journey: /\b(journey|life events?|events?|milestones?|timeline)\b|历程|旅程|事件|里程碑|时间线/iu,
};

const RETRIEVAL_ACTION_PATTERN =
  /\b(find|search|locate|look\s+for|show\s+me|which\s+(?:memory|journal|entry|note|event)|what\s+did\s+i\s+(?:save|write|record|create|make)|anything\s+i\s+(?:wrote|saved|recorded|created|made))\b|找出|寻找|搜索|查找|帮我找|我(?:写|存|记录|创建|做)了什么/iu;
const RECALL_PATTERN =
  /\b(?:i\s+)?(?:do\s+not|don't|dont|can't|cannot)\s+remember\b|\bforgot(?:ten)?\b|\bi\s+remember\s+(?:writing|saving|recording|creating|making)\b|不记得|忘(?:了|记)|记得我(?:写|存|记录|创建|做)/iu;
const PERSONAL_RECORD_PATTERN =
  /\b(my|i|memory|journal|entry|note|journey|event|trip|visit|visited|wrote|saved|recorded|created|made)\b|我的|我|回忆|日记|日志|笔记|历程|旅程|旅行|记录|写过|保存/iu;
const RECENCY_PATTERN =
  /\b(recent|recently|latest|today|yesterday|this\s+month|last\s+month|this\s+year|last\s+year)\b|最近|近期|最新|今天|昨天|本月|这个月|上个月|去年|今年/iu;

const MONTH_ALIASES = [
  { month: 1, pattern: "january|jan" },
  { month: 2, pattern: "february|feb" },
  { month: 3, pattern: "march|mar" },
  { month: 4, pattern: "april|apr" },
  { month: 5, pattern: "may" },
  { month: 6, pattern: "june|jun" },
  { month: 7, pattern: "july|jul" },
  { month: 8, pattern: "august|aug" },
  { month: 9, pattern: "september|sept|sep" },
  { month: 10, pattern: "october|oct" },
  { month: 11, pattern: "november|nov" },
  { month: 12, pattern: "december|dec" },
];

const MONTH_WORDS = MONTH_ALIASES.flatMap((entry) => entry.pattern.split("|"));
const RETRIEVAL_STOP_WORDS = new Set([
  "a", "about", "an", "and", "anything", "around", "as", "at", "be", "but", "called",
  "can", "cannot", "created", "did", "do", "don", "dont", "entry", "event", "find", "for", "forgot", "forgotten",
  "from", "gallery", "how", "i", "in", "is", "it", "journal", "journey", "locate", "look",
  "know", "made", "make", "me", "memory", "memories", "milestone", "milestones", "my", "name", "note", "notes", "of", "on", "or",
  "photo", "photos", "place", "please", "record", "records", "recorded", "remember", "save", "saved", "search",
  "show", "something", "that", "the", "this", "timeline", "title", "to", "visited", "was",
  "what", "when", "where", "which", "with", "write", "writing", "wrote", "year",
  "recent", "recently", "latest", "last", "month", "today", "yesterday", "current",
  ...MONTH_WORDS,
]);
const CJK_STOP_CHARS = new Set([
  "的", "了", "我", "你", "是", "在", "和", "吗", "呢", "有", "与", "找", "查", "搜", "忘",
  "记", "得", "写", "存", "做", "过", "这", "那", "个", "月", "年", "回", "忆", "日", "志",
  "笔", "旅", "程", "事", "件", "什", "么", "名", "称", "标", "题", "地", "方", "去",
]);

function normalizeSearchText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

function extractRetrievalTerms(value) {
  const normalized = normalizeSearchText(value);
  const terms = [];
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  words.forEach((word) => {
    if (/\p{Script=Han}/u.test(word)) return;
    if (/^(?:19|20)\d{2}$/.test(word)) return;
    if (word.length >= 2 && !RETRIEVAL_STOP_WORDS.has(word)) terms.push(word);
  });
  const hanChars = normalized.match(/\p{Script=Han}/gu) || [];
  hanChars.forEach((char) => { if (!CJK_STOP_CHARS.has(char)) terms.push(char); });
  return [...new Set(terms)].slice(0, 24);
}

function detectSources(prompt) {
  return Object.entries(SOURCE_PATTERNS)
    .filter(([, pattern]) => pattern.test(prompt))
    .map(([source]) => source);
}

function inferredSources(prompt) {
  const inferred = [];
  if (/\b(wrote|writing|diary)\b|写过|写了/iu.test(prompt)) inferred.push("journal");
  return inferred;
}

function safeNow(now) {
  return now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
}

function dayRange(year, month, day, timeZone) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const start = localMidnightUtc(year, month, day, timeZone);
  return {
    start,
    end: new Date(start.getTime() + MS_PER_DAY - 1),
    startDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    endDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeZone,
    resolvedFrom: "explicit_day",
  };
}

function withInternalMillis(range, resolvedFrom = range && range.resolvedFrom) {
  if (!range) return null;
  return {
    startMs: range.start.getTime(),
    endMs: range.end.getTime(),
    startDate: range.startDate,
    endDate: range.endDate,
    timeZone: range.timeZone,
    resolvedFrom,
  };
}

function englishMonthMatch(prompt) {
  for (const entry of MONTH_ALIASES) {
    const matches = prompt.matchAll(new RegExp(`\\b(${entry.pattern})\\b`, "giu"));
    for (const match of matches) {
      // "May I find..." is a permission phrase, not a request for records from the month of
      // May. Other month names are not common English auxiliary verbs.
      const tail = prompt.slice(match.index, match.index + 12);
      if (entry.month === 5 && /^may\s+(?:i|we|you)\b/iu.test(tail)) continue;
      return { month: entry.month, text: match[0], index: match.index };
    }
  }
  return null;
}

function parseRetrievalDateRange(userMessage, { now, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const current = safeNow(now);
  if (!current) return null;
  const prompt = normalizeSearchText(userMessage);

  const iso = prompt.match(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (iso) return withInternalMillis(dayRange(Number(iso[1]), Number(iso[2]), Number(iso[3]), timeZone));

  if (/\b(today)\b|今天/iu.test(prompt)) {
    const parts = localDateParts(current, timeZone);
    return withInternalMillis(dayRange(parts.year, parts.month, parts.day, timeZone), "today");
  }
  if (/\b(yesterday)\b|昨天/iu.test(prompt)) {
    const parts = localDateParts(new Date(current.getTime() - MS_PER_DAY), timeZone);
    return withInternalMillis(dayRange(parts.year, parts.month, parts.day, timeZone), "yesterday");
  }

  const relative = [
    { pattern: /\bthis\s+month\b|本月|这个月/iu, period: "this_month" },
    { pattern: /\b(?:last|previous)\s+month\b|上个月|上月/iu, period: "last_month" },
    { pattern: /\bthis\s+year\b|今年/iu, period: "this_year" },
    { pattern: /\b(?:last|previous)\s+year\b|去年/iu, period: "last_year" },
  ].find((entry) => entry.pattern.test(prompt));
  if (relative) {
    const range = resolveRelativePeriod(relative.period, { now: current, timeZone });
    return withInternalMillis(range, relative.period);
  }

  const chineseYearMonth = prompt.match(/\b((?:19|20)\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月/iu)
    || prompt.match(/\b(1[0-2]|0?[1-9])\s*月\s*((?:19|20)\d{2})\s*年?/iu);
  if (chineseYearMonth) {
    const yearFirst = chineseYearMonth[0].indexOf("年") < chineseYearMonth[0].indexOf("月");
    const year = Number(yearFirst ? chineseYearMonth[1] : chineseYearMonth[2]);
    const month = Number(yearFirst ? chineseYearMonth[2] : chineseYearMonth[1]);
    return withInternalMillis({ ...monthRange(year, month, timeZone), timeZone }, "explicit_month");
  }

  const namedMonth = englishMonthMatch(prompt);
  if (namedMonth) {
    const escaped = namedMonth.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = prompt.match(new RegExp(`\\b${escaped}\\s*,?\\s*((?:19|20)\\d{2})\\b`, "iu"));
    const before = prompt.match(new RegExp(`\\b((?:19|20)\\d{2})\\s+${escaped}\\b`, "iu"));
    if (after || before) {
      const year = Number((after && after[1]) || (before && before[1]));
      return withInternalMillis({ ...monthRange(year, namedMonth.month, timeZone), timeZone }, "explicit_month");
    }

    if (new RegExp(`\\blast\\s+${escaped}\\b`, "iu").test(prompt)) {
      const local = localDateParts(current, timeZone);
      const year = namedMonth.month < local.month ? local.year : local.year - 1;
      return withInternalMillis({ ...monthRange(year, namedMonth.month, timeZone), timeZone }, "last_named_month");
    }

    const period = MONTH_ALIASES[namedMonth.month - 1].pattern.split("|")[0];
    return withInternalMillis(resolveRelativePeriod(period, { now: current, timeZone }), "named_month");
  }

  const chineseMonth = prompt.match(/(?:^|\D)(1[0-2]|0?[1-9])\s*月/iu);
  if (chineseMonth) {
    const local = localDateParts(current, timeZone);
    const month = Number(chineseMonth[1]);
    const year = month <= local.month ? local.year : local.year - 1;
    return withInternalMillis({ ...monthRange(year, month, timeZone), timeZone }, "named_month");
  }

  const explicitYear = prompt.match(/\b((?:19|20)\d{2})\b/);
  if (explicitYear) {
    const year = Number(explicitYear[1]);
    return withInternalMillis({ ...yearRange(year, timeZone), timeZone }, "explicit_year");
  }
  return null;
}

function analyzeRetrievalRequest({ userMessage, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const prompt = normalizeSearchText(userMessage);
  const requestedSources = detectSources(prompt);
  const likelySources = [...new Set([...requestedSources, ...inferredSources(prompt)])];
  const dateRange = parseRetrievalDateRange(prompt, { now, timeZone });
  const explicitAction = RETRIEVAL_ACTION_PATTERN.test(prompt);
  const recallLanguage = RECALL_PATTERN.test(prompt);
  const dateBoundPersonalRequest = !!dateRange && PERSONAL_RECORD_PATTERN.test(prompt);
  const intent = explicitAction || recallLanguage || dateBoundPersonalRequest;
  return {
    intent,
    reason: explicitAction ? "explicit" : recallLanguage ? "recall" : dateBoundPersonalRequest ? "date_bound" : null,
    requestedSources,
    likelySources,
    // Only an explicit source noun narrows collection. Inferred sources affect ranking only, so
    // vague "I wrote something about this trip" can still find a consented Memory/Journey.
    querySources: requestedSources,
    terms: extractRetrievalTerms(prompt),
    hasRecencyIntent: RECENCY_PATTERN.test(prompt),
    dateRange,
  };
}

function itemMillis(item) {
  const value = item && item.timestamp ? Date.parse(item.timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
}

function fieldMatchCount(value, terms) {
  const haystack = normalizeSearchText(value);
  return terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
}

function recencyScore(item, now) {
  const current = safeNow(now);
  const millis = itemMillis(item);
  if (!current || !millis) return 0;
  const ageDays = Math.max(0, (current.getTime() - millis) / MS_PER_DAY);
  if (ageDays <= 7) return 18;
  if (ageDays <= 30) return 14;
  if (ageDays <= 90) return 9;
  if (ageDays <= 365) return 4;
  return 0;
}

function rankRetrievalItems({ items, plan, now, sourcePriorities = {} } = {}) {
  if (!plan || !plan.intent) return { items: [], totalMatches: 0 };
  const requested = new Set(plan.requestedSources || []);
  const likely = new Set(plan.likelySources || []);
  const terms = Array.isArray(plan.terms) ? plan.terms : [];
  const candidates = [];

  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== "object" || !item.id || !item.type || !item.source || typeof item.content !== "string") return;
    const millis = itemMillis(item);
    if (plan.dateRange && (!millis || millis < plan.dateRange.startMs || millis > plan.dateRange.endMs)) return;

    const titleMatches = fieldMatchCount(item.title, terms);
    const contentMatches = fieldMatchCount(item.content, terms);
    const metadataMatches = fieldMatchCount(JSON.stringify(item.metadata || {}), terms);
    const topicMatches = titleMatches + contentMatches + metadataMatches;
    if (terms.length && topicMatches === 0) return;
    if (requested.size && !requested.has(item.source) && topicMatches === 0) return;

    const sourceScore = requested.has(item.source) ? 120 : likely.has(item.source) ? 45 : 0;
    const dateScore = plan.dateRange ? 100 : 0;
    const topicScore = Math.min(160, titleMatches * 42 + contentMatches * 22 + metadataMatches * 28);
    const recentScore = plan.hasRecencyIntent ? recencyScore(item, now) : 0;
    candidates.push({
      ...item,
      relevance: sourceScore + dateScore + topicScore + recentScore + (sourcePriorities[item.source] || 0),
    });
  });

  candidates.sort((a, b) =>
    b.relevance - a.relevance ||
    itemMillis(b) - itemMillis(a) ||
    a.type.localeCompare(b.type) ||
    a.id.localeCompare(b.id)
  );
  return { items: candidates.slice(0, MAX_RETRIEVAL_RESULTS), totalMatches: candidates.length };
}

function publicDateRange(dateRange) {
  if (!dateRange) return null;
  return {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    timeZone: dateRange.timeZone,
    resolvedFrom: dateRange.resolvedFrom,
  };
}

function buildRetrievalStatusLine({ plan, status, searchedSources, matchCount, truncated = false }) {
  return JSON.stringify({
    type: "retrieval_status",
    status,
    requestedSources: plan.requestedSources,
    searchedSources,
    matchCount,
    truncated: !!truncated,
    ...(plan.dateRange ? { resolvedDateRange: publicDateRange(plan.dateRange) } : {}),
  });
}

module.exports = {
  MAX_RETRIEVAL_RESULTS,
  normalizeSearchText,
  extractRetrievalTerms,
  parseRetrievalDateRange,
  analyzeRetrievalRequest,
  rankRetrievalItems,
  publicDateRange,
  buildRetrievalStatusLine,
};
