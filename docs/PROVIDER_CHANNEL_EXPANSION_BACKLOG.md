# Provider And Channel Expansion Backlog

Last updated: 2026-08-08

This backlog records external adapter ideas that remain intentional portfolio
decisions. Their aggregate placement is the deferred portion of tranche `M6` in
[MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md). Treat each
remaining item as a governed follow-up, not an implemented runtime claim or a
release blocker.

## Deferred Provider Adapters

- Krea: evaluate as a media-generation provider candidate after provider policy, cost, model metadata, and artifact evidence paths are defined.
- FAL: evaluate for image/video generation only after signed request handling, output provenance, content safety posture, and per-workspace spend controls are designed.
- Novita: evaluate as an OpenAI-compatible or native provider only after model catalog, usage accounting, and failure semantics are mapped into the Gateway provider layer.

## Deferred Channel And Meeting Adapters

- SimpleX: evaluate as a channel only after local bridge trust, pairing, allowlist, message deletion semantics, and inbound command governance are specified.

## Reconciled Implemented Integrations

- Google Meet is no longer a missing adapter. GoatCitadel has Gateway-owned
  prerequisite, session, transcript, consult, and stop routes plus a governed
  Settings flow for explicitly started OpenAI Realtime meeting voice. Future
  polish or proof must be filed against that current owner rather than reopening
  the old evaluation item. GoatCitadel still does not claim a hidden bot
  attendee or recording without consent.

## Acceptance Bar For Any Future Adapter

- Gateway-owned auth, audit, policy, approvals, and workspace scoping.
- Clear capability metadata and setup diagnostics before appearing callable.
- No inbound routing unless pairing, allowlists, loop guards, and webhook/signature checks are implemented.
- No provider or channel activation from imported bundles without governed review and explicit operator approval.
