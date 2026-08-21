// Pure validation for the Expense Screenshot AI boundary. This module has no Firebase, provider,
// or persistence dependency: raw browser image input and raw model JSON both remain untrusted
// until they pass here.

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 64;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_MODEL_JSON_CHARS = 10_000;

const SUPPORTED_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const RECEIPT_CATEGORIES = Object.freeze(["food", "transport", "shopping", "bills", "other"]);
const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);
const CONFIDENCE_FIELDS = Object.freeze([
  "merchantName", "totalAmount", "currencyCode", "transactionDate",
  "transactionTime", "suggestedCategory", "receiptNumber",
]);
const WARNING_CODES = Object.freeze([
  "multiple_totals", "ambiguous_date", "currency_unclear", "cropped_image", "unreadable_receipt",
]);
const MODEL_FIELDS = Object.freeze([
  "merchantName", "totalAmount", "currencyCode", "transactionDate", "transactionTime",
  "suggestedCategory", "receiptNumber", "confidence", "warnings",
]);

class ReceiptValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReceiptValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ReceiptValidationError(code);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readPngDimensions(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: "image/png" };
}

function readJpegDimensions(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
        mimeType: "image/jpeg",
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height, mimeType: "image/webp" };
  }
  if (chunk === "VP8 " && bytes.length >= 30
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      mimeType: "image/webp",
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      mimeType: "image/webp",
    };
  }
  return null;
}

function inspectImage(bytes) {
  return readPngDimensions(bytes) || readJpegDimensions(bytes) || readWebpDimensions(bytes);
}

function validateImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") fail("invalid_image_payload");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) fail("invalid_image_payload");

  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64") !== match[2]) fail("invalid_image_payload");
  if (bytes.length > MAX_IMAGE_BYTES) fail("image_too_large");

  const image = inspectImage(bytes);
  if (!image || image.mimeType !== match[1]) fail("invalid_image_signature");
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
      || image.width < MIN_IMAGE_DIMENSION || image.height < MIN_IMAGE_DIMENSION
      || image.width > MAX_IMAGE_DIMENSION || image.height > MAX_IMAGE_DIMENSION
      || image.width * image.height > MAX_IMAGE_PIXELS) {
    fail("invalid_image_dimensions");
  }
  return { ...image, byteLength: bytes.length, bytes, dataUrl };
}

function nullableText(value, maxChars, code) {
  if (value === null) return null;
  if (typeof value !== "string") fail(code);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) fail(code);
  return normalized;
}

function nullableDate(value) {
  if (value === null) return null;
  if (typeof value !== "string") fail("invalid_transaction_date");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail("invalid_transaction_date");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1
      || date.getUTCDate() !== Number(match[3])) fail("invalid_transaction_date");
  return value;
}

function normalizeConfidence(confidence, output) {
  if (!exactKeys(confidence, CONFIDENCE_FIELDS)) fail("invalid_confidence");
  const normalized = {};
  for (const field of CONFIDENCE_FIELDS) {
    const value = confidence[field];
    if (value !== null && !CONFIDENCE_LEVELS.includes(value)) fail("invalid_confidence");
    if (output[field] === null && value !== null) fail("invalid_confidence");
    normalized[field] = value;
  }
  return normalized;
}

function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length > WARNING_CODES.length) fail("invalid_warnings");
  const unique = new Set(warnings);
  if (unique.size !== warnings.length || warnings.some((code) => !WARNING_CODES.includes(code))) fail("invalid_warnings");
  return [...warnings];
}

function normalizeReceiptModelOutput(value) {
  if (!exactKeys(value, MODEL_FIELDS)) fail("invalid_model_schema");

  const output = {
    merchantName: nullableText(value.merchantName, 160, "invalid_merchant_name"),
    totalAmount: value.totalAmount,
    currencyCode: value.currencyCode,
    transactionDate: nullableDate(value.transactionDate),
    transactionTime: value.transactionTime,
    suggestedCategory: value.suggestedCategory,
    receiptNumber: nullableText(value.receiptNumber, 80, "invalid_receipt_number"),
  };

  if (output.totalAmount !== null) {
    if (typeof output.totalAmount !== "number" || !Number.isFinite(output.totalAmount)
        || output.totalAmount <= 0 || output.totalAmount > 100000000
        || Math.abs(output.totalAmount * 100 - Math.round(output.totalAmount * 100)) > 1e-7) {
      fail("invalid_total_amount");
    }
  }
  if (output.currencyCode !== null && output.currencyCode !== "MYR") fail("invalid_currency_code");
  if (output.transactionTime !== null
      && (typeof output.transactionTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(output.transactionTime))) {
    fail("invalid_transaction_time");
  }
  if (output.suggestedCategory !== null && !RECEIPT_CATEGORIES.includes(output.suggestedCategory)) {
    fail("invalid_suggested_category");
  }

  output.confidence = normalizeConfidence(value.confidence, output);
  output.warnings = normalizeWarnings(value.warnings);
  return output;
}

function parseReceiptModelJson(text) {
  if (typeof text !== "string" || !text || text.length > MAX_MODEL_JSON_CHARS) fail("malformed_model_json");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("malformed_model_json");
  }
  return normalizeReceiptModelOutput(value);
}

module.exports = {
  ReceiptValidationError,
  validateImageDataUrl,
  normalizeReceiptModelOutput,
  parseReceiptModelJson,
  SUPPORTED_IMAGE_TYPES,
  RECEIPT_CATEGORIES,
  CONFIDENCE_LEVELS,
  CONFIDENCE_FIELDS,
  WARNING_CODES,
  MODEL_FIELDS,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_DIMENSION,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
};
