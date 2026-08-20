// Canonical browser-side Expense schema.
//
// All Expense creation surfaces pass their user-editable values through this module. Protected
// fields (uid/createdAt/updatedAt and all write-state identifiers) are never accepted from the
// draft object: uid and createdAt are injected separately from authenticated/runtime context.

export const EXPENSE_CATEGORIES = Object.freeze(["food", "transport", "shopping", "bills", "other"]);
export const EXPENSE_CURRENCY = "MYR";
export const EXPENSE_LIMITS = Object.freeze({
  noteChars: 240,
  tagCount: 10,
  tagChars: 40,
  collectionIdChars: 128,
  locationNameChars: 200,
});

const COLLECTION_ID_RE = /^[A-Za-z0-9_-]+$/;
const PROTECTED_DRAFT_FIELDS = ["uid", "createdAt", "updatedAt", "expenseId", "id"];

export class ExpenseValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExpenseValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ExpenseValidationError(code);
}

function normalizedDate(value) {
  let date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (value && typeof value.toDate === "function") {
    date = value.toDate();
  } else if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) fail("invalid_date");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      fail("invalid_date");
    }
  } else {
    fail("invalid_date");
  }
  if (!Number.isFinite(date.getTime())) fail("invalid_date");
  return date;
}

function normalizeNullableText(value, maxChars, code) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxChars) fail(code);
  return text;
}

function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > EXPENSE_LIMITS.tagCount) fail("invalid_tags");
  return value.map((tag) => {
    if (typeof tag !== "string") fail("invalid_tags");
    const normalized = tag.trim();
    if (!normalized || normalized.length > EXPENSE_LIMITS.tagChars) fail("invalid_tags");
    return normalized;
  });
}

function normalizeCoordinate(value, min, max, code) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(code);
  return value;
}

export function normalizeExpenseInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_expense");
  if (PROTECTED_DRAFT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    fail("protected_field");
  }

  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) fail("invalid_amount");
  const normalizedAmount = Math.round(amount * 100) / 100;
  if (Math.abs(amount - normalizedAmount) > 1e-9) fail("invalid_amount");

  const currency = input.currency == null || input.currency === "" ? EXPENSE_CURRENCY : input.currency;
  if (currency !== EXPENSE_CURRENCY) fail("invalid_currency");
  if (!EXPENSE_CATEGORIES.includes(input.category)) fail("invalid_category");

  const note = input.note == null ? "" : input.note;
  if (typeof note !== "string" || note.trim().length > EXPENSE_LIMITS.noteChars) fail("invalid_note");

  const collectionId = normalizeNullableText(input.collectionId, EXPENSE_LIMITS.collectionIdChars, "invalid_collection_id");
  if (collectionId && !COLLECTION_ID_RE.test(collectionId)) fail("invalid_collection_id");

  const locationName = normalizeNullableText(input.locationName, EXPENSE_LIMITS.locationNameChars, "invalid_location");
  const latitude = normalizeCoordinate(input.latitude, -90, 90, "invalid_location");
  const longitude = normalizeCoordinate(input.longitude, -180, 180, "invalid_location");
  if ((latitude == null) !== (longitude == null)) fail("invalid_location");

  return {
    amount: normalizedAmount,
    currency,
    category: input.category,
    note: note.trim(),
    date: normalizedDate(input.date),
    collectionId,
    tags: normalizeTags(input.tags == null ? [] : input.tags),
    locationName,
    latitude,
    longitude,
  };
}

export function buildExpenseCreatePayload(input, { uid, createdAt, dateToTimestamp } = {}) {
  if (typeof uid !== "string" || !uid || uid.length > 128) fail("invalid_uid_context");
  if (createdAt == null) fail("invalid_created_at_context");
  if (typeof dateToTimestamp !== "function") fail("invalid_date_context");
  const normalized = normalizeExpenseInput(input);
  return {
    ...normalized,
    date: dateToTimestamp(normalized.date),
    createdAt,
    uid,
  };
}

// Transaction-facing analytics use the purchase date when present. createdAt remains the
// ingestion-time fallback for legacy/Home-created records that predate the canonical schema.
export function expenseTransactionTimestamp(expense) {
  return expense?.date || expense?.createdAt || null;
}

export function expenseCurrency(expense) {
  return expense?.currency || EXPENSE_CURRENCY;
}
