# GoatCitadel Android Companion Bootstrap

This template is the bootstrap contract baseline for the separate `GoatCitadel-mobile` repo.

It is not a full Android app. It only captures the current `companion.android.v1` gateway contract:

- device-grant to companion-session exchange
- short-lived access tokens
- rotating refresh tokens
- Ed25519-signed mutating requests
- nonce/timestamp replay protection

## Current Gateway Contract

- Exchange: `POST /api/v1/auth/companion/session/exchange`
- Refresh: `POST /api/v1/auth/companion/session/refresh`
- Session info: `GET /api/v1/auth/companion/session`

## Signature Headers

Signed companion mutations must send:

- `x-goatcitadel-companion-timestamp`
- `x-goatcitadel-companion-nonce`
- `x-goatcitadel-companion-signature`

Canonical signing payload:

```text
METHOD
PATH
TIMESTAMP
NONCE
SHA256(CANONICAL_BODY)
```

Rules:

- `METHOD` is uppercase
- `PATH` is the absolute request path without query string
- `TIMESTAMP` is ISO-8601 UTC
- `NONCE` is caller-generated and unique per session
- `CANONICAL_BODY` is stable JSON with sorted object keys, or empty string when no body is sent

## Suggested Next Steps

1. Reconcile the existing GoatCitadel-mobile repo against this template baseline.
2. Generate and store an Ed25519 keypair in Android Keystore where possible.
3. Complete the device approval flow and persist the returned device bearer grant.
4. Exchange that device grant for a companion session bundle.
5. Sign all `POST`/`PUT`/`PATCH`/`DELETE` companion requests with `CompanionRequestSigner`.
6. Refresh the session bundle before access token expiry.
