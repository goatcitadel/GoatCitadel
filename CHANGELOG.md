# Changelog

All notable changes to GoatCitadel are documented in this file.

## [Unreleased]

### Added

- Channel setup warns when a channel's provider hosts aren't allowed on the network.
- A new connection's webhook address shows before Finalize.
- The diagnostic for a dropped message names the sender.
- Google Chat can finish setup in webhook mode without a thread key, and in Chat app mode with a note that no test message is sent.
- Discord and Slack are set up from Chat › Messaging, on pages like Telegram's. Each page checks every step with the provider, asks for no ID or environment variable, and ends with Turn on in place. Discord's page lets in only the person Discord names as the bot's maker. Slack's page makes an app named "GoatCitadel" from a manifest and takes the first person who sends it a one-time code. Settings › Channels keeps the other ways: a Discord webhook with no bot, a Slack webhook, and the Slack OAuth sign-in. The real-account checks for both pages are still to be run.
- Slack can receive over Socket Mode: GoatCitadel opens a connection to Slack, so receiving needs no public web address or signing secret. It takes an app-level token (`appToken`) and `receiveMode: "socket"`. Slack refreshes the connection every few hours and GoatCitadel reopens it without an error. Socket Mode always lets in only allowlisted senders, so an older Slack connection saved as open and switched to it is not open to the whole workspace, and it leaves voice messages out.
- Slack handles `app_mention` events, so a bot answers when it is mentioned in a channel it has been added to.
- A Discord bot's or a Slack Socket Mode connection's tokens can be changed from the channel's page in Chat (**Change the key**), with the same in-place approval as Telegram.
- WhatsApp is set up from Chat › Messaging, on a page like the others. You make a Meta app and paste five values (access token, Phone number ID, WhatsApp Business Account ID, App ID and App secret); GoatCitadel checks them with Meta with read-only calls, makes a verify token, shows the Callback URL and Verify token to paste into Meta, answers Meta's address check and hears a signed one-time code for a setup draft made on that page (it keeps only the check's time, the code and its sender, in memory for 15 minutes), offers one button that subscribes the app, and ends with Turn on in place. The person who sends the code is the only allowed sender. Pairing for other people is not on the page yet. Settings › Channels keeps WhatsApp's guide for the other ways. The real-account checks are still to be run.
- A public web address setting (Settings › Channels › **Public web address**, `publicWebAddress`). It must be a public `https://` address, is saved through a Settings change you approve in place, and is what the WhatsApp page and every channel's webhook address block build their full address from.
- WhatsApp's access token can be changed from the channel's page in Chat (**Change the key**) for a connection that keeps its Phone number ID, Business Account ID, App ID and App secret.
- WhatsApp's 24-hour reply window: in a WhatsApp conversation under Messaging, the Chat composer is off, with a reason, and GoatCitadel refuses (409) an operator reply sent 24 hours or more after the person's last message. A local or mission chat bound to WhatsApp is not checked, and neither are answers the agent writes.
- `@goatcitadel/extensions-sdk` 2.0.0, in the workspace and not published yet, checks plugin manifests (`goatcitadel-plugin.json`) with `parsePluginManifest` and `loadPluginManifest`, and ships the `goatcitadel-plugin-preflight` command and a reference plugin. GoatCitadel does not install plugins yet.

### Changed

- The impeccable design skill is refreshed to upstream `4f95649`: typesetting covers line breaks (`text-wrap: balance` and `pretty`), hardening covers Arabic script, ambition scales with the surface's mode (bold for marketing and experience pages, precise and restrained for operational and reading surfaces), and a brief can no longer override a craft-floor line marked as a ban. Upstream's new desktop-app and native-platform critique steps are not vendored.
- A Slack post that arrives twice, as a message and as an `app_mention`, runs one turn. Slack events now dedupe on the post's channel and timestamp instead of the event id. A retry that straddles the upgrade may run once more.
- On a Discord connection that lets only allowlisted senders in, an owner who is also on the allowlist skips the pairing code in direct messages, and the default server channel answers only the allowlisted senders. The owner mark affects only that direct-message skip, so clearing it never opens the channel to everyone, and an owner mark without the allowlist entry changes nothing.
- The Slack tile in the channel picker no longer says receiving needs a public web address.
- The WhatsApp tile in the channel picker opens the new Chat page, at "About 15 min". WhatsApp's guide in Settings keeps the App ID and WhatsApp Business Account ID with the connection.
- Slack setups that only use an incoming webhook no longer need slack.com.
- A saved connection whose variable name breaks the channel's rule stops sending until you rename it. The setup check says how.
- The guides' content version changed, so a setup test run before this update runs again.
- The Citadel and workspace "Plugins" selection is now named "Integrations".
- Google Chat and Microsoft Teams connections keep working. They were tagged with a plugin id that nothing reads any more, and the Classic review no longer shows a "Plugin" row.

### Removed

- The Signal (`channel.signal`) and iMessage (`channel.imessage`) channels, with the `signal.send`, `imessage.send`, `imessage.react` and `imessage.unsend` tools, the Signal event-stream inbound and both typing indicators. Signal sent through signal-cli and iMessage through a BlueBubbles server. Both are unofficial clients, and that kind of client can get the account banned. A saved Signal or iMessage connection stays listed so you can delete it. Sends, reactions and unsends through it are refused with that reason. Typing reports that the channel doesn't advertise typing, and a delivery queued for it fails with that reason. Approval deliveries to it are turned off, and its approval status gives that reason. It no longer receives messages or runs live probes.
- The Zalo Personal channel (`channel.zalouser`) and its `zalouser.send` tool. It sent through an unofficial personal-account client (a zca bridge), and that kind of client can get the account banned. A saved Zalo Personal connection stays listed so you can delete it, but sends, approval deliveries and live probes through it are refused with that reason. Zalo OA (`channel.zalo`) is the supported Zalo channel.
- Arena and the add-on machinery. If you installed Arena, its files and data stay in the `addons` folder in your GoatCitadel home folder. Arena ran as a background process on `127.0.0.1:3099`, and after this update GoatCitadel can no longer show or stop it. Before you update, stop Arena in Settings › Add-ons. If it is still running afterwards, end the process that is listening on port 3099, or restart your computer. Arena's last process id is in `addons/manifest.json` in that folder; check that the process is Arena before you end it. Delete the `addons` folder when you no longer need it. Plugins replace add-ons in a later release.
- Integration plugins. GoatCitadel no longer installs, lists, enables or disables them, and channel setup no longer shows an installed plugin's setup guidance. The saved list of installed plugins is deleted when you update. A plugin installed from npm left its package files in the `integration-plugins` folder inside your data folder (`data` by default). Delete that folder when you no longer need it. A plugin installed from a local folder was used in place and never copied, so its folder is wherever you kept it. Integrations you have connected, such as MCP servers, are not plugins and are not affected. A new plugin model replaces them in a later release.
- Most of the `@goatcitadel/extensions-sdk` package. Version 2.0.0, which is in the workspace and not published yet, keeps the effective-tool snapshot helpers and gains a plugin manifest check (see Added). It drops the add-on and integration-plugin helpers, the `goatcitadel-extension-preflight` command and the reference scaffolds. `@goatcitadel/extensions-sdk@1.0.0` remains the last published version until 2.0.0 is tagged, and it still carries those helpers.
- The `verify:plugins:marketplace` check, which tested the plugin and provider marketplace boundary. The provider checks still run under `verify:agentic:proof`.

### Fixed

- Editing a channel keeps its saved key. Google Chat and the webhook channels asked for it again.
- The Discord bot logs in with its saved token, not its secure-storage reference.
- Retired channels (Signal, iMessage, Zalo Personal) show as retired everywhere, and deliveries to them fail with the retired reason.
- A key pasted on a channel's page in Chat › Messaging (Telegram, Discord, Slack, WhatsApp) is stored in the computer's secure storage. Before, GoatCitadel never handed channel setup its key store, so every pasted key was refused with "Secure channel credential storage is unavailable." Without secure storage (no OS keychain), a pasted key is still refused with that sentence, and WhatsApp's page says to use WhatsApp's guide in Settings with environment variables. Only channel keys get the key store this way; nothing else changes how it stores keys.

### Security

- Channel sends (and SMTP) read a variable only when its name matches the channel's rule, and a refused name fails the send.
- A saved key is only read for the connection or draft that owns it. Any other secure-storage reference gives no key and is never sent.
- The example tool policies (`config/tool-policy.example.json` and `config/goatcitadel.example.json`) now also deny `fs.patch` and `shell.exec_background`. Deny patterns match tool names exactly, so denying `fs.write` and `shell.exec` never covered these sibling tools. Operators who copied an earlier example should add both entries to `tools.deny` in their own config if they want the same posture.
- `shell.exec_background` now raises the same approval request as `shell.exec` when a command matches `sandbox.riskyShellPatterns`. Before, the risk check ran only at execution time and failed without creating an approval.
- Chat guidance for a tool blocked by `tools.deny`, the allow list or permission profile, a Citadel Ward, or the write roots now names the operator setting to change (for example `tools.deny` or `sandbox.operatorWriteRoots`). It no longer suggests retrying with narrower input or writing to a fallback path.

## [0.1.0-rc.1] - 2026-07-04

### Added

- Release proof bundle tooling for tagged releases:
  - signed installer checksums and cosign certificate sidecars
  - CycloneDX SBOM generation in CI
  - assembled release ZIP with artifacts, docs, and provenance metadata
  - commit-bound `release-certificate.json` covering required lane status, artifact digests, proof ZIP digest, Trivy status, and accepted failures
- Release-facing docs for reproducible builds, supported platforms, smoke tests, and dependency policy.
- `CODEOWNERS` coverage for release-bearing paths.
- Guided `llama.cpp` setup and integration flow:
  - Mission Control setup and diagnostics for local `llama.cpp` runtime validation
  - provider/config templates that treat `llama.cpp` as a first-class local runtime option
  - operator rollout notes in `docs/LLAMA_CPP_INTEGRATION_MEMO.md`

### Changed

- Project version is renumbered from `1.0.0` to `0.1.0-rc.1`: the published line is now the 0.1.0 release candidate, and installer/DMG/tarball artifact names and embedded release manifests carry the RC version.
- `SECURITY.md` now reflects the shipped `1.x` support posture instead of the pre-1.0 beta line.
- Release workflow is expanded from raw installer publishing to a signed Windows proof-package handoff with commit-bound release certification, plus a manual unsigned packaging-smoke path used for the published convenience installers.
- Packaging docs now explicitly label macOS/Linux release artifacts as development-only until those workflow matrices produce signed proof.
- Approval control routes are now explicitly operator-fenced, while remote approval token resolution remains on its separate capability-token path.
- Mission Control Channel Setup now shows only shipped guided channels instead of mixing visible built-ins with manual/later-state copy.
- Remote approval delivery now keeps connector delivery auth boundaries explicit instead of implying that approval-control fencing covers the delivery path.
- Windows x64 and arm64 installer proof was refreshed after the `1.0.0` cut; unsigned artifacts are attached to the published `0.1.0-rc.1` prerelease as clearly labeled convenience installers until public Authenticode signing is configured.
- README and Mission Control screenshot gallery were refreshed to match the current main-branch UI and docs posture.

### Fixed

- Postgres upgrade safety for chat sessions: the operator-control prefs repair now appends as a protected migration instead of mutating historical migration numbering, and migration immutability checks lock applied migration names and SQL hashes.
- Chat session creation is now transaction-wrapped so prefs, metadata, bindings, and workspace checks cannot leave half-created sessions when a later write fails.
- Gateway health now surfaces Postgres migration-name drift and required chat prefs columns instead of reporting a clean max migration version for a broken schema.
- Durable chat cancellation now records a `run_cancelled` checkpoint and trace metadata instead of mixing cancelled runs with failed-run trace truth.
- Mission Control Next runtime status now carries per-source backend errors so daemon, backup, and metric panels can render unavailable state instead of false stopped/zero facts.
- Memory admin defaults to the shipped operator lifecycle path, and Discord interaction/autocomplete response failures now emit diagnostics instead of being silently swallowed.
- Release verification now builds `@goatcitadel/extensions-sdk` before fast test/smoke steps so clean generated-output lanes do not depend on prior local build artifacts.
- MCP 1.0 authoring now keeps the visible runtime-invokable surface to local `stdio` plus the internal Approval Inbox template, with generic remote transports gated behind an explicit experimental flag.
- Mission Control shared now pins `shell-quote` to `1.8.4` so the lockfile cannot resolve the vulnerable `<=1.8.3` range affected by CVE-2026-9277, where `quote()` failed to escape newlines in object `.op` values. The current command explainer imports only `parse()`, so the bump is precautionary for this package while preserving the fixed `quote()` behavior if the dependency surface expands later.

### Verification

- Approval auth-boundary proof now covers approval list, replay, resolve, bulk-resolve, and remote-token control routes.
- Channel Setup proof now asserts a guided-only visible surface with no manual/later/parity-deficit copy.

## [1.0.0] - 2026-04-11

### Added

- First-party container deployment support:
  - multi-stage Linux `Dockerfile` for a non-root GoatCitadel runtime
  - Postgres-first `docker-compose.yaml` example with healthchecks, named volumes, and safer shared-host defaults
  - Docker install and hardening guidance in the README and install docs
- Native capability system foundations:
  - shared capability contracts for tools, skills, candidate bundles, proposals, catalog snapshots, and Code Mode runs
  - SQLite-backed persistence for capability snapshots, skill lifecycle metadata, candidate versions, proposal records/events, and Code Mode run records
  - gateway capability catalog APIs for inspectable vs callable views, immutable snapshot lookup, proposal listing/creation, and Code Mode run inspection/creation
- Governed Code Mode v1:
  - feature-flagged trusted-code execution path with explicit operator approval before every run
  - child-process execution harness with bounded IPC JSON-RPC, isolated single-file TypeScript transpilation, bounded stdout/stderr capture, and persisted code/wrapper/policy artifacts
  - curated read-only deterministic wrapper allowlist for Code Mode instead of projecting the full tool surface
- Capability lifecycle and generated-skill groundwork:
  - idempotent backfill of existing skills into lifecycle/trust/category metadata
  - runtime-managed candidate skill bundles under `data/capability-candidates/`
  - structured candidate proof artifacts including originating run, wrapper manifest version, sample input/output, and smoke-case evidence
- Mission Control capability UX:
  - Skills Hub review queue for active skills, candidates, and governed proposals
  - composer-adjacent approval footer with queue semantics, richer Code Mode approval payloads, and server-truth refresh handling

### Changed

- Fresh config defaults now prefer Postgres while keeping SQLite available as an explicit fallback.
- Continued public repo cleanup, documentation tightening, and release prep.
- Chat approvals no longer rely on the old status-lane flow or “send again to continue” behavior; blocking approvals now resume through the runtime-backed footer queue.
- Capability planning/runtime plumbing now enforces a hard split between inspectable metadata and callable capabilities so unactivated proposals and candidates stay visible without becoming executable.
- README now documents the capability system, governed Code Mode v1, the sharper Skills Hub / inline approval behavior, and the new Docker deployment path.

### Fixed

- Code Mode child harness now exits cleanly after each approved run and keeps guest code from seeing ambient Node globals such as `process` and `require`.
- Code Mode wrapper manifests now derive from the frozen callable snapshot for the run instead of the live registry, keeping auditability and execution surfaces aligned.
- Candidate-skill staging failures no longer incorrectly downgrade an otherwise completed Code Mode run.

### Verification

- `pnpm --filter @goatcitadel/contracts typecheck`
- `pnpm --filter @goatcitadel/storage typecheck`
- `pnpm --filter @goatcitadel/policy-engine typecheck`
- `pnpm --filter @goatcitadel/gateway typecheck`
- `pnpm --filter @goatcitadel/mission-control typecheck`
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/code-mode-child-source.test.ts src/routes/capabilities.test.ts src/services/gateway/auth-credential-planner.test.ts src/config.test.ts`
- `pnpm --filter @goatcitadel/mission-control exec vitest run src/pages/chat/useChatOutboundExecution.test.tsx src/pages/SkillsPage.refresh.test.tsx`

## [0.9.0-beta.1] - 2026-04-09

### Changed

- Reframed the public repository around the current product instead of internal operating material.
- Rewrote the top-level README, install guidance, and contribution guidance for external users and contributors.
- Tightened governance checks so public-required docs match the slimmer repository posture.
- Advanced the workspace release line from `0.6.0-beta.2` to `0.9.0-beta.1`.

### Removed

- Tracked local runtime state, generated artifacts, prompt-pack working files, and workspace-local notes that did not belong in a public repository.
- Internal research, audit, parity, and checklist documents that were useful for private operating workflows but noisy in the public repo.
- Tracked TypeScript build-info files and other generated leftovers that should stay uncommitted.

### Fixed

- Repo ignore rules now keep generated artifacts, runtime JSON state, and build metadata from being reintroduced accidentally.
- Public package/version references now consistently point at `0.9.0-beta.1`, including the extensions SDK release guidance.

## [0.6.0-beta.2] - 2026-03-29

### Added

- Mission Control command-center shell with `Operate`, `Observe`, and `Configure` spaces.
- Stronger runtime flows for approvals, memory maintenance, integrations, and follow-on parity reporting.
- Extension SDK publication workflow and reference authoring scaffolds.
- Signed inbound channel groundwork for WhatsApp and LINE.

### Changed

- Mission Control transport and page orchestration were decomposed into narrower, more testable units.
- Gateway ingress and runtime services were split into clearer contracts and better-covered seams.
- Documentation and screenshots were refreshed to match the newer Mission Control shell.

### Fixed

- Several gateway and Mission Control route, contract, and validation edge cases in the post-refactor stabilization pass.

## [0.1.0-beta.1] - 2026-02-28

Initial public beta baseline.

### Added

- Monorepo foundation with `apps/gateway`, `apps/mission-control`, and shared `packages/*`.
- Local-first gateway runtime with policy enforcement, approvals, skills, memory, and integrations.
- Mission Control UI, installation scripts, onboarding flows, and baseline documentation.
