# GoatCitadel Mobile Native Capabilities Plan

Last updated: 2026-08-08

Execution placement: the current companion-app closeout and pinned-Gateway
`HX-508` proof are owned by tranche `M8` in
[MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md). This file owns
the native capability contract, not a separate program order.

## Purpose

GoatCitadel Mobile is a companion surface, not a silent sensor. Native capabilities can add request-scoped context, media capture, approval confirmation, and opt-in background helpers, but only when the user can see the capability, the OS permits it, the app has consent, the gateway authorizes it, and the action leaves audit evidence.

## Runtime Contract

The shared contract lives in `@goatcitadel/contracts` as:

- `MobileNativeCapabilityId`
- `MobileNativeCapabilityRecord`
- `MobileContextEnvelope`
- heartbeat, context-audit, push-registration, and revocation request/response shapes

Chat send requests may include `mobileContext?: MobileContextEnvelope[]`. The gateway validates the payload, persists sanitized provenance, and adds safe summaries to the request context. Legacy non-chat send inputs normalize to Chat before mobile context is applied. Mobile should not inject GPS or notification content as untyped text except as an explicit compatibility fallback for older gateways.

## Safety Invariants

- Every capability is visible in the app before use.
- Capabilities start inactive unless they are user-initiated and do not require background/special access.
- Background helpers require feature support, explicit app consent, and Android OS permission or special access.
- Exact coordinates require explicit user confirmation; the default location path is approximate, rounded, and request-scoped.
- Notification awareness is allowlisted, locally redacted, short-retention, and special-access gated.
- Screen share uses visible-session MediaProjection only and must expose a stop control.
- Accessibility helper starts read-only. Autonomous gestures are out of scope until a separate approval-gated lane exists.
- Call screening is metadata-only and consented. Audio recording and call-log scraping are out of scope.
- Panic-off revokes local consent, stops active native helpers where available, clears pending shared drafts, and syncs revocation to the gateway when a companion session is available.
- Durable audit must redact coordinates, notification body/content, tokens, secrets, URLs, file paths, and device-local identifiers that are not needed for operator proof.

## Gateway API

All routes live under `/api/v1/mobile`.

Operator-readable routes:

- `GET /api/v1/mobile/capabilities`
- `GET /api/v1/mobile/audit`

Companion-signed mutation routes:

- `PUT /api/v1/mobile/current-device/capabilities`
- `POST /api/v1/mobile/context/audit`
- `PUT /api/v1/mobile/current-device/push`
- `POST /api/v1/mobile/current-device/revoke`

Raw device grants are not sufficient for privileged mobile writes. Companion mutation signing remains the expected guardrail.

## Current Capability Matrix

| Capability | Status | Collection | Notes |
|---|---|---|---|
| `location_context` | ready | user initiated | Approximate request-scoped context for nearby/current-area prompts. |
| `camera_capture` | ready | user initiated | User-captured photo attachments. |
| `image_library` | ready | user initiated | User-selected photo attachments. |
| `share_intake` | ready | user initiated | Share-sheet drafts enter local review before chat. |
| `voice_capture` | ready | user initiated | Native microphone recording and voice-note attachment are implemented. Transcription remains a separate optional follow-up. |
| `approval_key` | scaffolded | foreground | A paired, request-signed companion can review the redacted queue and reject an item. Approve/edit remain operator-only until the Gateway can verify an approval-specific key released by device authentication; a client-only biometric prompt is not sufficient proof. |
| `push_refresh` | scaffolded | background opt-in | Gateway API exists; Expo notification module install is pending registry auth. |
| `geofence_context` | deferred | background opt-in | Contract-visible only; no continuous tracking. |
| `notification_awareness` | deferred | special access | Contract-visible only; no listener enabled in consumer build. |
| `screen_share` | deferred | foreground | Native lane remains blocked unless visible session support is added. |
| `otp_assist` | ready | foreground | Existing SMS Retriever style assist; no SMS inbox reading. |
| `accessibility_helper` | deferred | special access | Read-only summary concept only. |
| `call_screening` | deferred | special access | Metadata-only concept only. |

## Proof Expectations

The implemented capture path closes the old `voice_capture` implementation
checkbox. Its Android/device journey still participates in the consolidated
`M8` proof bundle alongside approvals, reconnect, attachments, and revocation.

Mobile:

- Capability state transitions and panic-off behavior.
- `mobileContext` construction for location, camera/image, share intake, voice attachment, geofence, and notification summary cases.
- Chat request building sends typed `mobileContext`.
- Notification or realtime deep links route to approval/chat/detail screens.
- Android proof for share intake, camera attachment, location prompt, voice capture, approval confirmation, and panic-off.

Gateway:

- Contract exports compile.
- `/api/v1/mobile` rejects anonymous/raw-device writes and accepts signed companion writes.
- Operator reads remain operator-auth only.
- Chat send accepts `mobileContext`, persists provenance, and adds only sanitized summaries to model context.
- Audit redaction removes coordinates, tokens, notification content, file paths, and other sensitive structured fields.

## Packaging Note

If Play policy rejects normal-build special-access declarations, keep the runtime contract unchanged and split sensitive helpers into a sideload or enterprise flavor.
