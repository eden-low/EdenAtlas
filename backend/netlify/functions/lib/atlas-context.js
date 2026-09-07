// EdenAtlas Atlas Assistant — bounded, deterministic, read-only Auto Context pipeline.
//
// Pipeline:
//   verified uid + server-validated scopes
//     -> fixed owner-scoped collectors from tools.js
//     -> allowlisted normalized AtlasContextItem objects
//     -> deterministic text/source/recency ranking
//     -> hard character budget
//     -> JSON lines for atlas-prompt.js
//
// Firebase Admin bypasses Firestore Rules, so every collector used here is the same fixed,
// uid-scoped data-access function already used by Atlas tools. The request/model can never
// choose a collection, uid, document path, or query operator. Calendar remains a capability,
// not a data grant: it has no collector of its own.

const {
  fetchOwnerActivePhotos,
  fetchOwnerJournals,
  fetchOwnerLifeEvents,
} = require("./tools");
const {
  MAX_ATLAS_CONTEXT_CHARS,
  APPLICATION_CONTEXT_FIXED_CHARS,
} = require("./atlas-prompt");
const {
  analyzeRetrievalRequest,
  rankRetrievalItems,
  publicDateRange,
  buildRetrievalStatusLine,
} = require("./atlas-retrieval");

const MAX_CONTEXT_ITEMS = 10;
const MAX_CANDIDATES_PER_SOURCE = 40;
const MAX_ITEM_CONTENT_CHARS = 900;
const MIN_TRUNCATED_CONTENT_CHARS = 48;

const SOURCE_CONFIG = {
  memories: { type: "memory", priority: 8, collect: fetchOwnerActivePhotos },
  journal: { type: "journal", priority: 10, collect: fetchOwnerJournals },
  journey: { type: "journey", priority: 9, collect: fetchOwnerLifeEvents },
};

const SOURCE_INTENT_PATTERNS = {
  memories: /\b(memories?|photos?|gallery)\b|回忆|照片|相册/iu,
  journal: /\b(journals?|entries|notes?|reflections?)\b|日记|日志|笔记|反思/iu,
  journey: /\b(journey|events?|milestones?|timeline|life events?)\b|历程|旅程|事件|里程碑|时间线/iu,
};

const RECENCY_INTENT_PATTERN =
  /\b(recent|recently|lately|today|yesterday|week|month|year|current|latest)\b|最近|近期|近况|今天|昨天|本周|这个月|本月|今年|最新/iu;

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "can", "do", "for", "from", "how", "i",
  "in", "is", "it", "me", "my", "of", "on", "or", "please", "show", "summarize", "summary", "tell",
  "the", "this", "to", "was", "what", "when", "where", "with", "you", "your",
  "memory", "memories", "photo", "photos", "gallery", "journal", "journals", "entry", "entries", "note", "notes",
  "reflection", "reflections", "journey", "event", "events", "milestone", "milestones", "timeline", "record", "records",
]);
const CJK_STOP_CHARS = new Set(["的", "了", "我", "你", "是", "在", "和", "吗", "呢", "有", "与"]);

function cleanText(value, maxChars = MAX_ITEM_CONTENT_CHARS) {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > maxChars ? clean.slice(0, maxChars - 1).trimEnd() + "…" : clean;
}

function cleanStringArray(value, { maxItems = 8, maxChars = 60 } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : 0;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : 0;
  }
  return 0;
}

function timestampIso(value) {
  const millis = timestampMillis(value);
  return millis ? new Date(millis).toISOString() : null;
}

function makeItem({ id, type, title, content, source, timestamp, metadata }) {
  if (typeof id !== "string" || !id || typeof type !== "string" || typeof source !== "string") return null;
  const safeTitle = cleanText(title, 140);
  const safeContent = cleanText(content, MAX_ITEM_CONTENT_CHARS);
  if (!safeTitle && !safeContent) return null;
  return {
    id: `${type}:${id}`,
    type,
    ...(safeTitle ? { title: safeTitle } : {}),
    content: safeContent || safeTitle,
    source,
    ...(timestamp ? { timestamp } : {}),
    relevance: 0,
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

function normalizeMemory(doc) {
  if (!doc || typeof doc !== "object") return null;
  const tags = cleanStringArray(doc.tags);
  const locationName = cleanText(doc.locationName, 100);
  return makeItem({
    id: doc.id,
    type: "memory",
    title: doc.caption || "Memory",
    content: [doc.caption, locationName ? `Location: ${locationName}` : "", tags.length ? `Tags: ${tags.join(", ")}` : ""].filter(Boolean).join(" · "),
    source: "memories",
    timestamp: timestampIso(doc.uploadedAt),
    metadata: {
      ...(locationName ? { locationName } : {}),
      ...(tags.length ? { tags } : {}),
    },
  });
}

function normalizeJournal(doc) {
  if (!doc || typeof doc !== "object") return null;
  const tags = cleanStringArray(doc.tags);
  const mood = cleanText(doc.mood, 50);
  return makeItem({
    id: doc.id,
    type: "journal",
    title: doc.title || "Journal entry",
    content: doc.content || doc.title,
    source: "journal",
    timestamp: timestampIso(doc.createdAt),
    metadata: {
      ...(mood ? { mood } : {}),
      ...(tags.length ? { tags } : {}),
    },
  });
}

function normalizeJourney(doc) {
  if (!doc || typeof doc !== "object") return null;
  const tags = cleanStringArray(doc.tags);
  const eventType = cleanText(doc.type, 60);
  const locationName = cleanText(doc.locationName, 100);
  const title = doc.title || "Journey event";
  return makeItem({
    id: doc.id,
    type: "journey",
    title,
    content: [title, eventType ? `Type: ${eventType}` : "", locationName ? `Location: ${locationName}` : "", tags.length ? `Tags: ${tags.join(", ")}` : ""].filter(Boolean).join(" · "),
    source: "journey",
    timestamp: timestampIso(doc.date),
    metadata: {
      ...(eventType ? { eventType } : {}),
      ...(locationName ? { locationName } : {}),
      ...(tags.length ? { tags } : {}),
    },
  });
}

const NORMALIZERS = { memories: normalizeMemory, journal: normalizeJournal, journey: normalizeJourney };

function itemMillis(item) {
  return item && item.timestamp ? timestampMillis(item.timestamp) : 0;
}

async function collectAtlasContext({ db, uid, scopes }) {
  const enabled = new Set(Array.isArray(scopes) ? scopes : []);
  const queriedSources = Object.keys(SOURCE_CONFIG).filter((source) => enabled.has(source));
  const batches = await Promise.all(queriedSources.map(async (source) => {
    const config = SOURCE_CONFIG[source];
    try {
      const raw = await config.collect(db, uid);
      const docs = Array.isArray(raw) ? raw : [];
      const normalized = [];
      let malformedCount = 0;
      docs.forEach((doc) => {
        try {
          const item = NORMALIZERS[source](doc);
          if (item) normalized.push(item);
          else malformedCount++;
        } catch {
          malformedCount++;
        }
      });
      normalized.sort((a, b) => itemMillis(b) - itemMillis(a) || a.id.localeCompare(b.id));
      const capped = normalized.slice(0, MAX_CANDIDATES_PER_SOURCE);
      return {
        source,
        items: capped,
        stats: { collected: docs.length, normalized: normalized.length, considered: capped.length, malformed: malformedCount },
        error: null,
      };
    } catch {
      return {
        source,
        items: [],
        stats: { collected: 0, normalized: 0, considered: 0, malformed: 0 },
        error: { source, code: "query_failed" },
      };
    }
  }));

  const sourceStats = {};
  const errors = [];
  batches.forEach((batch) => {
    sourceStats[batch.source] = batch.stats;
    if (batch.error) errors.push(batch.error);
  });
  return { items: batches.flatMap((batch) => batch.items), queriedSources, sourceStats, errors };
}

function normalizeForSearch(value) {
  return cleanText(String(value || ""), 4000).toLocaleLowerCase("en");
}

function extractSearchTerms(prompt) {
  const value = normalizeForSearch(prompt);
  const terms = [];
  const latinOrNumber = value.match(/[\p{L}\p{N}]+/gu) || [];
  latinOrNumber.forEach((term) => {
    if (/\p{Script=Han}/u.test(term)) return;
    if (term.length >= 2 && !STOP_WORDS.has(term)) terms.push(term);
  });
  const hanChars = value.match(/\p{Script=Han}/gu) || [];
  hanChars.forEach((char) => { if (!CJK_STOP_CHARS.has(char)) terms.push(char); });
  return [...new Set(terms)].slice(0, 24);
}

function sourceIntent(prompt) {
  const intents = new Set();
  Object.entries(SOURCE_INTENT_PATTERNS).forEach(([source, pattern]) => {
    if (pattern.test(prompt)) intents.add(source);
  });
  return intents;
}

function recencyScore(item, now) {
  const millis = itemMillis(item);
  const nowMillis = now instanceof Date ? now.getTime() : Date.now();
  if (!millis || !Number.isFinite(nowMillis)) return 0;
  const ageDays = Math.max(0, (nowMillis - millis) / 86_400_000);
  if (ageDays <= 7) return 20;
  if (ageDays <= 30) return 16;
  if (ageDays <= 90) return 11;
  if (ageDays <= 365) return 5;
  return 0;
}

function rankAndFilterAtlasContext({ items, userMessage, now }) {
  const prompt = normalizeForSearch(userMessage);
  const terms = extractSearchTerms(prompt);
  const intents = sourceIntent(prompt);
  const hasRecencyIntent = RECENCY_INTENT_PATTERN.test(prompt);
  const ranked = [];

  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== "object" || !item.id || !item.type || !item.source || typeof item.content !== "string") return;
    const haystack = normalizeForSearch([item.title, item.content, JSON.stringify(item.metadata || {})].filter(Boolean).join(" "));
    let textScore = 0;
    terms.forEach((term) => { if (haystack.includes(term)) textScore += 14; });
    textScore = Math.min(textScore, 70);
    if (prompt.length >= 3 && haystack.includes(prompt)) textScore = Math.min(80, textScore + 20);
    // An explicit source request (for example, "recent journal entries") must not let the
    // general recency signal pull unrelated enabled sources into the prompt. A record from a
    // different source can still qualify when it actually matches the concrete topic text.
    if (intents.size > 0 && !intents.has(item.source) && textScore === 0) return;
    const intentScore = intents.has(item.source) ? 50 : 0;
    const recentIntentScore = hasRecencyIntent ? 24 : 0;
    if (textScore === 0 && intentScore === 0 && recentIntentScore === 0) return;
    const sourcePriority = SOURCE_CONFIG[item.source] ? SOURCE_CONFIG[item.source].priority : 0;
    ranked.push({
      ...item,
      relevance: textScore + intentScore + recentIntentScore + recencyScore(item, now) + sourcePriority,
      _textScore: textScore,
    });
  });

  // When the prompt names a concrete topic that actually matches stored text, source-intent
  // alone must not pull unrelated records from that same source into the model prompt. Generic
  // requests such as "summarize my journal" have no text match and intentionally retain the
  // newest source-intent candidates.
  const hasSpecificTextMatch = ranked.some((item) => item._textScore > 0);
  const useful = hasSpecificTextMatch ? ranked.filter((item) => item._textScore > 0) : ranked;
  return useful.sort((a, b) =>
    b.relevance - a.relevance ||
    itemMillis(b) - itemMillis(a) ||
    a.type.localeCompare(b.type) ||
    a.id.localeCompare(b.id)
  ).map(({ _textScore, ...item }) => item);
}

function promptItem(item, { includeMetadata = true, content = item.content } = {}) {
  return {
    type: item.type,
    ...(item.title ? { title: item.title } : {}),
    content,
    source: item.source,
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(includeMetadata && item.metadata && Object.keys(item.metadata).length ? { metadata: item.metadata } : {}),
  };
}

function serializeItemToFit(item, remainingChars) {
  if (remainingChars <= 0) return null;
  const full = JSON.stringify(promptItem(item));
  if (full.length <= remainingChars) return full;
  const withoutMetadata = JSON.stringify(promptItem(item, { includeMetadata: false }));
  if (withoutMetadata.length <= remainingChars) return withoutMetadata;
  const emptyContent = JSON.stringify(promptItem(item, { includeMetadata: false, content: "" }));
  const availableContent = remainingChars - emptyContent.length;
  if (availableContent < MIN_TRUNCATED_CONTENT_CHARS) return null;
  const truncated = cleanText(item.content, availableContent);
  const fitted = JSON.stringify(promptItem(item, { includeMetadata: false, content: truncated }));
  return fitted.length <= remainingChars ? fitted : null;
}

function applyAtlasContextBudget(rankedItems, { budgetChars = MAX_ATLAS_CONTEXT_CHARS, leadingLines = [] } = {}) {
  const safeBudget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : MAX_ATLAS_CONTEXT_CHARS;
  const dataBudget = Math.max(0, safeBudget - APPLICATION_CONTEXT_FIXED_CHARS);
  const selectedItems = [];
  // Retrieval metadata is server-generated, contains no record content/ids, and shares the
  // exact same application-context budget as the records it describes. It can never bypass the
  // 6,000-character envelope or consume/truncate the actual user prompt.
  const lines = (Array.isArray(leadingLines) ? leadingLines : [])
    .filter((line) => typeof line === "string" && line.length > 0)
    .filter((line, index, all) => all.slice(0, index).join("\n").length + (index ? 1 : 0) + line.length <= dataBudget);

  for (const item of (Array.isArray(rankedItems) ? rankedItems : []).slice(0, MAX_CONTEXT_ITEMS)) {
    const separatorChars = lines.length ? 1 : 0;
    const used = lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
    const remaining = dataBudget - used - separatorChars;
    const line = serializeItemToFit(item, remaining);
    if (!line) continue;
    lines.push(line);
    selectedItems.push(item);
  }

  const serializedContext = lines.join("\n");
  const approximateChars = serializedContext ? serializedContext.length + APPLICATION_CONTEXT_FIXED_CHARS : 0;
  return { selectedItems, serializedContext, approximateChars, budgetChars: safeBudget };
}

async function buildAtlasAutoContext({
  db, uid, scopes, userMessage, now, timeZone,
  retrievalAnalyzer = analyzeRetrievalRequest,
  retrievalRanker = rankRetrievalItems,
}) {
  let retrievalPlan = null;
  let retrievalFallback = false;
  const pipelineErrors = [];
  try {
    retrievalPlan = retrievalAnalyzer({ userMessage, now, timeZone });
  } catch {
    // Query interpretation is optional. If it ever fails, retain the exact Phase 1 collection,
    // relevance and budget behavior rather than turning retrieval into a new availability risk.
    retrievalFallback = true;
    pipelineErrors.push({ source: "retrieval", code: "interpretation_failed" });
  }

  const enabledScopes = Array.isArray(scopes) ? scopes : [];
  const collectionScopes = retrievalPlan && retrievalPlan.intent && retrievalPlan.querySources.length
    ? enabledScopes.filter((scope) => retrievalPlan.querySources.includes(scope))
    : enabledScopes;
  const collected = await collectAtlasContext({ db, uid, scopes: collectionScopes });

  let ranked;
  let retrievalSummary = retrievalFallback ? { intent: false, status: "fallback" } : { intent: false, status: "not_requested" };
  let leadingLines = [];
  let retrievalCandidateCount = 0;

  if (retrievalPlan && retrievalPlan.intent) {
    try {
      const sourcePriorities = Object.fromEntries(Object.entries(SOURCE_CONFIG).map(([source, config]) => [source, config.priority]));
      const retrieval = retrievalRanker({ items: collected.items, plan: retrievalPlan, now, sourcePriorities });
      ranked = retrieval.items;
      retrievalCandidateCount = retrieval.totalMatches;
      const allQueriedFailed = collected.queriedSources.length > 0 && collected.errors.length === collected.queriedSources.length;
      const status = retrieval.totalMatches > 0
        ? "matched"
        : collected.queriedSources.length === 0
          ? "no_authorized_source"
          : allQueriedFailed
            ? "unavailable"
            : collected.errors.length
              ? "partial_no_match"
              : "no_match";
      const truncated = retrieval.totalMatches > retrieval.items.length;
      leadingLines = [buildRetrievalStatusLine({
        plan: retrievalPlan,
        status,
        searchedSources: collected.queriedSources,
        matchCount: retrieval.totalMatches,
        truncated,
      })];
      retrievalSummary = {
        intent: true,
        status,
        reason: retrievalPlan.reason,
        requestedSources: retrievalPlan.requestedSources,
        searchedSources: collected.queriedSources,
        candidateCount: retrieval.totalMatches,
        selectedCount: 0,
        truncated,
        resolvedDateRange: publicDateRange(retrievalPlan.dateRange),
      };
    } catch {
      pipelineErrors.push({ source: "retrieval", code: "ranking_failed" });
      retrievalSummary = { intent: false, status: "fallback" };
      ranked = rankAndFilterAtlasContext({ items: collected.items, userMessage, now });
      leadingLines = [];
    }
  } else {
    ranked = rankAndFilterAtlasContext({ items: collected.items, userMessage, now });
  }

  const budgeted = applyAtlasContextBudget(ranked, { leadingLines });
  if (retrievalSummary.intent) retrievalSummary.selectedCount = budgeted.selectedItems.length;
  const summary = {
    queriedSources: collected.queriedSources,
    sourceStats: collected.sourceStats,
    collectedCount: collected.items.length,
    eligibleCount: ranked.length,
    selectedCount: budgeted.selectedItems.length,
    droppedCount: Math.max(0, (retrievalSummary.intent ? retrievalCandidateCount : ranked.length) - budgeted.selectedItems.length),
    approximateChars: budgeted.approximateChars,
    budgetChars: budgeted.budgetChars,
    includedTypes: [...new Set(budgeted.selectedItems.map((item) => item.type))],
    errors: [...pipelineErrors, ...collected.errors],
    retrieval: retrievalSummary,
  };
  return { ...budgeted, summary };
}

function emptyAtlasAutoContext({ code = null } = {}) {
  return {
    selectedItems: [],
    serializedContext: "",
    approximateChars: 0,
    budgetChars: MAX_ATLAS_CONTEXT_CHARS,
    summary: {
      queriedSources: [],
      sourceStats: {},
      collectedCount: 0,
      eligibleCount: 0,
      selectedCount: 0,
      droppedCount: 0,
      approximateChars: 0,
      budgetChars: MAX_ATLAS_CONTEXT_CHARS,
      includedTypes: [],
      errors: code ? [{ source: "auto_context", code }] : [],
      retrieval: { intent: false, status: code ? "fallback" : "not_requested" },
    },
  };
}

module.exports = {
  MAX_ATLAS_CONTEXT_CHARS,
  MAX_CONTEXT_ITEMS,
  MAX_CANDIDATES_PER_SOURCE,
  collectAtlasContext,
  rankAndFilterAtlasContext,
  applyAtlasContextBudget,
  buildAtlasAutoContext,
  emptyAtlasAutoContext,
};
