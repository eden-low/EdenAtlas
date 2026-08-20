# Expense Receipt AI security contract

Phase 1.6 uses this persistence gate:

> No Expense, receipt, or user-content Firestore writes; operational rate-limit metadata write is
> allowed.

This is a narrow exception, not general permission for the Function to write Firestore.

## The sole permitted server-side write

`expense-receipt-ai` may call `checkAndIncrementDailyUsage()` once for a validated, authenticated
Owner request that is about to use Qwen. That helper may atomically increment only:

```text
ai_usage_expense_receipt/{verifiedFirebaseUid}_{serverUtcDate}
```

The collection name is the server constant `ai_usage_expense_receipt`. The UID comes only from a
Firebase ID token verified with revocation checking. The date is `now.toISOString().slice(0, 10)`
from the Function's server clock. The request body cannot supply or override the UID, date,
collection, document ID, or metadata.

The transaction stores only operational quota metadata:

- `uid`
- `day`
- `count`
- `updatedAt`

It must never store the receipt image or Data URL, OCR/vision output, merchant or note text,
amount, category, tags, location, Expense data, model response, or client-provided content.

## Writes that remain prohibited

The Function may not create, update, or delete an Expense; persist a receipt or AI result; write
any user-content Firestore document; derive an arbitrary Firestore path from client input; or
write Firebase Storage. AI suggestions return to the existing Finance form, where the user edits
them and explicitly saves through the canonical Expense validator and normal Firestore rules.

The operational exception does not apply to any other collection, document, metadata shape, or
write purpose. Expanding it requires a separate security review and policy decision.
