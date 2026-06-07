# GoatCitadel Manual QA Test Plan

Last updated: 2026-06-06
Status: manual QA workbook for the current `1.0` repo-visible product surface

## Purpose

This plan gives a human tester a structured way to walk GoatCitadel end to end instead of casually clicking around and hoping the important things were covered.

It is intentionally formatted as a Google Docs-friendly workbook:

- each section can be copied into a Google Doc
- each case has a stable ID
- each case has a result line you can fill in later
- failures should link to screenshots, logs, terminal output, or a short screen recording
- exported PDFs should still preserve enough structure for another agent to read later

## Source Anchors

This plan is grounded in the current codebase and product-truth docs:

- [README.md](../README.md)
- [AGENTS.md](../AGENTS.md)
- [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md)
- [docs/1_0_RELEASE_SURFACE_SCOPE.md](./1_0_RELEASE_SURFACE_SCOPE.md)
- [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./CANONICAL_RUNTIME_STATE_MODEL.md)
- [docs/INSTALL_SETUP_TESTING.md](./INSTALL_SETUP_TESTING.md)
- [docs/PACKAGING.md](./PACKAGING.md)
- [docs/CAPABILITY_SYSTEM_V1.md](./CAPABILITY_SYSTEM_V1.md)
- [docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md)
- [apps/mission-control-next/src/app/route-model.ts](../apps/mission-control-next/src/app/route-model.ts)
- [scripts/verification/lib/release-surface-manifest.mjs](../scripts/verification/lib/release-surface-manifest.mjs)
- [apps/gateway/src/app.ts](../apps/gateway/src/app.ts)

Current product truth to preserve while testing:

- `apps/mission-control-next` is the canonical `1.0` shell.
- `apps/gateway` is the runtime/control-plane owner.
- Chat, Cowork, and Code are distinct operator surfaces.
- Durable execution owns the shipped resumable Chat / Cowork / Code flow set.
- Code Mode is governed trusted-code execution; do not treat it as general hostile-code sandboxing without fresh named proof.
- Docker is a runtime boundary, not a replacement for auth, policy, approvals, or path jails.
- Experimental routes must be visibly labeled and must not be counted as release-ready proof.

## How To Fill This In

Use this result line under every case:

```text
Result:
Tester:
Date:
Environment:
Evidence:
Notes:
Follow-up issue:
```

Recommended result values:

- `Pass`
- `Fail`
- `Blocked`
- `Not Run`
- `N/A`

For failures, capture:

- exact route, command, or endpoint
- workspace/project/session/run/approval IDs when visible
- provider/model and effective fallback when relevant
- screenshot or recording
- gateway log excerpt
- browser console/network error when relevant
- whether the issue is canonical runtime state, UI projection, stale refresh, missing evidence, or unclear copy

## Test Environments

Run every case only where it makes sense. Do not force optional integrations, sidecars, or installers into a normal dev-stack pass unless the change touched them.

### ENV-01 Source Dev Stack

Use for normal manual product QA.

```powershell
pnpm install --frozen-lockfile
pnpm config:sync
pnpm dev
```

Default URLs:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`

### ENV-02 Split Dev Stack

Use when testing recovery, gateway restart, stale UI, or startup race behavior.

```powershell
pnpm dev:gateway
pnpm dev:ui
```

### ENV-03 Docker Compose

Use when testing shared-host posture, auth, Postgres, backup/cutover, and non-loopback warnings.

```powershell
pnpm secrets:docker | Tee-Object -FilePath .env
docker compose up --build
```

Default URLs:

- Mission Control: `http://localhost:4173`
- Gateway health: `http://127.0.0.1:8787/health`

### ENV-04 Packaged Windows Installer

Use for installer, native host, tray, protocol, and uninstall testing.

Coverage should include:

- Windows x64 installer
- Windows arm64 installer when hardware is available
- Start Menu launch
- desktop shortcut if selected
- native WinUI 3 / Windows App SDK host
- WebView2-hosted Mission Control
- launcher fallback commands

### ENV-05 Optional / Experimental Runtime

Use only when touching these areas:

- local AI / llama.cpp
- voice runtime
- NPU sidecar
- macOS experimental DMG
- Linux experimental tarball
- add-ons
- external channels and integrations
- remote MCP / A2A

## Suggested Manual QA Order

Run the plan in this order to avoid spending hours debugging follow-on failures caused by an earlier broken foundation.

1. Startup, health, and shell navigation
2. Onboarding, provider setup, and basic Chat
3. Chat / Cowork / Code core flows
4. Projects, Library, Ops, and Settings route coverage
5. Approvals, durable runs, runtime truth, and recovery
6. Capability, Code Mode, tools, skills, and trust policy
7. Memory, knowledge, files, artifacts, and prompt packs
8. Integrations, channels, MCP, A2A, and external effects
9. Auth, security posture, backup/restore, and deployment boundaries
10. Desktop/native packaging and optional sidecars

## Preflight Checklist

### PRE-01 Repo And Runtime Baseline

Steps:

1. Record the current commit SHA.
2. Record whether the worktree is clean or dirty.
3. Record Node, pnpm, .NET SDK, Docker, and OS versions.
4. Start the selected environment.
5. Hit `/health`.
6. Open Mission Control.

Expected:

- Runtime starts without unexplained stack traces.
- `/health` returns `{"status":"ok"}`.
- Mission Control reaches the next shell, not a legacy or fallback shell.
- If auth is enabled, unauthenticated access is blocked cleanly.

Result:

### PRE-02 Automated Baseline Before Manual QA

Steps:

1. Run the smallest relevant proof lane for the change.
2. For a broad release-style pass, run the high-signal lanes below as time allows.

Recommended commands:

```powershell
pnpm verify:fast
pnpm verify:surface:regression
pnpm verify:runtime:truth
pnpm verify:durable:recovery
pnpm verify:catalog:parity
pnpm verify:memory:truth
pnpm verify:realtime:truth
pnpm verify:backup:roundtrip
pnpm docs:check
git diff --check
```

Expected:

- Manual QA starts with known automated status.
- Any skipped or failing lane is recorded before manual testing begins.
- Manual results do not silently override failed proof lanes.

Result:

### PRE-03 Test Data And Safety Setup

Steps:

1. Create a dedicated QA workspace.
2. Use sandbox provider keys, test channels, and throwaway projects.
3. Confirm no production credentials, private user files, or real external destinations are selected.
4. For external writes, prepare a sandbox Slack/Discord/Telegram/etc. target.
5. For Code Mode, select a disposable test repo or temp workspace.

Expected:

- Test actions cannot accidentally mutate personal or production data.
- Every external side effect has a known sandbox destination.
- Dangerous actions remain approval-gated.

Result:

## Startup, Install, And Runtime

### INST-01 Source Dev Startup

Steps:

1. Run `pnpm dev`.
2. Wait for gateway and UI readiness.
3. Open `http://localhost:5173`.
4. Hit `http://127.0.0.1:8787/health`.
5. Stop and restart the stack once.

Expected:

- Gateway and UI start without port confusion.
- Mission Control loads after refresh.
- Gateway restart does not leave the UI permanently stuck in a fake healthy state.

Edge cases:

- Port `5173` already in use.
- Port `8787` already in use.
- `.env` missing provider keys.
- stale `config/*.json` files before `pnpm config:sync`.

Result:

### INST-02 Split Gateway / UI Startup

Steps:

1. Start `pnpm dev:gateway`.
2. Start `pnpm dev:ui`.
3. Refresh Mission Control while gateway is up.
4. Stop gateway while UI remains open.
5. Restart gateway.

Expected:

- UI shows degraded/checking state while gateway is down.
- UI recovers after gateway restart.
- No page claims fresh runtime truth while API calls are failing.

Result:

### INST-03 Doctor And Setup Readiness

Steps:

1. Run `pnpm doctor:deep`.
2. Open Settings -> Start Here.
3. Confirm readiness, missing setup, and provider guidance.

Expected:

- Doctor output is actionable.
- Start Here does not block on unrelated background refreshes.
- Missing provider/local runtime state is labeled clearly.

Result:

### INST-04 Docker Compose Startup

Steps:

1. Generate Docker secrets.
2. Start `docker compose up --build`.
3. Open `http://localhost:4173`.
4. Hit gateway health.
5. Restart containers.

Expected:

- Stack uses token auth by default.
- Postgres healthcheck stabilizes.
- UI and gateway agree on auth and runtime state.
- Ports bind to `127.0.0.1` unless explicitly configured otherwise.

Edge cases:

- placeholder `GOATCITADEL_AUTH_TOKEN`.
- weak or missing `GOATCITADEL_POSTGRES_PASSWORD`.
- custom bind IP with missing allowed origins.

Result:

### INST-05 Packaged Windows Installer Smoke

Steps:

1. Install the Windows package.
2. Launch from Start Menu.
3. Confirm one native WinUI window opens.
4. Confirm Mission Control loads in WebView2.
5. Close the window.
6. Use tray actions: Open, Open in Browser, Runtime Status, Restart Runtime, Stop Runtime, Open Logs, Open Install Folder, Quit.
7. Run `goatcitadel status --json`.
8. Run `goatcitadel launch --no-open --json --wait`.
9. Run `goatcitadel stop --json`.
10. Uninstall.

Expected:

- Native host starts the same gateway/UI runtime.
- Close-to-tray keeps runtime behavior truthful.
- Tray commands work and surface failures.
- Launcher commands are installer-safe.
- Uninstall removes package/runtime artifacts according to installer contract without deleting unrelated files.

Edge cases:

- WebView2 missing or broken.
- malformed `goatcitadel://` protocol URL.
- external URL opened inside WebView.
- Windows SmartScreen unsigned-installer warning.

Result:

### INST-06 Protocol Routing

Steps:

1. With the Windows host installed, open `goatcitadel://open?route=/ops/activity`.
2. Try a valid deep link for `/chat`, `/cowork`, `/code`, and `/settings/providers`.
3. Try a malformed protocol URL.
4. Try an external HTTP URL.

Expected:

- Valid routes focus the app and navigate the WebView.
- Malformed URLs are ignored or reported with operator-visible diagnostics.
- External URLs are not allowed to navigate the hosted app frame.

Result:

### INST-07 macOS / Linux Experimental Package Smoke

Run only for experimental package validation.

Steps:

1. Build the relevant package target.
2. Verify checksum artifact.
3. Install/extract locally.
4. Launch packaged runtime.
5. Confirm health and Mission Control.
6. Record signing/notarization or unsigned/ad-hoc warning state.

Expected:

- macOS arm64 DMG is labeled experimental friend-smoke unless signed/notarized/stapled for the exact release.
- Linux tarball is labeled experimental until exact artifact proof promotes it.
- No experimental artifact is described as public-trust proof without matching release evidence.

Result:

## Shell, Navigation, And Visual Coverage

### NAV-01 Canonical Route Coverage

Open every current Mission Control Next route directly, then through navigation when visible.

Routes:

- `/chat`
- `/cowork`
- `/cowork/tasks`
- `/cowork/board`
- `/code`
- `/projects`
- `/library/agents`
- `/library/skills`
- `/library/capabilities`
- `/library/memory`
- `/library/knowledge`
- `/library/notes`
- `/library/communications`
- `/library/files`
- `/library/artifacts`
- `/library/prompt-packs`
- `/library/curator`
- `/ops/activity`
- `/ops/sessions`
- `/ops/schedules`
- `/ops/improvement`
- `/ops/notifications`
- `/ops/approvals`
- `/ops/costs`
- `/ops/quality`
- `/ops/runtime`
- `/ops/diagnostics`
- `/ops/kanban`
- `/settings/general`
- `/settings/onboarding`
- `/settings/providers`
- `/settings/personalities`
- `/settings/access`
- `/settings/permissions`
- `/settings/trust-policy`
- `/settings/budget`
- `/settings/runtime`
- `/settings/local-ai`
- `/settings/workspaces`
- `/settings/addons`
- `/settings/integrations`
- `/settings/channels`
- `/settings/mcp`
- `/settings/tools`

Expected:

- Each direct URL loads the right page.
- Page title/label matches route.
- Route inspector or visible chrome agrees with current route.
- No page falls back silently to the wrong surface.
- Experimental pages are labeled experimental: `/library/curator`, `/ops/improvement`, `/ops/kanban`, `/settings/personalities`, `/settings/addons`.

Result:

### NAV-02 Legacy Redirects

Steps:

1. Open legacy URLs such as `/?tab=chat`, `/?surface=code`, and `/?space=observe&page=activity&tab=scheduler`.
2. Compare expected redirect paths in the release-surface manifest.

Expected:

- Legacy URLs redirect to current routes.
- Redirected routes load the next shell.
- No legacy shell source is treated as canonical product proof.

Result:

### NAV-03 Shell State Persistence

Steps:

1. Switch between Chat, Cowork, Code, Projects, Library, Ops, and Settings.
2. Change route query params such as `sessionId`, `projectId`, `runId`, and `theme` where supported.
3. Refresh after each major area.
4. Use browser back/forward.

Expected:

- Shell chrome persists.
- URL state matches visible page state.
- Back/forward does not strand the app in stale route state.
- Thread-preserving nav items preserve only intended IDs.

Result:

### NAV-04 Desktop, Laptop, Narrow, And Mobile Layout

Viewports:

- desktop: 1440 x 1024
- laptop: 1280 x 800
- narrow desktop: 1180 x 900
- mobile: 390 x 844

Steps:

1. Open `/chat`, `/cowork`, `/code`, `/projects`, `/library/capabilities`, `/ops/runtime`, and `/settings/providers`.
2. Repeat in light and dark theme.
3. Test primary navigation and secondary nav at each viewport.

Expected:

- No clipped primary actions.
- No overlapping status chips or toolbar controls.
- Mobile page picker works.
- Threaded surfaces remain usable.
- Light/dark themes keep readable contrast.

Result:

### NAV-05 Accessibility And Keyboard Basics

Steps:

1. Navigate major surfaces using keyboard only.
2. Confirm focus ring visibility.
3. Open/close modals, menus, tabs, command palette, and dialogs with keyboard.
4. Verify important status changes have visible text, not color alone.

Expected:

- Focus order is understandable.
- Escape closes transient overlays.
- Buttons and icon-only controls expose labels/tooltips.
- Streaming, waiting, blocked, and error states are visible.

Result:

## Onboarding, Providers, And Models

### SETUP-01 Start Here First-Run Flow

Steps:

1. Open `/settings/onboarding`.
2. Follow Start Here through setup readiness.
3. Choose provider/local path.
4. Complete first Chat, Cowork, and Code guidance if available.
5. Inspect retained evidence and Run Detail links.

Expected:

- Start Here guides without overwhelming.
- Incomplete items are clear.
- Completed items persist after refresh.
- First-run proof links resolve or are clearly absent.

Result:

### SETUP-02 Provider Secret Lifecycle

Steps:

1. Open `/settings/providers`.
2. Add or update a sandbox provider key.
3. Confirm storage mode: OS secure store, env fallback, or config fallback.
4. Run model/provider smoke if available.
5. Delete or rotate the key.

Expected:

- Secret state is visible without leaking the secret.
- Bad key produces readable auth error.
- Deleted/rotated key changes effective runtime behavior after refresh.
- Provider status does not claim success from stale cached data.

Edge cases:

- secure-store unavailable.
- key exists in `.env` but not secure store.
- provider base URL is invalid.
- model name exists in config but not provider.

Result:

### SETUP-03 Model Discovery And Routing Truth

Steps:

1. Refresh model catalog.
2. Select a default provider/model.
3. Trigger a Chat turn.
4. Inspect requested vs effective provider/model.
5. Create a fallback scenario if possible.

Expected:

- Requested and effective provider/model are both visible.
- Fallback reason is visible when a fallback occurs.
- Usage/cost/token estimates are labeled with confidence.

Result:

### SETUP-04 Local AI And llama.cpp

Run only if local AI is configured or touched.

Steps:

1. Open `/settings/local-ai`.
2. Inspect hardware readiness.
3. Inspect model fit recommendations.
4. Start or prepare a local model job if supported.
5. Open runtime diagnostics for local endpoints.

Expected:

- Local AI stays honest about advisory vs runnable state.
- Jobs are approval-gated where required.
- Optional sidecars do not imply mature local inference.

Result:

## Chat Surface

### CHAT-01 Basic Chat Send And Persistence

Steps:

1. Open `/chat`.
2. Create a fresh session.
3. Send a simple prompt.
4. Wait for completion.
5. Refresh.
6. Return to the same session.

Expected:

- User and assistant messages persist.
- Session title/list updates.
- Runtime context is visible when present.
- No duplicate assistant response appears after refresh.

Result:

### CHAT-02 Streaming, Cancel, Retry, And Resume

Steps:

1. Send a prompt that streams for several seconds.
2. Cancel mid-stream.
3. Retry the turn.
4. Refresh during or after retry.
5. Inspect turn status and stream state.

Expected:

- Cancel state is explicit.
- Retry creates a clear branch or replacement according to UI rules.
- Final content is not overwritten by stale fetched content.
- Partial stream failures do not concatenate retry output into the same assistant turn.

Result:

### CHAT-03 Edit And Branch Behavior

Steps:

1. Send a prompt.
2. Edit the user turn.
3. Generate a new response.
4. Navigate between branches if controls exist.
5. Refresh and verify selected branch.

Expected:

- Branch/tail selection is stable.
- Edited turn does not corrupt prior transcript.
- Session rail reflects current branch/title truth.

Result:

### CHAT-04 Local Slash Commands

Steps:

1. Run `/help` before configuring a cloud provider if possible.
2. Run one command from the command catalog.
3. Parse an invalid command.

Expected:

- Local command path does not require unnecessary provider validation.
- Results render as stable thread updates.
- Invalid commands return readable guidance.

Result:

### CHAT-05 Attachments And File Preview

Steps:

1. Attach a small text file.
2. Attach a small image if supported.
3. Try an unsupported or oversized file.
4. Reopen uploaded attachment content.
5. Inspect generated preview CSP behavior if possible.

Expected:

- Supported attachments persist and can be reopened.
- Unsupported MIME/oversized files are rejected clearly.
- Preview content cannot run active scripts.
- Attachment errors do not break the whole session.

Result:

### CHAT-06 Context, Memory, Citations, And Tool Visibility

Steps:

1. Ask a question that should use memory or knowledge if available.
2. Inspect context manifest.
3. Inspect citations/tool calls/runtime status.
4. Give memory feedback if available.

Expected:

- Context sources are inspectable.
- Recall strategy/provenance is visible where applicable.
- Tool use is neither hidden nor overclaimed.
- Memory is not silently promoted from temporary context.

Result:

### CHAT-07 Delegation And Specialist Candidates

Steps:

1. Trigger or inspect delegation suggestions.
2. Accept a delegation if safe.
3. Inspect linked run/task/state.
4. Create or update a specialist candidate if supported.

Expected:

- Delegation lineage is visible.
- Suggested vs accepted state is clear.
- Candidate/proposal state does not become callable without activation.

Result:

### CHAT-08 Research Search

Steps:

1. Start a research/search run from Chat if configured.
2. Inspect run status.
3. Open result and source details.
4. Test failure with no network or bad search config if feasible.

Expected:

- Research run status is durable or clearly transient.
- Sources are visible.
- Failure does not masquerade as no results.

Result:

### CHAT-09 Proactive Policy

Steps:

1. Inspect proactive status.
2. Change proactive policy where exposed.
3. Trigger a safe proactive run if supported.
4. Confirm run list/history.

Expected:

- Proactive behavior is opt-in/governed.
- Policy changes persist.
- Triggered work produces visible evidence and does not run hidden high-risk actions.

Result:

### CHAT-10 Side Chat, Dock, And Workbench Panels

Steps:

1. Open side chat or context drawer.
2. Open artifact/memory/approval dock panels.
3. Switch routes and return.
4. Test mobile layout.

Expected:

- Panels do not cover composer or critical status.
- Drawer state is understandable after route switches.
- Mobile panel behavior is usable.

Result:

## Cowork Surface

### COWORK-01 Start Or Resume Durable Cowork Run

Steps:

1. Open `/cowork`.
2. Start a supervised multi-step task.
3. Inspect plan, next action, blockers, and evidence.
4. Refresh during the run.
5. Resume an existing run.

Expected:

- Cowork feels distinct from Chat.
- Durable run/run detail is visible when present.
- Current step and checkpoint state survive refresh.
- Blocked/waiting/running/completed states are not blurred.

Result:

### COWORK-02 Task Board

Steps:

1. Open `/cowork/tasks`.
2. Create a task.
3. Edit status, owner/agent, deliverable, and blocker fields if available.
4. Soft-delete/archive and restore.
5. Refresh.

Expected:

- Task state persists.
- Board counts match visible items.
- Restore works without duplicating tasks.
- Blocker hierarchy is clear.

Result:

### COWORK-03 Agent Board

Steps:

1. Open `/cowork/board`.
2. Inspect agent posture.
3. Trigger or seed a running/blocked/done agent state.
4. Compare with `/ops/kanban` if relevant.

Expected:

- Agent board is an inspectable posture surface.
- It does not imply autonomous live-control parity.
- Experimental bulk controls stay labeled when present.

Result:

### COWORK-04 Approval Wait And Resume

Steps:

1. Trigger a Cowork action that requires approval.
2. Confirm composer/run state blocks appropriately.
3. Resolve approval from Ops -> Approvals.
4. Return to Cowork and resume if required.

Expected:

- Approval wait is explicit.
- Approval resolution does not advance only UI-side state.
- Durable execution owns the resume.

Result:

### COWORK-05 Gateway Restart During Cowork Run

Steps:

1. Start a durable Cowork run.
2. Stop gateway mid-run.
3. Restart gateway.
4. Inspect Cowork, Ops -> Sessions, Ops -> Diagnostics, and run detail.

Expected:

- Run recovers, waits, retries, dead-letters, or fails with clear state.
- No orphaned "running" fiction remains.
- Recovery evidence is inspectable.

Result:

## Code Surface And Code Mode

### CODE-01 Code Workbench Basics

Steps:

1. Open `/code`.
2. Bind a safe test source/workspace.
3. Inspect file tree.
4. Open and edit a file if supported.
5. Review diff.
6. Run a targeted validation command if supported.

Expected:

- Code feels distinct from Chat/Cowork.
- Source binding and path boundaries are visible.
- Diffs are inspectable before risky mutation.
- Validation output is bounded and readable.

Result:

### CODE-02 File Path Jail

Steps:

1. Attempt to open a file inside the allowed workspace.
2. Attempt a traversal-like path outside the allowed workspace.
3. Attempt symlink or junction edge cases if safe.

Expected:

- Allowed files open.
- Out-of-root paths are blocked.
- Error copy explains the boundary without exposing secrets.

Result:

### CODE-03 Code Mode Approval Gate

Precondition: `GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED=true` if needed.

Steps:

1. Start a simple trusted-code Code Mode run.
2. Inspect pending approval.
3. Approve.
4. Inspect run detail, artifacts, hashes, stdout/stderr, and backend metadata.

Expected:

- Every run is operator-approved.
- Source/artifact hashes are recorded.
- stdout/stderr are bounded and truncation state is visible.
- Host isolation metadata is truthful.
- No hostile-code safety claim is made unless named proof supports it.

Result:

### CODE-04 Code Mode Reject And Failure

Steps:

1. Start a Code Mode run.
2. Reject the approval.
3. Start another run that fails validation or runtime execution safely.
4. Inspect run ledger.

Expected:

- Rejected runs do not execute.
- Failed runs retain artifact evidence.
- Failure phase/error code is visible.
- Candidate-save does not happen after reject/failure.

Result:

### CODE-05 Candidate Lifecycle

Steps:

1. Create or inspect a generated candidate.
2. Open candidate details.
3. Promote candidate.
4. Revoke candidate.
5. Roll back if supported.
6. Inspect callable catalog after each step.

Expected:

- Candidate/proposal is inspectable before activation.
- Promotion/revocation changes lifecycle state.
- Callable catalog widens only after explicit activation.
- Rollback/revoke does not leave stale callable entries.

Result:

### CODE-06 Execution Backend Truth

Steps:

1. Inspect `/api/v1/code-mode/execution-backends` or UI equivalent.
2. Compare host runner, Docker backend, and Aider adapter availability.
3. Try an unavailable required backend.

Expected:

- Default trusted-code host runner is visible.
- Docker runs only when explicitly configured.
- Aider remains audit-only if enabled.
- Required isolation fails closed when unavailable.

Result:

## Projects

### PROJ-01 Project CRUD And Navigation

Steps:

1. Open `/projects`.
2. Create a test project.
3. Open project detail route.
4. Link or continue Chat, Cowork, and Code work from the project.
5. Edit project metadata.
6. Archive/delete if supported.

Expected:

- Project appears in list and direct route.
- Cross-surface continuation keeps project identity.
- Project changes do not leak across workspaces.

Result:

### PROJ-02 Project Import

Steps:

1. Import a small test project/workspace if supported.
2. Inspect created sessions/tasks/files.
3. Re-import same source.

Expected:

- Import result is understandable.
- Duplicate import is idempotent or explicitly creates a separate item.
- Errors identify invalid source or unsupported shape.

Result:

## Library: Agents, Skills, Capabilities

### LIB-AG-01 Agents Catalog And Profiles

Steps:

1. Open `/library/agents`.
2. List agent profiles.
3. Create or edit a test profile.
4. Archive/restore.
5. Activate session from a profile if available.

Expected:

- Agent roster loads.
- Profile lifecycle state persists.
- Archived agents do not appear as active unless filter says so.

Result:

### LIB-SK-01 Skills Catalog

Steps:

1. Open `/library/skills`.
2. Inspect skill sources and lifecycle state.
3. Search or filter.
4. Reload skills.

Expected:

- Skill list is readable.
- Source/provenance is visible.
- Reload does not silently widen activation.

Result:

### LIB-SK-02 Skill Import Validate / Install

Steps:

1. Validate a known-good local skill bundle.
2. Validate a malformed bundle.
3. Install the known-good bundle after review.
4. Inspect import history.

Expected:

- Good bundle shows manifest/hash review evidence.
- Bad bundle fails with specific errors.
- Scripts remain review-only/non-callable unless separately governed.
- Import history is durable.

Result:

### LIB-SK-03 Skill Evaluation And Activation

Steps:

1. Preview a skill evaluation.
2. Run evaluation.
3. Create proposal from evaluation if supported.
4. Change skill state.
5. Inspect activation policy.

Expected:

- Evaluation output links to skill identity.
- Proposal lifecycle is clear.
- State changes respect policy and approval boundaries.

Result:

### LIB-CAP-01 Capability Browser

Steps:

1. Open `/library/capabilities`.
2. Compare inspectable and callable catalog concepts in the UI.
3. Inspect degraded, inactive, proposed, and active entries where available.

Expected:

- Inactive candidates/proposals are inspectable but not callable.
- Degraded posture is visible.
- Catalog state agrees with Settings -> Trust & Policy and Tools.

Result:

### LIB-CAP-02 Autonomy Grants

Steps:

1. Create a low-risk, narrow autonomy grant.
2. Evaluate it.
3. Trigger a covered action if safe.
4. Revoke the grant.
5. Attempt the action again.

Expected:

- Grant has workspace, surface, risk tier, patterns, budget/count, grantor, reason, expiry, and revocation state.
- Deny-wins policy still overrides grant.
- Revoked or expired grant no longer authorizes the action.

Result:

### LIB-CAP-03 Capability Packs

Steps:

1. Preview local capability pack.
2. Install/stage a pack if safe.
3. Export preview/evidence.
4. Inspect Settings -> Add-ons and Library -> Capabilities.

Expected:

- Pack materialization receipts are review evidence only.
- Installing/staging does not auto-activate assets.
- Asset activation remains routed through existing governed lifecycle.

Result:

## Library: Memory, Knowledge, Notes

### LIB-MEM-01 Memory List, Edit, Forget, History

Steps:

1. Open `/library/memory`.
2. Create or identify a test memory item.
3. Edit it.
4. View history.
5. Forget/delete it.
6. Refresh and switch workspace.

Expected:

- Memory lifecycle routes through operator-facing controls.
- History/provenance is visible.
- Forgotten items do not keep influencing context.
- Workspace scope is explicit.

Result:

### LIB-MEM-02 Explicit Recall Modes

Steps:

1. Run targeted recall.
2. Run broad summary recall.
3. Trigger post-compaction/resume context if feasible.
4. Inspect context pack provenance.

Expected:

- Recall modes are explicit.
- Retrieval strategy and match signals are labeled.
- Memory is not hidden automatic prompt injection.

Result:

### LIB-MEM-03 Trace-Derived Memory Proposals

Steps:

1. Create a chat/tool trace that may propose memory.
2. Inspect proposal queue.
3. Promote or reject a proposal.
4. Confirm raw logs/tool outputs/secret-like values are not stored as trusted memory.

Expected:

- Trace-derived memory is proposal-first.
- Promotion requires operator authority or write-gate path.
- Sensitive/browser-content guard evidence is respected.

Result:

### LIB-MEM-04 Memory Quality And Maintenance

Steps:

1. Inspect memory quality issues.
2. Trigger scan/maintenance if feature flag is enabled.
3. Resolve/dismiss an issue.
4. Confirm suppression/history.

Expected:

- Maintenance controls obey feature flags.
- Issues include source drift, stale low-value records, duplicates, contradictions, or retrieval gaps when detected.
- Resolution persists.

Result:

### LIB-KNOW-01 Knowledge Sources

Steps:

1. Open `/library/knowledge`.
2. Add or inspect a knowledge source.
3. Search or attach it to Chat/Cowork context.
4. Remove or disable it if supported.

Expected:

- Source identity/provenance is visible.
- Attached context can be inspected.
- Disabled source no longer appears as active context.

Result:

### LIB-NOTES-01 Notes And Reminders

Steps:

1. Open `/library/notes`.
2. Create note.
3. Edit and archive.
4. Create reminder.
5. Complete reminder.

Expected:

- Notes/reminders are workspace-scoped personal ops, not learned memory.
- Archive/complete state persists.
- Empty and filtered states are clean.

Result:

## Library: Communications, Files, Artifacts, Prompt Packs

### LIB-COMM-01 Communications Overview

Steps:

1. Open `/library/communications`.
2. Inspect inbox/agenda/contacts/drafts where configured.
3. Create a draft if supported.
4. Attempt send path only against a sandbox account.

Expected:

- Missing connector state is clear.
- Outbound draft/send is approval-gated where required.
- Raw credentials are not shown.

Result:

### LIB-FILE-01 Files Browser

Steps:

1. Open `/library/files`.
2. Upload or select a safe file.
3. Preview it.
4. Download it.
5. Try unsupported MIME and traversal-like paths.

Expected:

- File metadata and preview are clear.
- Preview route uses safe CSP.
- Traversal and unsupported content are rejected clearly.

Result:

### LIB-ART-01 Generated Artifacts

Steps:

1. Open `/library/artifacts`.
2. Generate a small artifact from Chat/Cowork/Code.
3. Reopen artifact.
4. Inspect linked run/session/source/decision evidence.

Expected:

- Artifact remains accessible after refresh.
- Provenance links resolve.
- Missing provenance is admitted plainly.

Result:

### LIB-PP-01 Prompt Pack Import And Preview

Steps:

1. Open `/library/prompt-packs`.
2. Preview import.
3. Import a built-in or local pack.
4. Inspect tests.

Expected:

- Preview catches malformed pack shape.
- Imported pack identity/source label persists.
- Built-in import does not duplicate unexpectedly.

Result:

### LIB-PP-02 Prompt Pack Run, Score, Review

Steps:

1. Run one prompt-pack test.
2. Inspect raw output.
3. Add manual review/verdict.
4. Auto-score if configured.
5. Reload report.

Expected:

- Run status is explicit.
- Manual and auto scores are attributed separately.
- Failed runs do not show as pass.
- Review persists.

Result:

### LIB-PP-03 Benchmark, Cancel, Replay, Trends, Export, Reset

Steps:

1. Start a small benchmark matrix.
2. Cancel a benchmark leg if safe.
3. Run replay regression.
4. Inspect report/trends.
5. Export pack.
6. Reset with safe flags.

Expected:

- Matrix rows stay attached to correct run IDs.
- Cancelled/incomplete legs remain visible.
- Replay runs are labeled as replay.
- Reset affects only intended data.

Result:

### LIB-CUR-01 Skill Curator Experimental Surface

Steps:

1. Open `/library/curator`.
2. Inspect proposals and health ranking.
3. Try an archive/proposal path only if safe.

Expected:

- Surface is experimental.
- Recommendations do not act as final release automation.
- Actions remain reviewable.

Result:

## Ops: Activity, Sessions, Runtime, Diagnostics

### OPS-ACT-01 Activity Feed And Realtime Events

Steps:

1. Open `/ops/activity`.
2. Generate a chat turn, approval, task change, and runtime diagnostic.
3. Watch retained event feed.
4. Open event details.

Expected:

- Events are human-readable.
- Raw payload is secondary.
- `eventClass`, `eventAuthority`, and links are visible or reflected in UI truth.
- Activity does not pretend to be complete historical record.

Result:

### OPS-ACT-02 SSE Degradation

Steps:

1. Open activity feed.
2. Interrupt SSE/network or stop gateway.
3. Watch status banner.
4. Restore gateway/network.

Expected:

- UI shows degraded live updates.
- Stale counts/status are labeled.
- Recovery does not duplicate events wildly.

Result:

### OPS-SES-01 Sessions And Timeline

Steps:

1. Open `/ops/sessions`.
2. Open a Chat session detail.
3. Inspect transcript, summary, and timeline.
4. Compare with Chat route.

Expected:

- Session is distinct from durable run.
- Transcript and timeline agree with Chat.
- Missing summaries show explicit empty/unavailable state.

Result:

### OPS-SES-02 Runtime Lifecycle Export

Steps:

1. Open or call runtime lifecycle view/export.
2. Inspect canonical vs linked fields for a session/run/approval case.

Expected:

- Canonical fields prefer explicit stored linkage.
- Inferred/linked fields are labeled separately.
- Export is redacted and usable as evidence.

Result:

### OPS-RUN-01 Runtime Page

Steps:

1. Open `/ops/runtime`.
2. Inspect gateway health, daemon posture, host vitals, spend, backups, and local runtime indicators.
3. Restart gateway or daemon if safe.

Expected:

- Runtime truth is high-signal and readable.
- Backup state is visible.
- Experimental sidecars stay labeled.

Result:

### OPS-DIAG-01 Diagnostics Directory

Steps:

1. Open `/ops/diagnostics`.
2. Inspect durable, daemon, admin, docs, readiness, and verification diagnostics.
3. Open one run/detail view.

Expected:

- Diagnostics are drill-in surfaces, not raw JSON-only.
- Readiness failures are actionable.
- Docs/verification links resolve.

Result:

### OPS-COST-01 Costs And Budget Evidence

Steps:

1. Open `/ops/costs`.
2. Run a Chat turn.
3. Inspect usage/cost update.
4. Open `/settings/budget` and adjust mode if safe.

Expected:

- Costs distinguish measured usage from estimates.
- Budget mode persists.
- Cost UI does not claim certainty it lacks.

Result:

### OPS-QUAL-01 Quality Dashboard

Steps:

1. Open `/ops/quality`.
2. Inspect eval proof, prompt-pack gate posture, design quality card, and export paths.
3. Compare with Library -> Prompt Packs.

Expected:

- Quality reflects real evidence.
- Export/report paths are read-only where appropriate.
- Prompt-pack failures are not smoothed into green summaries.

Result:

### OPS-SCHED-01 Schedules

Steps:

1. Open `/ops/schedules`.
2. Create or inspect a safe recurring job.
3. Disable/pause it.
4. Check next-run time and timezone behavior.

Expected:

- Scheduler posture is visible.
- Risky recurring work remains governed.
- Timezone and disabled state are clear.

Result:

### OPS-NOTIF-01 Notifications And Operator Attention

Steps:

1. Open `/ops/notifications`.
2. Generate a blocked/failed/done/waiting event.
3. Inspect notification signals.
4. Adjust notification preferences if visible.

Expected:

- Needs-attention signals appear.
- Done/failed/blocked states are distinguishable.
- Sound/browser notification settings persist.

Result:

### OPS-IMP-01 Improvement Experimental Surface

Steps:

1. Open `/ops/improvement`.
2. Inspect replay/self-improvement support.
3. Run only safe read-only paths unless explicitly testing improvement loops.

Expected:

- Surface is experimental.
- No copy implies autonomous release magic.

Result:

### OPS-KAN-01 Kanban Experimental Surface

Steps:

1. Open `/ops/kanban`.
2. Inspect task/subagent board.
3. Create distress signal or retry budget in a safe test task.
4. Try bulk controls only in QA workspace.

Expected:

- Surface is experimental.
- Bulk controls are not presented as final release control.
- Distress/retry/artifact verification state persists.

Result:

## Approvals And Durable Runs

### APPR-01 Pending Approval Creation

Steps:

1. Trigger a risky tool, Code Mode run, external send, or other approval-gated action.
2. Open `/ops/approvals`.
3. Inspect pending item.

Expected:

- Approval appears in queue and linked surface.
- Risk, action type, preview, affected resources, and linkage are readable.
- Pending item does not require raw JSON to understand.

Result:

### APPR-02 Approve, Reject, And History

Steps:

1. Approve one pending item.
2. Reject another pending item.
3. Inspect history and replay.
4. Return to linked Chat/Cowork/Code surface.

Expected:

- Approved/rejected state is durable.
- Follow-on work is visible as completed, pending, skipped, unknown, or failed.
- Reject prevents side effects.

Result:

### APPR-03 Resolve Failure

Steps:

1. Open a pending approval.
2. Simulate or cause resolve failure.
3. Inspect modal, row, and error copy.

Expected:

- Modal remains open.
- Pending row does not disappear optimistically.
- Retry path is clear.

Result:

### APPR-04 Bulk Resolve

Steps:

1. Create multiple pending approvals.
2. Select subset.
3. Bulk approve or reject.
4. Refresh.

Expected:

- Only selected approvals change.
- Counts update.
- History records each decision.

Result:

### APPR-05 Remote Token Flow

Steps:

1. Generate remote approval token.
2. Resolve through remote flow.
3. Inspect canonical approval and audit.

Expected:

- Token issuance is explicit.
- Remote resolution updates same canonical approval.
- Expired/invalid tokens fail closed.

Result:

### APPR-06 Expired Approval

Steps:

1. Use seeded or naturally expired approval.
2. Inspect pending and history.
3. Attempt resolve if control remains visible.

Expected:

- Expired item leaves pending.
- History shows expired.
- Resolve action is disabled or rejected.

Result:

### DUR-01 Durable Run List And Detail

Steps:

1. Create or find a durable run.
2. Open run detail from Cowork, Ops -> Diagnostics, or lifecycle links.
3. Inspect timeline, checkpoints, retry status, dead-letter state, and evidence.

Expected:

- Run state is readable.
- Checkpoints are available when expected.
- Session/turn/run/approval concepts are not conflated.

Result:

### DUR-02 Pause, Resume, Retry, Dead Letter

Steps:

1. Create a pauseable/waiting run.
2. Pause.
3. Resume manually.
4. Trigger retry if safe.
5. Inspect dead-letter or blocked state if available.

Expected:

- Paused vs waiting-for-event is distinct.
- Resume is an operator-visible action.
- Retry/dead-letter states have evidence and next action.

Result:

### DUR-03 Approval Resolves While Run Paused

Steps:

1. Create paused run linked to approval.
2. Resolve approval.
3. Inspect run and approval state.

Expected:

- Approval may resolve.
- Run remains paused unless explicitly resumed.
- UI does not say "all done" when downstream work is unresolved.

Result:

### DUR-04 Restart Recovery

Steps:

1. Start durable Chat/Cowork/Code flow.
2. Restart gateway.
3. Inspect run, session, approval, and activity state.

Expected:

- State survives restart.
- Recovery truth is visible.
- No stale running/completed fiction remains.

Result:

## Settings And Governance

### SET-01 General Settings

Steps:

1. Open `/settings/general`.
2. Change a harmless preference.
3. Refresh.
4. Switch workspace.

Expected:

- Preference persists at intended scope.
- Unsaved changes are protected.

Result:

### SET-02 Personalities Experimental

Steps:

1. Open `/settings/personalities`.
2. Select or adjust a preset.
3. Open Chat and verify default framing if supported.

Expected:

- Surface is experimental.
- Personality changes do not override safety/policy/tool rules.

Result:

### SET-03 Access And Auth

Steps:

1. Open `/settings/access`.
2. Inspect auth mode, secrets, device grants, companion sessions, and audit.
3. Revoke a test device/session if available.

Expected:

- Auth posture is clear.
- Secrets are redacted.
- Revoked sessions cannot continue.

Result:

### SET-04 Companion / Mobile Continuity

Steps:

1. Create device request or companion session.
2. Exchange/refresh session.
3. Inspect `/api/v1/mobile/capabilities` or UI equivalent.
4. Revoke device grant.

Expected:

- Device grants are signed/scoped.
- Mobile companion does not imply ungoverned control plane.
- Revoke blocks future use.

Result:

### SET-05 Permissions

Steps:

1. Open `/settings/permissions`.
2. Create or edit a permission profile.
3. Evaluate safe vs risky tool/action access.
4. Test local operator override if supported.

Expected:

- Deny-wins policy remains authoritative.
- Override evidence is explicit.
- Profile changes affect subsequent actions only as intended.

Result:

### SET-06 Trust And Policy Snapshot

Steps:

1. Open `/settings/trust-policy`.
2. Inspect capability/tool/source trust matrix.
3. Jump to Permissions, Tools, MCP, Skills, Capabilities, or Approvals.
4. Simulate snapshot API unavailable if feasible.

Expected:

- Dashboard is inspectable and read-oriented.
- Jumps land on correct settings/library pages.
- Snapshot failure is fail-closed and readable.

Result:

### SET-07 Workspaces And Guidance

Steps:

1. Open `/settings/workspaces`.
2. Create workspace.
3. Edit workspace guidance.
4. Switch to another workspace.
5. Archive/restore if supported.

Expected:

- Workspace state and guidance persist.
- Data does not leak silently across workspaces.
- Archived workspace is clearly inactive.

Result:

### SET-08 Tools Catalog And Grants

Steps:

1. Open `/settings/tools`.
2. Inspect tool catalog.
3. Evaluate access for a safe tool and risky tool.
4. Create, expire, and revoke a grant.

Expected:

- Tool access state is readable.
- Grants are scoped and expiring.
- Risky tool remains approval/policy governed.

Result:

## Integrations, Channels, MCP, A2A, Add-ons

### INT-01 Integrations Overview

Steps:

1. Open `/settings/integrations`.
2. Inspect all visible connectors.
3. For each visible beta/native connector, identify setup/action path or blocked copy.

Expected:

- No visible connector is a diagnostics-only shell without saying so.
- Runnable entries expose real operator actions.
- Blocked/incomplete entries are labeled.

Result:

### INT-02 Channel Setup Matrix

Run only against sandbox targets.

Channels to cover when configured:

- Discord
- Slack
- Telegram
- Google Chat
- Teams
- Mattermost
- WhatsApp
- Signal
- iMessage / BlueBubbles
- Nextcloud Talk
- LINE
- Zalo OA
- Zalo Personal

Steps:

1. Open `/settings/channels`.
2. Create or edit connection.
3. Run guided auth/check/test/retest.
4. Send sandbox message when supported.
5. Inspect capability and diagnostics state.
6. Test bad token or missing permission.

Expected:

- Channel capability metadata agrees between UI and API.
- Bad token/missing permission errors are readable.
- Webhook-only/manual-confirm paths are labeled.
- Break-glass or public-webhook requirements are explicit.

Result:

### INT-03 Comms Public Actions

Steps:

1. Use safe sandbox connection.
2. Test `send`, `reply`, `react`, `unsend`, `typing`, and `activity` where supported.
3. Inspect diagnostics.

Expected:

- Unsupported actions fail clearly.
- Supported actions go through configured connector.
- Approval/policy boundaries still apply.

Result:

### INT-04 Webhooks And Inbound Verification

Steps:

1. Configure one inbound webhook-capable channel.
2. Send inbound sandbox event.
3. Try invalid signature/token.
4. Inspect linked session/task/activity.

Expected:

- Valid inbound event creates/updates intended state.
- Invalid signature/token is rejected.
- No secret payload is logged or shown raw.

Result:

### INT-05 External Side Effects And Replay

Connections to test when configured:

- Activepieces
- Trello
- Gmail send
- local bridge writes
- generic external writeback

Steps:

1. Trigger a safe external write in sandbox.
2. Inspect evidence envelope and side-effect ledger.
3. Test failed-before-boundary case.
4. Test unknown-post-boundary/manual reconciliation case.
5. Run explicit Activepieces `check_run_status` if configured.

Expected:

- Idempotency is claimed before crossing external boundary.
- Replay only retries eligible failed-before-boundary/stale claimed-not-sent states.
- Unknown post-boundary outcomes stay manual.
- Activepieces status is explicit operator read, not background polling.

Result:

### MCP-01 Local stdio MCP

Steps:

1. Open `/settings/mcp`.
2. Configure a safe local stdio server.
3. Inspect tool/resource discovery.
4. Invoke a safe tool through governed path.
5. Disable server.

Expected:

- Local stdio readiness is visible.
- Invocation remains Gateway-mediated.
- Disable removes callable availability.

Result:

### MCP-02 Approval Inbox MCP

Steps:

1. Enable/inspect built-in Approval Inbox path.
2. Generate approval.
3. Read/resolve through MCP path if configured.

Expected:

- Approval Inbox truth matches Ops -> Approvals.
- Resolution remains governed and audited.

Result:

### MCP-03 Remote HTTP/SSE MCP With Auth

Auth modes to test when available:

- no auth
- token env
- OAuth2

Steps:

1. Configure remote server.
2. Verify network allowlist/auth readiness.
3. For OAuth2, connect/reconnect and inspect token refs.
4. Invoke safe tool.
5. Expire/remove token and retry.

Expected:

- Remote invocation is Gateway-mediated.
- Missing OAuth tokens show `needs_auth`.
- Expired tokens show `expired` until reconnect/refresh.
- Bearer/token details stay redacted.

Result:

### A2A-01 Agent Card And Peer Auth

Steps:

1. Request public `/.well-known/agent-card.json`.
2. Request operator `/api/v1/a2a/agent-card`.
3. Test peer-authenticated path if configured.

Expected:

- Public discovery disabled by default.
- Operator diagnostics available.
- Peer auth is separate from operator auth.

Result:

### A2A-02 Inbound / Outbound Task Binding

Steps:

1. Preview inbound or outbound A2A task.
2. Send a sandbox task.
3. Inspect task/session/durable binding.
4. Send duplicate peer/context/message if safe.

Expected:

- Binding is idempotent by peer/context/message identity.
- A2A task creates or links canonical local session/task/run state.
- A2A does not claim to replace GoatCitadel mesh.

Result:

### A2A-03 Push Notification And gRPC

Run only if explicitly configured.

Steps:

1. Configure peer push notification.
2. Send a task event.
3. Configure gRPC transport only with explicit binding/listener.
4. Inspect audit/network allowlist behavior.

Expected:

- Push/gRPC remain explicit Gateway transports.
- Network allowlists and audit apply.
- Missing config fails closed.

Result:

### ADDON-01 Add-ons Experimental Lifecycle

Steps:

1. Open `/settings/addons`.
2. Inspect catalog/source/trust tier.
3. Install a safe reference add-on only after review.
4. Launch/stop/update/disable/uninstall.
5. Inspect health checks and install location.

Expected:

- Surface is experimental.
- Add-on install is never silent.
- Install path is outside core checkout.
- Trust metadata is visible and not treated as cryptographic proof.

Result:

## Browser Sessions, Voice, Media, Optional Sidecars

### BROW-01 Browser Session Grants

Steps:

1. Create browser session.
2. Inspect state/events.
3. Grant scoped access.
4. Rotate grant.
5. Delete grant and session.

Expected:

- Grants are scoped, inspectable, rotatable, and revocable.
- Deleted grants stop working.
- Events are redacted.

Result:

### VOICE-01 Transcription And Voice Runtime

Run only if voice runtime is installed or touched.

Steps:

1. Open voice runtime status.
2. Install/select/remove a managed model.
3. Transcribe safe sample audio.
4. Start/stop talk session.

Expected:

- Managed runtime install explains what and why.
- Model files live outside repo.
- Missing ffmpeg/whisper produces actionable error.

Result:

### VOICE-02 Wake And Google Meet

Run only if configured.

Steps:

1. Start/stop wake.
2. Check Google Meet prerequisites.
3. Start a test session.
4. Submit transcript and consult.
5. Stop session.

Expected:

- Permission/runtime requirements are explicit.
- Sessions stop cleanly.
- Transcript/consult data is not stored unexpectedly.

Result:

### MEDIA-01 Media Routes

Steps:

1. Upload or process safe media sample.
2. Test unsupported media.
3. Inspect output/artifact and redaction.

Expected:

- Supported media path works.
- Unsupported input is rejected clearly.
- Outputs link to artifact provenance.

Result:

### NPU-01 NPU Sidecar Experimental

Run only if touching NPU sidecar.

Steps:

1. Start Python sidecar.
2. Open `/settings/local-ai` and `/ops/runtime`.
3. Hit NPU diagnostics.
4. Stop sidecar.

Expected:

- NPU is labeled optional/experimental.
- Sidecar absence is not treated as product failure.
- Local inference maturity is not overclaimed.

Result:

## Security, Auth, And Runtime Boundaries

### SEC-01 Token Auth

Steps:

1. Start with token auth enabled.
2. Open Mission Control without token/bootstrap.
3. Authenticate.
4. Retry API calls.

Expected:

- Unauthenticated access is blocked cleanly.
- Authenticated path succeeds.
- UI does not enter half-ready state.

Result:

### SEC-02 Browser Mutation Intent Header

Steps:

1. Trigger a normal UI mutation.
2. Attempt equivalent browser-origin mutation without `x-goatcitadel-browser-intent: mutation`.

Expected:

- Valid UI path succeeds.
- Missing intent header is rejected.
- Error is clear.

Result:

### SEC-03 CORS And Allowed Origins

Steps:

1. Confirm default loopback origins work.
2. Try disallowed origin.
3. Try Tailnet dev origin when enabled.
4. Try invalid configured origin value on startup.

Expected:

- Allowed origins succeed.
- Disallowed origins fail.
- Invalid origins fail loudly at startup/config time.

Result:

### SEC-04 Rate Limiting

Steps:

1. Send normal reads below limit.
2. Burst auth, mutation, and SSE paths in safe local test.

Expected:

- Rate-limit headers are present where configured.
- Auth/mutation/SSE limits differ according to bucket.
- Loopback allowlisting behaves as expected.

Result:

### SEC-05 Suspicious Encoded Path And Traversal

Steps:

1. Request normal API path.
2. Request suspicious encoded path segments.
3. Try traversal-like file/backup/restore paths.

Expected:

- Suspicious paths are rejected before handler work.
- Traversal does not reach filesystem mutation.

Result:

### SEC-06 Response Security Headers

Steps:

1. Inspect normal API response headers.
2. Inspect file/attachment preview response headers.
3. Test non-loopback bind in safe environment.

Expected:

- Baseline headers include nosniff, DENY frame, referrer policy, permissions policy, and CSP.
- Preview routes keep stricter CSP.
- HSTS appears for non-loopback bind.

Result:

### SEC-07 Route Access Classes

Steps:

1. Call public read route.
2. Call operator route without auth.
3. Call device/companion route with wrong actor.
4. Call webhook route with invalid peer/signature.

Expected:

- Access classes behave distinctly.
- Unauthorized failures are not confused with missing resource.
- Protected routes fail closed.

Result:

### SEC-08 Idempotency

Steps:

1. Repeat same mutation with same idempotency key.
2. Repeat with different body under same key if possible.
3. Repeat without key where key is required.

Expected:

- Duplicate mutation returns stable result or safe no-op.
- Key/body mismatch is rejected.
- Side effects do not duplicate.

Result:

### SEC-09 Secret Redaction

Steps:

1. Use a bad provider/channel token.
2. Inspect UI, gateway logs, diagnostics, artifacts, and event feed.

Expected:

- Secrets are not printed.
- Errors remain actionable.
- Redaction does not remove necessary non-secret context.

Result:

### SEC-10 Policy Deny-Wins

Steps:

1. Configure a permission/grant that would allow a risky action.
2. Configure deny policy for same action.
3. Attempt action.

Expected:

- Deny policy wins.
- UI explains policy block.
- Approval/grant cannot bypass deny boundary.

Result:

## Backup, Restore, Storage, And Retention

### BK-01 Backup Create, List, Verify

Steps:

1. Create backup.
2. List backups.
3. Verify backup.
4. Inspect archive path and contract truth.

Expected:

- Backup includes minimum operator set.
- Verify reports archive integrity and `contractVerified`-style truth.
- Backup path is readable and safe.

Result:

### BK-02 Live Restore Blocked

Steps:

1. Attempt live admin restore route.
2. Inspect response.

Expected:

- Live restore returns `offline_restore_required`.
- No live mutation occurs.
- CLI/offline hint is present.

Result:

### BK-03 Offline Restore

Steps:

1. Stop runtime.
2. Run offline restore command against a test backup.
3. Restart runtime.
4. Inspect restored Chat, memory, audit, config, and files.

Expected:

- Restore requires offline posture.
- Restored runtime starts cleanly.
- Backup guarantees do not exceed documented minimum set.

Result:

### BK-04 Postgres / SQLite Storage

Steps:

1. Run SQLite-backed dev stack.
2. Run Postgres-backed Docker stack.
3. Compare core flows: Chat, tasks, approvals, memory, backup verify.

Expected:

- Core state behaves the same.
- Postgres-specific failures are surfaced.
- SQLite remains supported fallback.

Result:

### BK-05 Database Cutover And Verify

Steps:

1. Run dry-run or verify flow.
2. Inspect counts/issues.
3. Abort before destructive work unless this is an explicit cutover test.

Expected:

- Output is operator-readable.
- Counts make sense.
- Risky cutover requires clear confirmation.

Result:

### BK-06 Retention And Prune

Steps:

1. Inspect retention config.
2. Update retention in test environment.
3. Run prune.
4. Inspect audit/evidence.

Expected:

- Retention changes are explicit.
- Prune affects only intended data.
- Audit remains inspectable.

Result:

## CLI, TUI, Launcher, And Admin Commands

### CLI-01 Launcher Basics

Steps:

1. Run `goatcitadel help`.
2. Run `goatcitadel status --json`.
3. Run `goatcitadel launch --no-open --json --wait`.
4. Run `goatcitadel up`.
5. Run `goatcitadel stop --json`.

Expected:

- Commands work from installed launcher.
- JSON output is parseable.
- Missing launcher gives clear install/update guidance.

Result:

### CLI-02 TUI

Steps:

1. Run `pnpm tui` or `goatcitadel tui`.
2. Inspect live feed.
3. Navigate a few views.
4. Try read-only and mutation paths.

Expected:

- TUI starts.
- Degraded SSE is surfaced.
- Mutations respect auth/policy/approval.

Result:

### CLI-03 Admin And Tools

Steps:

1. Run tools catalog.
2. Run backup list.
3. Run safe admin verification.
4. Run command with bad auth/config.

Expected:

- Output is operator-usable.
- Bad config errors are specific.
- Commands do not require browser UI.

Result:

### CLI-04 Config Sync And Update

Steps:

1. Delete or move a local `config/*.json` copy in test clone.
2. Run `pnpm config:sync`.
3. Inspect recreated file.
4. Run launcher update in installed environment if safe.

Expected:

- Templates materialize local config.
- Existing local values are not clobbered unexpectedly.
- Update repairs launcher drift.

Result:

## Cross-Cutting Edge Cases

### EDGE-01 Multi-Tab And Stale State

Steps:

1. Open two browser tabs to same workspace/session.
2. Create a message/task/approval in tab A.
3. Resolve/edit from tab B.
4. Refresh both.

Expected:

- Stale state is reconciled.
- Duplicate actions are blocked or idempotent.
- User gets clear conflict/freshness signal.

Result:

### EDGE-02 Long Input And Large Output

Steps:

1. Send a long prompt.
2. Generate long assistant output.
3. Attach a large-but-allowed file.
4. Test mobile display.

Expected:

- UI remains responsive.
- Text wraps without overlap.
- Output virtualization/windowing works.
- Large content has bounded previews.

Result:

### EDGE-03 Provider Outage And Fallback

Steps:

1. Configure unavailable provider/model.
2. Send Chat turn.
3. Restore provider or configure fallback.
4. Retry.

Expected:

- Error is readable.
- Fallback is explicit if used.
- Retry does not duplicate or corrupt turn.

Result:

### EDGE-04 Network Offline / Online

Steps:

1. Open Chat and Activity.
2. Disconnect network or block gateway locally.
3. Try read and mutation actions.
4. Restore.

Expected:

- Offline/degraded state is visible.
- Mutations do not appear successful until confirmed.
- Recovery refreshes current truth.

Result:

### EDGE-05 Workspace Switch During Work

Steps:

1. Start Chat/Cowork/Code work in workspace A.
2. Switch to workspace B mid-flow.
3. Create memory/task/note.
4. Switch back.

Expected:

- Workspace-specific state does not leak silently.
- In-progress work remains linked to original workspace.
- UI labels current workspace clearly.

Result:

### EDGE-06 Theme And Preference Persistence

Steps:

1. Toggle light/dark theme.
2. Adjust notification/sound/preferences.
3. Refresh.
4. Open mobile viewport.

Expected:

- Preferences persist.
- No route loses readability in either theme.
- Mobile preference controls remain usable.

Result:

### EDGE-07 Error Boundaries

Steps:

1. Trigger a known-safe API failure.
2. Navigate away and back.
3. Retry.

Expected:

- Error boundary is local to affected surface.
- Shell remains usable.
- Retry path works.

Result:

### EDGE-08 Performance Sanity

Steps:

1. Load a session with many messages.
2. Load task board with many items.
3. Load activity feed with many events.
4. Switch routes repeatedly.

Expected:

- No obvious freezes.
- Virtualized lists do not jump unexpectedly.
- Memory usage does not climb without release during normal navigation.

Result:

## Automated Verification Map

Use this as a bridge between manual failures and named proof lanes.

| Area | Manual sections | Useful automated lanes |
|---|---|---|
| Shell/routes | `NAV-*` | `pnpm verify:surface:regression`, `pnpm verify:visual:regression`, `pnpm verify:ui:parity` |
| Runtime truth | `OPS-*`, `DUR-*` | `pnpm verify:runtime:truth`, `pnpm verify:realtime:truth` |
| Durable runs | `COWORK-*`, `DUR-*` | `pnpm verify:durable:recovery` |
| Auth/access | `SET-*`, `SEC-*` | `pnpm verify:auth:matrix`, `pnpm verify:agentic:governance` |
| Capabilities/tools | `LIB-CAP-*`, `CODE-*`, `SET-08` | `pnpm verify:catalog:parity`, `pnpm verify:agentic:proof`, `pnpm verify:code-mode:sandbox` |
| Code hostile-sandbox claim metadata | `CODE-*`, `SEC-*` | `pnpm verify:code-mode:hostile-sandbox` |
| Memory | `LIB-MEM-*` | `pnpm verify:memory:truth` |
| Backup/restore | `BK-*` | `pnpm verify:backup:roundtrip` |
| Installer/desktop | `INST-*`, `CLI-*` | `pnpm verify:install`, `pnpm verify:desktop`, `pnpm windows:test` |
| Mesh/A2A | `A2A-*`, runtime diagnostics | `pnpm verify:mesh:readiness`, `pnpm verify:a2a:full` |
| Docs/truth | all | `pnpm docs:check`, `git diff --check` |

## Defect Report Template

```text
Bug ID:
Title:
Severity: P0 / P1 / P2 / P3
Environment:
Commit:
Route / command / endpoint:
Workspace / project / session / run / approval ID:
Steps to reproduce:
Expected:
Actual:
Evidence:
Logs:
Browser console/network:
Regression?:
Suspected owner:
Blocks release?:
Notes:
```

## Manual Pass Summary

Use this section at the end of a full manual pass.

```text
Manual QA pass name:
Date range:
Tester(s):
Commit:
Environment(s):

Total cases:
Passed:
Failed:
Blocked:
Not run:
N/A:

P0/P1 failures:
P2 failures:
P3 failures:

Automated lanes run:
Automated lanes skipped:
Known unrelated failures:

Release recommendation:
Remaining risk:
Next focused regression subset:
```

## Exit Criteria

Manual QA is good enough to sign off only when:

- all required lane cases are `Pass` or explicitly `N/A`
- no visible ship route is broken, misleading, or half-wired
- experimental routes are labeled and not counted as release-ready proof
- Chat, Cowork, and Code are distinct and usable
- approvals, durable execution, and runtime lifecycle truth stay honest under degraded/restart scenarios
- provider/model/tool/memory/cost behavior is inspectable
- risky actions remain approval/policy governed
- backup create/list/verify works and restore remains offline-only
- installer/desktop claims match the exact artifact tested
- any failures have clear owner, severity, evidence, and follow-up
