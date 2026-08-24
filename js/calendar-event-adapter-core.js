// Pure EdenAtlas source -> canonical Calendar projection core.
//
// This file is shared by the buildless Calendar UI and the server-side adapter wrapper. It has
// no Firestore, network, OAuth, environment, provider, persistence, or browser-global access.
// The server wrapper validates every candidate with the authoritative Phase 3B.1 contract.

import {
  isDateLiteral,
  localDateString,
  nextDateLiteral,
  resolveJournalEntryDate,
  resolveJourneyDate,
} from "./date-utils.js";

export const CALENDAR_ADAPTER_SCHEMA_VERSION = 1;
export const CALENDAR_ADAPTER_TITLE_LIMIT = 200;

export class CalendarEventAdapterError extends Error {
  constructor(code, field = null) {
    super(code);
    this.name = "CalendarEventAdapterError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field = null) {
  throw new CalendarEventAdapterError(code, field);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dateLikeToDate(value) {
  try {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (value && typeof value.toDate === "function") {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
    }
  } catch {
    return null;
  }
  return null;
}

function sourceDateLiteral(value, code, field) {
  if (isDateLiteral(value)) return value;
  const date = dateLikeToDate(value);
  if (!date) fail(code, field);
  return localDateString(date);
}

function timestampRfc3339(value, field, nullable) {
  if (value == null) {
    if (nullable) return null;
    fail(`invalid_${field}`, field);
  }
  if (typeof value === "string") return value;
  const date = dateLikeToDate(value);
  if (!date) fail(`invalid_${field}`, field);
  return date.toISOString();
}

function requireSourceAndContext(source, context) {
  if (!isPlainObject(source)) fail("invalid_source", "source");
  if (!isPlainObject(context)) fail("invalid_adapter_context", "context");
  if (typeof context.ownerUid !== "string" || !context.ownerUid
      || typeof source.uid !== "string" || source.uid !== context.ownerUid) {
    fail("source_owner_mismatch", "ownerUid");
  }
  if (typeof context.id !== "string" || !context.id) fail("missing_canonical_id", "id");
  if (typeof context.sourceEntityId !== "string" || !context.sourceEntityId) {
    fail("missing_source_entity_id", "sourceEntityId");
  }
  return {
    id: context.id,
    ownerUid: context.ownerUid,
    sourceEntityId: context.sourceEntityId,
    projectedAt: timestampRfc3339(context.projectedAt, "projected_at", false),
  };
}

function sourceTimestamp(source, field) {
  return timestampRfc3339(source[field], `source_${field}`, true);
}

function boundedJourneyTitle(value) {
  if (typeof value !== "string") fail("invalid_journey_title", "title");
  const title = value.trim();
  if (!title) fail("invalid_journey_title", "title");
  return title.slice(0, CALENDAR_ADAPTER_TITLE_LIMIT);
}

function allDayBoundary(date) {
  return { type: "date", date, dateTime: null };
}

function canonicalCandidate({ source, context, sourceEntityType, title, date }) {
  const projection = requireSourceAndContext(source, context);
  return {
    id: projection.id,
    schemaVersion: CALENDAR_ADAPTER_SCHEMA_VERSION,
    ownerUid: projection.ownerUid,
    origin: "edenatlas",
    sourceEntityType,
    sourceEntityId: projection.sourceEntityId,
    title,
    summary: null,
    start: allDayBoundary(date),
    end: allDayBoundary(nextDateLiteral(date)),
    allDay: true,
    timeZone: null,
    status: "confirmed",
    deletedAt: null,
    deletionOrigin: null,
    sourceCreatedAt: sourceTimestamp(source, "createdAt"),
    sourceUpdatedAt: sourceTimestamp(source, "updatedAt"),
    createdAt: projection.projectedAt,
    updatedAt: projection.projectedAt,
    version: 1,
    sync: {
      direction: "none",
      state: "local_only",
      lastSyncedAt: null,
    },
  };
}

// `context.id` is deliberately caller-supplied. This phase does not derive a canonical identity;
// HMAC-backed stable identity remains Phase 3B.5 work.
export function projectExpenseToCalendarEvent(source, context) {
  const date = sourceDateLiteral(source && source.date, "invalid_expense_transaction_date", "date");
  return canonicalCandidate({ source, context, sourceEntityType: "expense", title: "Expense", date });
}

// Exposed separately so legacy fallback remains observable without adding a non-canonical field
// to the event object. An explicit malformed entryDate never falls back to createdAt.
export function resolveJournalCalendarDate(source) {
  if (!isPlainObject(source)) fail("invalid_source", "source");
  return resolveJournalEntryDate(source);
}

export function projectJournalToCalendarEvent(source, context) {
  const dateResolution = resolveJournalCalendarDate(source);
  if (!dateResolution.date) fail("invalid_journal_entry_date", "entryDate");
  return canonicalCandidate({
    source,
    context,
    sourceEntityType: "journal",
    title: "Journal entry",
    date: dateResolution.date,
  });
}

export function projectJourneyToCalendarEvent(source, context) {
  if (!isPlainObject(source)) fail("invalid_source", "source");
  const dateResolution = resolveJourneyDate(source);
  if (!dateResolution.date) fail("invalid_journey_date", "date");
  return canonicalCandidate({
    source,
    context,
    sourceEntityType: "journey",
    title: boundedJourneyTitle(source.title),
    date: dateResolution.date,
  });
}
