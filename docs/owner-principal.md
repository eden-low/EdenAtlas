# Project-bound Owner principal

Owner authorization is bound to exactly one immutable principal per Firebase project:

```text
Firebase project ID + Firebase Auth UID + normalized verified email
```

All three values are conjunctive. `users/{uid}` must also exist with the same `uid` and email and
with `role == "owner"`. Role and public-profile metadata never select or create the Owner.

## Project contract

| Project | Principal source | Current state |
|---|---|---|
| Production | Existing human email binding plus required `PRODUCTION_OWNER_UID` | Human account unchanged; UID slot intentionally unpopulated in repository/live infrastructure |
| Staging | Required `STAGING_OWNER_UID` and `STAGING_OWNER_EMAIL` | Dedicated verified automation identity configured; both slots must exactly match the canonical tuple; no Production fallback |
| Tier-1 | Pinned demo UID/email accepted only by the loopback emulator path | Existing behavior preserved |

`shared/owner-principal.js` is the canonical resolver. Unknown projects, missing values, malformed
values, project mismatches, any non-canonical Staging UID/email, and an attempt to reuse the
Production email for Staging all fail closed. The deployed frontend receives only the resolved public identity tuple generated from its
authoritative build/Firebase context. That tuple is a UX gate; backend verification and Firebase
Rules remain the security boundaries.

## Backend invariants

The five Owner-only Functions use `lib/owner-authorization.js` after revocation-aware Firebase ID
token verification. Authorization requires the configured project, principal UID, verified token
email, and `users/{uid}` UID/role/email to all match. Career Policy Transition still requires the
same authenticated Owner for both BEGIN and COMPLETE; its source/version/target binding, expiry,
random transition ID and 256-bit secret, hash-only storage, transaction serialization, consumed
marker, and replay protection are unchanged.

## Firestore and Storage Rules

The tracked `firestore.rules` and `storage.rules` files are fail-closed templates. The deterministic
generator requires an explicit supported project and replaces exactly the UID/email placeholders.
Generated artifacts are local and ignored under `.rules-runtime/`; no artifact accepts two Owners.
Firebase Rules cannot reliably discover the project ID at request time, so the reviewed deployment
target and project-specific artifact are the authoritative boundary. Bucket name, request data,
profile data, headers, URLs, local storage, or frontend flags never select the Owner.

Tier-1 generation is safe and local:

```powershell
npm run generate:owner-rules:tier1
```

Staging generation requires both canonical environment slots and retains the explicit
Staging-only Production rejection:

```powershell
npm run generate:owner-rules:staging
```

Round 2C generates the ignored Staging artifacts locally. Production generation and every Rules
deployment belong to a later gated operational phase. A Staging-only deployment path must invoke
the generator with `--staging-only`, which explicitly rejects Production.

## Configuration versus credentials

The committed code contains project IDs, schema/validation rules, the existing Production email
binding, the canonical non-secret Staging UID/email, and the pinned `.invalid` Tier-1 identity. It
contains no authentication credential.

The deployment environment must supply the immutable UID/email slots through project-scoped
configuration; the resolver verifies them against the canonical tuple. Authentication passwords,
provider credentials, service accounts, refresh tokens, and other secret material must never be
committed, embedded in the frontend, passed to the Rules generator, or printed.

Phase 6 Round 2C configures identity values and generates local artifacts only. It creates no
secrets, deploys no Rules or Functions, changes no Netlify settings, and writes no live data.
