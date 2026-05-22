# GoatCitadel Companion Contract

Last updated: 2026-05-22

## Scope

The companion contract defines how a signed mobile or secondary device participates in GoatCitadel without becoming an ungoverned operator backend.

Companion devices may:

- hold short-lived companion sessions derived from an approved device grant
- sign foreground requests with the companion session key
- receive realtime status and approval signals
- submit allowed mobile capability heartbeats, context audit receipts, push registration metadata, and revocations
- perform explicit approval actions through gateway-owned approval routes

Companion devices may not:

- bypass operator-only routes
- turn raw device grants into privileged writes
- activate tools or capabilities that the gateway has not authorized
- silently write durable memory
- claim hostile-code sandboxing or autonomous high-risk execution
- collect native background context without feature support, app consent, OS permission, and audit

## Authentication Model

The gateway distinguishes raw device grants from companion sessions.

- Raw device grant: proves a device was approved for setup or exchange.
- Companion session: short-lived signed lane used by the app after approved exchange.
- Operator auth: required for operator control-plane reads and privileged desktop/web surfaces.

Privileged mobile mutation routes must require companion-signed requests. Operator-readable views may expose sanitized mobile state and audit records, but the mobile app should not rely on those views as proof that a native helper is authorized to run.

## Request Signing

Companion mutations use the existing companion request signing path. A valid request is bound to the companion session and leaves request attribution in audit records:

- actor id
- device id
- grant id
- companion session id
- correlation id and trace id when present

## Capability Truth

Mobile capabilities are reported as typed records:

- capability id
- state
- OS permission state
- sensitivity
- collection mode
- implementation status
- consent status
- provenance

The gateway stores sanitized audit evidence and exposes operator-readable views. It does not treat a device-side permission alone as authorization to collect or submit sensitive context.

## Approval Key

Mobile approval actions should preserve the gateway approval lifecycle. A phone can add a local confirmation step for `danger` and `nuclear` approvals, but it does not replace gateway policy, durable approval records, or operator-visible evidence.

Hardware-backed signing through Android Keystore is a future strengthening lane. Until that exists, the app must present the approval key as local confirmation plus existing companion signing, not as hardware-backed non-repudiation.

## Background Helpers

Background helpers require:

1. feature support in the build
2. explicit app consent
3. Android OS permission or special access
4. companion-authorized gateway sync
5. sanitized audit evidence

No helper should silently capture continuous location, notification content, screen media, accessibility state, call audio, or call logs.

## Panic-Off

Panic-off should:

- stop active native helpers when the native module exposes a stop/revoke path
- revoke local consents
- disable cloud sync defaults
- unregister push/geofence/notification hooks where available
- clear pending shared drafts
- sync revocation to the gateway when a companion session is available
- retain a local and gateway audit receipt
