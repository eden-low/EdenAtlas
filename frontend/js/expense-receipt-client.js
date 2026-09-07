// Browser-side receipt preparation and response validation. The server is authoritative, but the
// browser independently allowlists the returned shape before assigning any value to the Finance
// form. Nothing here writes Firestore or retains an image.

export const RECEIPT_INPUT_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const RECEIPT_TARGET_BYTES = 2_000_000;
export const RECEIPT_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 2048;
const MIN_EDGE = 64;
const CATEGORIES = Object.freeze(["food", "transport", "shopping", "bills", "other"]);
const CONFIDENCE = Object.freeze(["high", "medium", "low"]);
const FIELDS = Object.freeze([
  "merchantName", "totalAmount", "currencyCode", "transactionDate", "transactionTime",
  "suggestedCategory", "receiptNumber", "confidence", "warnings",
]);
const CONFIDENCE_FIELDS = Object.freeze([
  "merchantName", "totalAmount", "currencyCode", "transactionDate",
  "transactionTime", "suggestedCategory", "receiptNumber",
]);
const WARNING_CODES = Object.freeze([
  "multiple_totals", "ambiguous_date", "currency_unclear", "cropped_image", "unreadable_receipt",
]);

export class ReceiptClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReceiptClientError";
    this.code = code;
  }
}

function fail(code) { throw new ReceiptClientError(code); }
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function textOrNull(value, max) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) fail("invalid_ai_response");
  return value;
}
function validDate(value) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

export function normalizeReceiptSuggestions(value) {
  if (!exactKeys(value, FIELDS) || !exactKeys(value.confidence, CONFIDENCE_FIELDS)) fail("invalid_ai_response");
  const normalized = {
    merchantName: textOrNull(value.merchantName, 160),
    totalAmount: value.totalAmount,
    currencyCode: value.currencyCode,
    transactionDate: value.transactionDate,
    transactionTime: value.transactionTime,
    suggestedCategory: value.suggestedCategory,
    receiptNumber: textOrNull(value.receiptNumber, 80),
    confidence: {},
    warnings: value.warnings,
  };
  if (normalized.totalAmount !== null && (typeof normalized.totalAmount !== "number"
      || !Number.isFinite(normalized.totalAmount) || normalized.totalAmount <= 0
      || normalized.totalAmount > 100000000
      || Math.abs(normalized.totalAmount * 100 - Math.round(normalized.totalAmount * 100)) > 1e-7)) fail("invalid_ai_response");
  if (normalized.currencyCode !== null && normalized.currencyCode !== "MYR") fail("invalid_ai_response");
  if (!validDate(normalized.transactionDate)) fail("invalid_ai_response");
  if (normalized.transactionTime !== null
      && (typeof normalized.transactionTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized.transactionTime))) fail("invalid_ai_response");
  if (normalized.suggestedCategory !== null && !CATEGORIES.includes(normalized.suggestedCategory)) fail("invalid_ai_response");
  if (!Array.isArray(normalized.warnings) || normalized.warnings.length > WARNING_CODES.length
      || new Set(normalized.warnings).size !== normalized.warnings.length
      || normalized.warnings.some((warning) => !WARNING_CODES.includes(warning))) fail("invalid_ai_response");
  for (const field of CONFIDENCE_FIELDS) {
    const level = value.confidence[field];
    if (level !== null && !CONFIDENCE.includes(level)) fail("invalid_ai_response");
    if (normalized[field] === null && level !== null) fail("invalid_ai_response");
    normalized.confidence[field] = level;
  }
  return normalized;
}

// Only these existing, user-editable Finance inputs can be populated. Currency must be visibly
// MYR before an amount is suggested; receipt time/number remain outside the canonical Expense
// schema and are deliberately not smuggled into tags, location, or write metadata.
export function receiptSuggestionToExpenseDraft(suggestions) {
  const value = normalizeReceiptSuggestions(suggestions);
  return {
    amount: value.currencyCode === "MYR" ? value.totalAmount : null,
    currency: "MYR",
    note: value.merchantName,
    category: value.suggestedCategory,
    date: value.transactionDate,
  };
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}
function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new ReceiptClientError("image_read_failed"));
    reader.readAsDataURL(blob);
  });
}
async function loadBrowserImage(file) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

export async function prepareReceiptImage(file) {
  if (!file || !RECEIPT_INPUT_TYPES.includes(file.type)) fail("unsupported_image_type");
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > RECEIPT_MAX_SOURCE_BYTES) fail("source_image_too_large");

  let loaded;
  try {
    loaded = await loadBrowserImage(file);
    if (loaded.width < MIN_EDGE || loaded.height < MIN_EDGE) fail("invalid_image_dimensions");
    let scale = Math.min(1, MAX_EDGE / Math.max(loaded.width, loaded.height));
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) fail("image_processing_failed");

    for (let sizePass = 0; sizePass < 5; sizePass++) {
      canvas.width = Math.max(MIN_EDGE, Math.round(loaded.width * scale));
      canvas.height = Math.max(MIN_EDGE, Math.round(loaded.height * scale));
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.92, 0.82, 0.72, 0.62]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob && blob.size <= RECEIPT_TARGET_BYTES) {
          return {
            dataUrl: await blobDataUrl(blob),
            mimeType: "image/jpeg",
            byteLength: blob.size,
            width: canvas.width,
            height: canvas.height,
          };
        }
      }
      scale *= 0.82;
    }
    fail("image_processing_failed");
  } catch (err) {
    if (err instanceof ReceiptClientError) throw err;
    fail("image_processing_failed");
  } finally {
    loaded?.cleanup();
  }
}
