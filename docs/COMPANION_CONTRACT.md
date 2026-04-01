# Companion Contract

Last updated: 2026-03-31
Contract id: `companion.android.v1`

## Purpose

This document defines the first implementation-ready companion bootstrap contract for GoatCitadel.

It exists to replace vague "mobile companion later" wording with a concrete repo-native baseline for:

- the first bootstrap target
- the separate-repo boundary
- the required server prerequisites
- the minimum mobile feature set that makes the companion runtime real

`companion.android.v1` now has gateway server foundation. An external Android app repo already exists, but this contract still does not claim that the current mobile runtime implements companion.android.v1 end to end.

## Primary Target

- Primary target: `android`
- Paired surface contract: `a2ui.v1`
- Recommended repo: `GoatCitadel-mobile`
- Repo strategy: `separate_repo`

Android is the first companion target because the repo already has the deepest security and architecture research for it, and the existing platform catalog already declares Android canvas/camera/screen capability intent.

## Bootstrap Status

Current status: `server_foundation`

That means:

- the contract is now explicit in shared types and the live parity report
- the live parity report now resolves prerequisite/auth readiness item by item instead of treating companion work as a single placeholder block
- the gateway now exposes companion session exchange, refresh rotation, signed mutation verification, and replay protection
- the existing separate-repo Android lane lives in `GoatCitadel-mobile`
- the current mobile runtime now includes companion-session bootstrap/storage, signed mutation request headers, and a foreground SSE-with-resume event lane wired against this contract
- the repo includes an Android bootstrap template path to keep the contract baseline explicit
- a March 31, 2026 local live-gateway proof now exists for approved-device bearer exchange into a signed companion session, signed mutations, SSE replay/resume, and refresh rotation against a non-loopback local address
- no Android runtime/UI proof bundle exists yet for the current mobile runtime

## Realtime and Session Lanes

`companion.android.v1` currently recognizes three mobile-safe transport lanes:

- `foreground_sse`
- `push_refresh`
- `manual_refresh`

The intended behavior is:

- foreground streaming uses SSE with resume semantics
- background/mobile wake paths fall back to push-triggered refresh
- manual refresh remains valid when background restrictions or operator choice make streaming undesirable

## Auth and Integrity Requirements

The contract currently requires:

- `device_identity`
- `short_lived_access_token`
- `rotating_refresh_token`
- `request_signing`
- `replay_protection`

These requirements are the minimum bar for a real companion control surface. A long-lived bearer token alone is not enough.

The current gateway foundation satisfies these requirements with:

- `POST /api/v1/auth/companion/session/exchange`
- `POST /api/v1/auth/companion/session/refresh`
- `GET /api/v1/auth/companion/session`
- Ed25519-signed companion mutations verified in the auth pipeline
- nonce/timestamp replay records enforced on the gateway

## Required Server Prerequisites

The current bootstrap assumes the gateway side can provide:

- `device_pairing`
- `token_rotation`
- `request_signing`
- `sse_resume`
- `per_device_audit`

Those prerequisites align with the existing Android research/spec docs and reuse the current device approval/auth plumbing rather than inventing a second trust path.

The current bootstrap/template path for the separate repo is:

- `templates/companion/goatcitadel-android/`

## Bootstrap Feature Set

The minimum Android bootstrap surface is:

- `dashboard`
- `chat`
- `approvals`
- `tasks`
- `settings`
- `event_feed`

This is deliberately control-plane-first. It is enough to prove the companion session path without pretending the first release must carry every Mission Control surface at once.

## Device Capability Mapping

From the current Android catalog target, the first declared device capabilities are:

- `scene_view`
- `camera_input`
- `screen_input`

Those pair with `a2ui.v1` instead of replacing it. The companion contract defines how the first mobile runtime should be bootstrapped; the A2UI contract still defines the shared surface language across Mission Control and future companion sessions.

## Not Claimed Yet

`companion.android.v1` does not claim:

- the existing GoatCitadel-mobile app already implements this contract end to end
- a production mobile transport implementation exercised end to end from the Android runtime/UI
- signed request execution already proven from the Android runtime/UI
- iOS runtime parity
- full Mission Control feature parity on day one

## Next Safe Slice

Use `companion.android.v1` as the contract baseline for the separate `GoatCitadel-mobile` repo, reconcile it against `templates/companion/goatcitadel-android/`, then turn the existing live gateway/session proof into the first Android runtime/UI proof bundle before expanding surface breadth.
