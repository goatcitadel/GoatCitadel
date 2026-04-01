# Android Native Spec

## Status

Android app code is still outside this repository. The current separate-repo lane exists as `GoatCitadel-mobile`, but companion.android.v1 signed-session integration is not yet proven end to end.

## Repo decision

Android ships as a separate repo:
- recommended repo: `GoatCitadel-mobile`

This keeps mobile release cadence, signing, platform-specific CI, and dependency review separate from the core GoatCitadel monorepo.

## Product scope

GoatCitadel Android is a native mobile companion with full feature-parity intent relative to Mission Control.

Key rules:
1. Mobile is not a PWA wrapper.
2. Mobile layouts and interactions must be designed for touch/mobile ergonomics.
3. Mutating actions preserve the same approval/risk posture as web.
4. Every new user-facing web feature added after mobile starts must either:
   - ship with a paired Android parity issue/spec item in the same milestone, or
   - be explicitly documented as desktop-only with a reason.

## Recommended stack

- Kotlin
- Jetpack Compose
- Android-first native architecture
- separate feature modules for major GoatCitadel domains

## Architecture layout

Recommended modules:
- `:app`
- `:core:models`
- `:core:network`
- `:core:auth`
- `:core:crypto`
- `:core:storage`
- `:core:background`
- `:feature:dashboard`
- `:feature:chat`
- `:feature:approvals`
- `:feature:tasks`
- `:feature:memory`
- `:feature:mcp`
- `:feature:skills`
- `:feature:integrations`
- `:feature:mesh`
- `:feature:office`
- `:feature:settings`
- `:feature:durable`
- `:feature:improvement`

## Networking and realtime model

### Transport priorities
1. foreground SSE with resume
2. push-to-wake / manual refresh when backgrounded
3. no assumption of permanent background websocket

### Required transport hardening
- TLS everywhere
- request signing / replay protection for mutating operations
- bounded retries with idempotency keys
- server time synchronization for signed requests

## Authentication and device security

### Required auth posture
- short-lived access tokens
- rotating refresh tokens
- device identity
- replay protection
- secure local token storage

### Storage/security requirements
- Android Keystore for device keys
- encrypted local storage for tokens/profile state
- biometric or equivalent local confirmation for critical actions
- notification privacy controls
- no sensitive payloads in push notifications

## Connectivity modes

Support three operator modes:
1. Tailnet-first recommended path
2. LAN direct with explicit trust handling
3. Public endpoint with strict TLS + hardened auth

## Feature parity policy

The Android app aims for full feature parity with Mission Control. Parity governance rules:
1. Every new major web feature must open a paired Android parity issue or be explicitly marked desktop-only.
2. Desktop-only features require a documented rationale.
3. Beta exit requires the Android backlog to be triaged against the current Mission Control feature map.

## Delivery phases

### Phase 1 — Control-plane MVP
- auth
- server profiles
- dashboard
- chat
- approvals
- tasks
- settings
- SSE event feed

### Phase 2 — Parity completion
- memory lifecycle
- MCP
- skills
- integrations
- mesh
- durable runs
- replay/improvement surfaces
- office/live feed visibility where it makes sense on mobile

### Phase 3 — Hardened beta
- device trust and pairing improvements
- notification flows
- offline outbox/idempotent retries
- replay-safe critical action UX
- performance and battery tuning

### Phase 4 — Production hardening
- security review
- telemetry/audit hardening
- incident recovery / account recovery flows
- store-readiness work

## Required server backlog for mobile

The mobile research report implies the following server-side prerequisites:
1. device identity / pairing support
2. short-lived token lifecycle and refresh rotation
3. request signing and replay cache support
4. SSE resume hardening
5. bounded replay windows
6. mobile-safe notification payload support
7. clear per-device audit attribution

## Mobile UX principles

1. Show the current server profile prominently.
2. Make destructive actions obviously destructive.
3. Keep high-frequency operational data glanceable.
4. Do not port desktop density blindly.
5. Preserve explanation/help surfaces for complex controls.

## Acceptance

This spec is complete enough for an Android engineer to begin repo setup, architecture scaffolding, and backlog sizing without having to reinterpret product intent.
