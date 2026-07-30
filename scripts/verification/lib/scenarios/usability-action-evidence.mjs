import fs from "node:fs/promises";
import path from "node:path";

const RUNNERS = Object.freeze([
  runner("mission-control-next", "@goatcitadel/mission-control-next", "apps/mission-control-next/"),
  runner("gateway", "@goatcitadel/gateway", "apps/gateway/", {
    env: { GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD: "1" },
  }),
  runner("policy-engine", "@goatcitadel/policy-engine", "packages/policy-engine/"),
  runner("mission-control-shared", "@goatcitadel/mission-control-shared", "packages/mission-control-shared/"),
  runner("threaded-surface-core", "@goatcitadel/threaded-surface-core", "packages/threaded-surface-core/"),
  runner("storage", "@goatcitadel/storage", "packages/storage/", { kind: "node-test" }),
]);

const DEDICATED_ACTION_PROOFS = Object.freeze({
  "route.chat.send-stream": dedicated(
    "usability.foundation.chat-send-stream",
    "The isolated browser leg sends an exact disposable prompt, observes exact completed output, and verifies the canonical thread.",
  ),
  "route.library-journey.experimental-label-and-safe-failure": dedicated(
    "surface-regression.library-journey",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
  "route.library-curator.experimental-label-and-safe-failure": dedicated(
    "surface-regression.library-curator",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
  "route.ops-improvement.experimental-label-and-safe-failure": dedicated(
    "surface-regression.ops-improvement",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
  "route.ops-kanban.experimental-label-and-safe-failure": dedicated(
    "surface-regression.ops-kanban",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
  "route.settings-personalities.experimental-label-and-safe-failure": dedicated(
    "surface-regression.settings-personalities",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
  "route.settings-addons.experimental-label-and-safe-failure": dedicated(
    "surface-regression.settings-addons",
    "The route-specific browser scenario asserts its unique Experimental badge and a safe route-owned 503 state.",
  ),
});

const ACTION_ASSERTIONS = Object.freeze({
  "route.chat.stop-and-retry": [
    a(
      "apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx",
      "uses blocker, sending, and stream-stop labels for primary actions",
    ),
    a(
      "apps/gateway/src/routes/chat.messages.loop28.test.ts",
      "replays session-selected provider preferences before retrying a turn",
    ),
  ],
  "route.chat.edit-and-branch": [
    a("apps/gateway/src/routes/chat.messages.loop28.test.ts", "replays manual selections before editing a turn"),
    a("apps/gateway/src/routes/chat.routes.test.ts", "streams branch-aware chat message chunks over SSE"),
  ],
  "route.chat.attachments-citations-tools": [
    a(
      "apps/gateway/src/routes/chat.attachments.loop16.test.ts",
      "validates uploads and delegates successful attachment creation",
    ),
    a(
      "apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.test.tsx",
      "renders citations as source cards and exposes stream status through aria-live",
    ),
    a(
      "apps/gateway/src/routes/chat.tools.test.ts",
      "serves chat tool artifacts and reports validation or service errors",
    ),
  ],
  "route.chat.planning-delegation-synthesis": [
    a(
      "apps/mission-control-next/src/features/threaded-surface/ThreadedContextDrawer.test.tsx",
      "lets users toggle planning mode from the context panel",
    ),
    a(
      "apps/gateway/src/routes/chat.delegate.test.ts",
      "runs, fetches, suggests, and accepts delegation through the service facade",
    ),
    a(
      "apps/gateway/src/orchestration/engine.test.ts",
      "waits for every parallel stage handoff before starting the downstream synthesis stage",
    ),
  ],
  "route.chat.approval-and-user-input-resume": [
    a(
      "apps/gateway/src/services/approval-lifecycle-service.test.ts",
      "resumes an approval-blocked chat turn end to end and keeps duplicate wake processing idempotent",
    ),
    a(
      "packages/mission-control-shared/src/components/chat/chat-renderer-tail.test.tsx",
      "submits and dismisses pending user input prompts",
    ),
  ],
  "route.chat.durable-restart-resume": [
    a(
      "apps/gateway/src/services/chat-turn-interruption-recovery-service.test.ts",
      "restores message_done only when its durable owner committed the same terminal output",
    ),
    a(
      "apps/gateway/src/services/chat-proactive-service.test.ts",
      "resumes approval-blocked proactive durable runs from checkpoint without rerunning completed actions",
    ),
  ],
  "route.chat.code-mode-artifacts": [
    a(
      "apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.test.tsx",
      "keeps execution, artifact integrity, and named semantic proof distinct",
    ),
    a("apps/gateway/src/routes/capabilities.test.ts", "reads verified Code Mode artifacts and compares scoped runs"),
  ],
  "route.projects.workspace-project-crud": [
    a(
      "apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.test.tsx",
      "creates, updates, archives, and routes project continuation actions",
    ),
  ],
  "route.projects.revision-conflict": [
    a(
      "apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.test.tsx",
      "preserves a project draft, reloads the current revision, and retries after a 409",
    ),
  ],
  "route.library-agents.agent-crud": [
    a(
      "apps/gateway/src/routes/agents.test.ts",
      "creates, updates, archives, restores, and hard-deletes agent profiles",
    ),
  ],
  "route.library-agents.agent-default-tool-profile": [
    a(
      "apps/mission-control-next/src/features/native-routes/NativeRoutePages.coverage.test.tsx",
      "covers agent profile maintenance and route dispatch fallbacks",
    ),
  ],
  "route.library-skills.skill-inspect-activate-deactivate": [
    a(
      "apps/mission-control-next/src/features/native-routes/NativeRoutePages.coverage.test.tsx",
      "covers skills, capability browsing, knowledge, files, and artifacts",
    ),
  ],
  "route.library-skills.skill-provenance": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/SkillHubOperatorPanel.test.tsx",
      "renders review-only truth, every lifecycle action, version-byte drift, audit floor, and permission diff",
    ),
  ],
  "route.library-capabilities.inspectable-callable-catalogs": [
    a(
      "apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.test.tsx",
      "summarizes frozen callable and inspect-only catalog evidence",
    ),
  ],
  "route.library-capabilities.candidate-proposal-lifecycle": [
    a(
      "apps/gateway/src/services/capability-system-service.test.ts",
      "returns candidate and proposal detail and supports promotion, rollback, and revoke",
    ),
  ],
  "route.library-memory.memory-edit-pin-forget-history": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.test.tsx",
      "wires memory item edits, maintenance policy controls, recommendation actions, and run selection",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.batchSelection.test.tsx",
      "pins selected items",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.test.tsx",
      "gates memory forget behind a confirmation modal and never forgets without confirm (5.2)",
    ),
    a(
      "apps/gateway/src/services/document-editing-service.test.ts",
      "applies note proposals through optimistic revisions and immutable history",
    ),
  ],
  "route.library-memory.memory-scope-and-provenance": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.test.tsx",
      "reads memory provenance and evidence metadata defensively",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.namespaceFilter.test.tsx",
      "filters memory items when a namespace pill is activated",
    ),
  ],
  "route.library-journey.journey-event-detail": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/JourneyTimelineRoutePage.test.tsx",
      "renders inspectable blocked evidence with no mutation controls",
    ),
  ],
  "route.library-knowledge.external-source-register-scan-import": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/LibraryExternalSourcesSection.test.tsx",
      "walks the register → scan → dry-run → apply flow over the typed client",
    ),
  ],
  "route.library-knowledge.chat-attach-and-governed-copy": [
    a(
      "apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx",
      "routes detach and governed knowledge-copy actions to the host controls",
    ),
    a(
      "apps/gateway/src/routes/external-sources.test.ts",
      "serves the durable chat attachment reload, attach, and CAS detach with the exact C3 client paths and bodies",
    ),
  ],
  "route.library-notes.note-crud-and-conflict": [
    a("apps/gateway/src/routes/personal-ops.test.ts", "lists, updates, and archives notes by workspace"),
    a(
      "apps/gateway/src/services/document-editing-service.test.ts",
      "retains a stale proposal as conflicted instead of overwriting the note",
    ),
  ],
  "route.library-files.file-list-upload-download": [
    a(
      "apps/gateway/src/routes/files.coverage.test.ts",
      "lists templates, creates template files, lists files, suggests paths, and uploads content",
    ),
    a(
      "apps/gateway/src/routes/files.coverage.test.ts",
      "returns binary downloads as base64 metadata and raw downloads with source content type",
    ),
  ],
  "route.library-artifacts.artifact-list-detail-download": [
    a(
      "apps/gateway/src/services/chat-generated-artifact-service.vitest.test.ts",
      "lists visible artifacts, validates session ownership, and attaches thread references",
    ),
    a(
      "apps/gateway/src/services/chat-tool-artifact-service.test.ts",
      "loads artifact content only for the owning workspace inside the data root",
    ),
  ],
  "route.library-prompt-packs.author-edit": [
    a(
      "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.test.tsx",
      "surfaces prompt-pack mutation failures and import guards",
    ),
  ],
  "route.library-prompt-packs.run-selected-and-all": [
    a(
      "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.test.tsx",
      "keeps pack-wide run controls in a stable command strip",
    ),
    a(
      "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.test.tsx",
      "covers failed run, auto-score, export, terminal benchmark, and keyboard selection branches",
    ),
  ],
  "route.library-prompt-packs.compare-review-export": [
    a(
      "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.test.tsx",
      "drives the prompt-pack workbench through run, review, ops, reset, import, and refresh flows",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/NativeRoutePages.odysseus.test.tsx",
      "renders model comparisons under prompt packs and saves a judgment",
    ),
  ],
  "route.library-curator.curator-inspection": [
    a(
      "apps/mission-control-next/src/features/native-routes/library/CuratorRoutePage.test.tsx",
      "renders proposal-only actions and immunity badges",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/library/CuratorRoutePage.test.tsx",
      "generates curator reports with dryRun: true",
    ),
  ],
  "route.library-citadel.citadel-create-and-isolation": [
    a("apps/gateway/src/routes/citadels.test.ts", "creates a citadel from a template"),
    a("packages/storage/src/citadel-repo.test.ts", "creates chambers and lists them scoped to a citadel"),
  ],
  "route.library-citadel-overview.citadel-charter-lifecycle": [
    a("apps/gateway/src/routes/citadels.test.ts", "creates, updates, archives, and restores Citadel identity records"),
    a("apps/gateway/src/routes/citadels.test.ts", "upserts a charter scoped to the citadel id from the path"),
  ],
  "route.library-citadel-wards.ward-create-delete-and-evaluate": [
    a("apps/gateway/src/routes/citadels.test.ts", "lists and creates wards for a citadel"),
    a("packages/storage/src/citadel-repo.test.ts", "adds, lists, and removes wards scoped to a citadel"),
    a("apps/gateway/src/routes/citadels.test.ts", "evaluates an action against the citadel's wards"),
  ],
  "route.library-citadel-council.council-seat-and-remove": [
    a(
      "packages/storage/src/citadel-repo.test.ts",
      "assigns existing agents to a citadel council idempotently and unassigns them",
    ),
  ],
  "route.library-citadel-blueprint.blueprint-edit-export": [
    a("apps/gateway/src/routes/citadels.test.ts", "exports a blueprint for an existing citadel"),
    a("apps/gateway/src/routes/citadels.test.ts", "imports a valid blueprint"),
  ],
  "route.library-citadel-vault.vault-secret-status-and-governance": [
    a(
      "packages/storage/src/citadel-repo.test.ts",
      "stores, lists (metadata only), reveals, and deletes vault secrets scoped to a citadel",
    ),
  ],
  "route.ops-boards.board-crud-and-widgets": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.test.tsx",
      "wires /ops/boards to exactly five compiled, independently sourced widgets",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.test.tsx",
      "selects, creates, archives, and restores through canonical reloads",
    ),
  ],
  "route.ops-activity.activity-filter-and-detail": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.test.tsx",
      "filters the activity feed by error, approval, and runtime signals",
    ),
  ],
  "route.ops-activity.realtime-reconnect": [
    a(
      "packages/mission-control-shared/src/api/client-event-stream.test.ts",
      "connects once, forwards events, persists cursors, handles replay gaps, reconnects, and cleans up",
    ),
  ],
  "route.ops-sessions.session-list-detail-control": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/SessionControlPanel.test.tsx",
      "renders a pending request with hand off and rejects raw JSON / secrets",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/ops/SessionControlPanel.test.tsx",
      "exposes revoke and emergency takeover for the current external controller",
    ),
  ],
  "route.ops-schedules.schedule-create-list-cancel-and-run": [
    a(
      "apps/gateway/src/services/gateway/schedule-tool-cron-integration.test.ts",
      "create persists an agent_turn job with the creator profile, then list + cancel round-trip",
    ),
    a(
      "apps/gateway/src/services/gateway/cron-automation-service.test.ts",
      "runs curator as a scheduled cron action and records its run window",
    ),
  ],
  "route.ops-improvement.improvement-review": [
    a(
      "apps/gateway/src/services/improvement-service.loop19.test.ts",
      "keeps proposal and curator lifecycle actions review-first",
    ),
  ],
  "route.ops-notifications.notification-target-rule-crud": [
    a(
      "apps/gateway/src/routes/notifications.test.ts",
      "wires revisioned target/rule CRUD, presence, tests, and delivery truth",
    ),
  ],
  "route.ops-notifications.notification-test-and-operator-policy": [
    a(
      "apps/gateway/src/routes/route-access.test.ts",
      "classifies every notification route as operator-only and rejects non-operator principals",
    ),
  ],
  "route.ops-approvals.approval-approve-deny": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx",
      "drives view switching, queue selection, decisions, recovery, trace, live lane, and bulk rejection",
    ),
  ],
  "route.ops-approvals.approval-resume-canonical-run": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx",
      "requires durable status inspection before resuming a paused approval run",
    ),
  ],
  "route.ops-costs.cost-filter-and-budget-truth": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.test.tsx",
      "aggregates provider spend across days and preserves incomplete cost evidence",
    ),
    a(
      "apps/gateway/src/services/continuation-gate-service.test.ts",
      "throttles on cost budget exhaustion and otherwise returns a normalized continue decision",
    ),
  ],
  "route.ops-quality.quality-evidence-and-status": [
    a(
      "apps/gateway/src/services/dashboard-route-service.test.ts",
      "projects blocking and advisory design-quality evidence into the Ops quality snapshot",
    ),
  ],
  "route.ops-runtime.runtime-health-and-owner-truth": [
    a(
      "apps/gateway/src/services/runtime-authority-projection-service.test.ts",
      "keeps local runtime health, config recovery, and release identity classifications separate and secret-free",
    ),
  ],
  "route.ops-runtime.restart-recovery": [
    a(
      "apps/gateway/src/services/llama-cpp-runtime-service.loop31.test.ts",
      "covers closed health waits, restart-budget exhaustion, and restart scheduling guards",
    ),
  ],
  "route.ops-diagnostics.diagnostic-list-detail-export": [
    a("apps/gateway/src/routes/dev-diagnostics.test.ts", "lists diagnostics with forwarded filters"),
    a(
      "apps/gateway/src/dev-diagnostics/service.test.ts",
      "supports a lightweight exporter boundary without blocking local diagnostics",
    ),
  ],
  "route.ops-diagnostics.backup-recovery-entry": [
    a(
      "apps/gateway/src/services/backup-retention-service.test.ts",
      "creates, lists, verifies, and restores a SQLite backup with contract coverage",
    ),
    a(
      "apps/gateway/src/routes/admin.test.ts",
      "blocks live backup restore and points operators to the offline CLI path",
    ),
  ],
  "route.ops-kanban.task-board-lifecycle": [
    a(
      "apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx",
      "fires bulkTaskAction with workspace scope when the operator clicks Unblock with selections",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx",
      "refreshes canonical tasks on an actual 409 and requires an explicit retry with the new revision",
    ),
  ],
  "route.settings-general.interface-preferences-persist-across-reload": [
    a(
      "packages/mission-control-shared/src/state/ui-preferences.test.tsx",
      "persists every setter and derives technical details from experience mode",
    ),
    a(
      "packages/mission-control-shared/src/state/ui-preferences.test.tsx",
      "loads valid stored preferences and normalizes invalid Citadel and workspace ids",
    ),
  ],
  "route.settings-onboarding.onboarding-complete-and-revisit": [
    a("apps/gateway/src/routes/onboarding.test.ts", "marks onboarding complete"),
    a("apps/gateway/src/routes/onboarding.test.ts", "returns onboarding state"),
  ],
  "route.settings-providers.provider-activate-model-select": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "activates a connected ChatGPT provider with one explicit action",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "shows truthful empty routing controls and populates models after a provider is chosen",
    ),
  ],
  "route.settings-providers.oauth-status-and-invalid-credential": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "surfaces invalid and expired ChatGPT OAuth pairing branches",
    ),
  ],
  "route.settings-personalities.personality-inspection": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "covers personality validation, locked rows, clear-default, and remove failure branches",
    ),
  ],
  "route.settings-access.token-basic-device-grants": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "saves edited access credentials, resolves install tokens, and revokes device grants",
    ),
  ],
  "route.settings-access.revoked-and-persisted-credentials": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "prefers a valid session OAuth flow over stale local storage",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "shows and can disconnect an orphan ChatGPT OAuth credential",
    ),
  ],
  "route.settings-permissions.permission-profile-crud": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "edits and archives custom permission profiles",
    ),
  ],
  "route.settings-permissions.deny-wins-preview": [
    a("packages/policy-engine/src/policy-resolver.test.ts", "applies deny-wins across base and agent overrides"),
  ],
  "route.settings-runtime.runtime-settings-update-and-conflict": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
      "preserves the llama.cpp draft and retries with the refreshed settings revision after a 409",
    ),
  ],
  "route.settings-local-ai.hardware-readiness-and-not-configured-reason": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
      "renders the local AI section when the readiness payload is empty",
    ),
  ],
  "route.settings-workspaces.workspace-create-select-archive-restore": [
    a("apps/gateway/src/routes/workspaces.test.ts", "creates, reads, updates, archives, and restores workspaces"),
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
      "guards both Citadel and workspace editor selection without discarding on cancel",
    ),
  ],
  "route.settings-workspaces.workspace-isolation": [
    a(
      "packages/storage/src/chat-message-repo.search.test.ts",
      "searchMessages never crosses workspace boundaries and excludes hidden sessions by default",
    ),
  ],
  "route.settings-budget.budget-mode-update-and-conflict": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "disables duplicate budget saves while the update is in flight",
    ),
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "preserves the local budget draft when a stale revision is rejected",
    ),
  ],
  "route.settings-addons.addon-inspection": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
      "renders the add-ons section when catalog and pack payloads are empty",
    ),
  ],
  "route.settings-integrations.integration-validation-and-diagnostics": [
    a(
      "apps/gateway/src/routes/integrations.control.test.ts",
      "runs connector diagnostics through the integration diagnostics route",
    ),
    a(
      "apps/gateway/src/routes/integration-control-loop21.test.ts",
      "delegates integration control routes and maps validation, not-found, and conflict errors",
    ),
  ],
  "route.settings-integrations.sandbox-destination": [
    a(
      "apps/gateway/src/services/channel-bot-live-probes.test.ts",
      "surfaces missing sandbox destinations before destructive channel sends",
    ),
  ],
  "route.settings-channels.channel-validation-and-diagnostics": [
    a(
      "apps/gateway/src/services/channel-setup-service.contract.test.ts",
      "blocks live testing for invalid drafts without probing connectors",
    ),
    a("apps/gateway/src/routes/comms.test.ts", "proxies channel diagnostics through the comms route"),
  ],
  "route.settings-channels.sandbox-destination": [
    a(
      "apps/gateway/src/services/channel-bot-live-probes.ntfy.test.ts",
      "does not publish for non-destructive or configured dry-run diagnostics",
    ),
  ],
  "route.settings-mcp.mcp-server-tool-grant-lifecycle": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
      "covers MCP create, edit, runtime actions, diagnostics, and delete branches",
    ),
  ],
  "route.settings-mcp.unsupported-transport-truth": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "surfaces governed remote MCP runtime support without exposing transport creation controls",
    ),
  ],
  "route.settings-tools.tool-catalog-and-grants": [
    a(
      "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
      "submits TTL grants with an explicit expiry",
    ),
    a(
      "packages/policy-engine/src/engine.test.ts",
      "passes grant list, create, and revoke operations through to storage",
    ),
  ],
  "route.settings-tools.approval-and-policy-boundary": [
    a(
      "apps/gateway/src/services/tool-invocation-coordinator-service.test.ts",
      "records approval-required policy tool outcomes as retained evidence",
    ),
  ],
  "route.library-communications.communication-list-and-agenda": [
    a(
      "apps/gateway/src/routes/communications.test.ts",
      "uses a disabled uncredentialed fixture only in dev verification without provider calls",
    ),
    a(
      "apps/gateway/src/routes/communications.test.ts",
      "returns dashboard summaries without leaking raw connection secrets",
    ),
  ],
  "route.library-communications.approval-gated-draft-no-send": [
    a(
      "apps/mission-control-next/src/features/native-routes/NativeRoutePages.odysseus.test.tsx",
      "renders communications and creates a governed mail draft",
    ),
    a(
      "apps/gateway/src/routes/communications.test.ts",
      "creates drafts and returns approval-required send placeholders",
    ),
  ],
  "route.settings-trust-policy.trust-policy-inspection-and-owner-handoff": [
    a(
      "apps/mission-control-next/src/features/native-routes/settings/sections/TrustPolicySection.test.tsx",
      "renders owner actions for trust rows without mutating policy",
    ),
  ],
});

const INTENTIONAL_GAPS = Object.freeze({});

export function actionProofBindingsFor(stepId) {
  const dedicatedProof = DEDICATED_ACTION_PROOFS[stepId];
  if (dedicatedProof) return [dedicatedProof];
  const assertions = ACTION_ASSERTIONS[stepId];
  if (assertions) {
    return assertions.map((assertion) => ({
      mode: "action-assertion",
      scenarioIds: [runnerForFile(assertion.file).scenarioId],
      assertionIds: [assertion.assertionId],
      assertionFile: assertion.file,
      assertionTitle: assertion.title,
      requireArtifacts: true,
      contract: assertion.contract,
    }));
  }
  const gap = INTENTIONAL_GAPS[stepId];
  return [
    {
      mode: "missing-action-proof",
      scenarioIds: [],
      assertionIds: [],
      requireArtifacts: false,
      contract: gap?.needed ?? "No exact action assertion is registered.",
      ownerRefs: gap?.ownerRefs ?? [],
    },
  ];
}

export function validateActionProofContract(requiredActionStepIds) {
  const expected = new Set(requiredActionStepIds);
  const registered = new Set([...Object.keys(ACTION_ASSERTIONS), ...Object.keys(DEDICATED_ACTION_PROOFS)]);
  const gaps = new Set(Object.keys(INTENTIONAL_GAPS));
  const stale = [...registered, ...gaps].filter((stepId) => !expected.has(stepId));
  const unclassified = [...expected].filter((stepId) => !registered.has(stepId) && !gaps.has(stepId));
  if (stale.length > 0 || unclassified.length > 0) {
    throw new Error(
      `usability action proof contract drifted (stale=${stale.join(",")}; unclassified=${unclassified.join(",")})`,
    );
  }

  const seenAssertions = new Map();
  for (const [stepId, assertions] of Object.entries(ACTION_ASSERTIONS)) {
    if (!Array.isArray(assertions) || assertions.length === 0) throw new Error(`${stepId} has no action assertions`);
    for (const assertion of assertions) {
      const prior = seenAssertions.get(assertion.assertionId);
      if (prior) throw new Error(`duplicate usability action proof ${assertion.assertionId} (${prior}, ${stepId})`);
      seenAssertions.set(assertion.assertionId, stepId);
      runnerForFile(assertion.file);
    }
  }
  return {
    registeredActions: registered.size,
    gapActions: [...gaps].sort(),
    assertionCount: seenAssertions.size,
  };
}

export function listActionProofGaps() {
  return Object.entries(INTENTIONAL_GAPS).map(([stepId, value]) => ({ stepId, ...value }));
}

export async function runUsabilityActionProofScenarios(context, { baseSha, deps, secretEnvKeys = [] }) {
  const allAssertions = Object.entries(ACTION_ASSERTIONS).flatMap(([stepId, assertions]) =>
    assertions.map((assertion) => ({ ...assertion, stepId })),
  );
  for (const runnerConfig of RUNNERS) {
    const assertions = allAssertions.filter((assertion) => runnerForFile(assertion.file).id === runnerConfig.id);
    if (assertions.length === 0) continue;
    await deps.runScenario(
      context,
      {
        id: runnerConfig.scenarioId,
        lane: "usability",
        title: `Exact action assertions (${runnerConfig.packageName})`,
        subsystem: "usability-action-evidence",
      },
      async () => await runActionProofGroup(context, { assertions, baseSha, deps, runnerConfig, secretEnvKeys }),
    );
  }
}

export function normalizeVitestActionReport(rawReport, assertions, baseSha, repoRoot) {
  const reporterRows = (rawReport?.testResults ?? []).flatMap((testResult) => {
    const file = normalizeReporterFile(testResult?.name, repoRoot);
    return (testResult?.assertionResults ?? []).map((assertion) => ({
      file,
      title: assertion?.title,
      status: assertion?.status,
      fullName: assertion?.fullName,
      failureMessages: assertion?.failureMessages ?? [],
    }));
  });
  const assertionResults = normalizeActionRows(reporterRows, assertions);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    runnerSuccess: rawReport?.success === true,
    assertionResults,
  };
}

function normalizeActionRows(reporterRows, assertions) {
  return assertions.map((assertion) => {
    const matches = reporterRows.filter(
      (row) => row.file === assertion.file && row.title === assertion.title && row.status !== "skipped",
    );
    return {
      assertionId: assertion.assertionId,
      stepId: assertion.stepId,
      file: assertion.file,
      title: assertion.title,
      contract: assertion.contract,
      status: matches.length === 1 && matches[0].status === "passed" ? "passed" : "failed",
      occurrences: matches.length,
      runnerStatus: matches.length === 1 ? matches[0].status : matches.length === 0 ? "missing" : "duplicate",
      failureMessages: matches.flatMap((row) => row.failureMessages),
    };
  });
}

export function normalizeNodeJunitActionReport(junit, assertions, baseSha, repoRoot, options = {}) {
  const commandOwnedFile = resolveNodeTestCommandOwnedFile(assertions, repoRoot, options.commandOwnedFile);
  const reporterRows = [];
  const testcasePattern = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
  for (const match of String(junit ?? "").matchAll(testcasePattern)) {
    const attributes = parseXmlAttributes(match[1]);
    const body = match[2] ?? "";
    reporterRows.push({
      file: attributes.file ? normalizeReporterFile(attributes.file, repoRoot) : commandOwnedFile,
      title: attributes.name,
      status: /<(?:failure|error)\b/iu.test(body) ? "failed" : /<skipped\b/iu.test(body) ? "skipped" : "passed",
      failureMessages: body ? [body] : [],
    });
  }
  const assertionResults = normalizeActionRows(reporterRows, assertions);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    runnerSuccess: /<!--\s*fail\s+0\s*-->/u.test(String(junit ?? "")) && reporterRows.length > 0,
    assertionResults,
  };
}

function runner(id, packageName, filePrefix, options = {}) {
  return Object.freeze({
    id,
    packageName,
    filePrefix,
    env: options.env ?? {},
    kind: options.kind ?? "vitest",
    scenarioId: `usability.action-proofs.${id}`,
  });
}

function a(file, title, contract = title) {
  return Object.freeze({ assertionId: `${file}::${title}`, file, title, contract });
}

function dedicated(scenarioId, contract) {
  return Object.freeze({ mode: "dedicated-scenario", scenarioIds: [scenarioId], requireArtifacts: true, contract });
}

function runnerForFile(file) {
  const match = RUNNERS.find((runnerConfig) => file.startsWith(runnerConfig.filePrefix));
  if (!match) throw new Error(`no usability action proof runner owns ${file}`);
  return match;
}

async function runActionProofGroup(context, { assertions, baseSha, deps, runnerConfig, secretEnvKeys }) {
  const rawPath = path.join(
    context.artifactRoot,
    "diagnostics",
    `usability-action-proofs-${runnerConfig.id}.vitest.json`,
  );
  const normalizedPath = path.join(
    context.artifactRoot,
    "diagnostics",
    `usability-action-proofs-${runnerConfig.id}.json`,
  );
  let rawReport;
  let normalized;
  let commandRuns;
  if (runnerConfig.kind === "node-test") {
    commandRuns = [];
    const assertionGroups = groupAssertionsByFile(assertions);
    for (const [index, group] of assertionGroups.entries()) {
      const titlePattern = buildTitlePattern(group.assertions);
      const packageFile = group.file.slice(runnerConfig.filePrefix.length);
      const result = await deps.runCommand(
        deps.pnpmCommand(),
        [
          "--filter",
          runnerConfig.packageName,
          "exec",
          "tsx",
          "--test",
          `--test-name-pattern=${titlePattern}`,
          "--test-reporter=junit",
          packageFile,
        ],
        {
          cwd: deps.repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: `usability-action-proofs-${runnerConfig.id}-${String(index + 1).padStart(2, "0")}-${sanitizeLogPart(
            path.basename(group.file),
          )}`,
          env: runnerConfig.env,
          omitEnv: secretEnvKeys,
        },
      );
      commandRuns.push({
        file: group.file,
        result,
        normalized: normalizeNodeJunitActionReport(result.stdout, group.assertions, baseSha, deps.repoRoot, {
          commandOwnedFile: group.file,
        }),
      });
    }
    normalized = aggregateNodeJunitActionReports(commandRuns, assertions, baseSha);
    rawReport = {
      success:
        commandRuns.length > 0 && commandRuns.every((run) => run.result.code === 0 && run.normalized.runnerSuccess),
    };
  } else {
    const files = [...new Set(assertions.map((assertion) => assertion.file.slice(runnerConfig.filePrefix.length)))];
    const titlePattern = buildTitlePattern(assertions);
    const result = await deps.runCommand(
      deps.pnpmCommand(),
      [
        "--filter",
        runnerConfig.packageName,
        "exec",
        "vitest",
        "run",
        ...files,
        "--testNamePattern",
        titlePattern,
        "--reporter=json",
        `--outputFile=${rawPath}`,
        "--maxWorkers=4",
      ],
      {
        cwd: deps.repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: `usability-action-proofs-${runnerConfig.id}`,
        env: runnerConfig.env,
        omitEnv: secretEnvKeys,
      },
    );
    commandRuns = [{ result }];
    try {
      rawReport = JSON.parse(await fs.readFile(rawPath, "utf8"));
    } catch (error) {
      rawReport = { success: false, reportReadError: error instanceof Error ? error.message : String(error) };
    }
    normalized = normalizeVitestActionReport(rawReport, assertions, baseSha, deps.repoRoot);
  }
  await deps.writeJson(normalizedPath, normalized);
  const failed = normalized.assertionResults.filter((row) => row.status !== "passed");
  const failedCommands = commandRuns.filter((run) => run.result.code !== 0);
  return {
    status: failedCommands.length === 0 && rawReport.success === true && failed.length === 0 ? "passed" : "failed",
    error:
      failedCommands.length > 0
        ? `exact action assertion runner exited nonzero for ${failedCommands.map((run) => run.file ?? runnerConfig.id).join(", ")}`
        : failed.length > 0
          ? `missing, duplicate, or failing action assertions: ${failed.map((row) => row.assertionId).join(", ")}`
          : rawReport.success === true
            ? undefined
            : `${runnerConfig.kind === "node-test" ? "node:test" : "Vitest"} action assertion report did not declare success`,
    metrics: {
      baseSha,
      expectedAssertions: normalized.assertionResults.length,
      passedAssertions: normalized.assertionResults.length - failed.length,
      actionAssertions: normalized.assertionResults,
    },
    artifacts: {
      diagnostics: [
        ...(runnerConfig.kind === "node-test" ? [] : [deps.relativeToRun(context, rawPath)]),
        deps.relativeToRun(context, normalizedPath),
      ],
      screenshots: [],
      traces: [],
      logs: commandRuns.flatMap(({ result }) => [
        deps.relativeToRun(context, result.stdoutPath),
        deps.relativeToRun(context, result.stderrPath),
      ]),
      perf: [],
      playwright: [],
    },
  };
}

function groupAssertionsByFile(assertions) {
  const groups = new Map();
  for (const assertion of assertions) {
    const group = groups.get(assertion.file) ?? [];
    group.push(assertion);
    groups.set(assertion.file, group);
  }
  return [...groups.entries()].map(([file, groupedAssertions]) => ({ file, assertions: groupedAssertions }));
}

function buildTitlePattern(assertions) {
  return `(?:${[...new Set(assertions.map((assertion) => escapeRegExp(assertion.title)))].join("|")})$`;
}

function aggregateNodeJunitActionReports(commandRuns, assertions, baseSha) {
  const rows = commandRuns.flatMap((run) => run.normalized.assertionResults);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    runnerSuccess:
      commandRuns.length > 0 && commandRuns.every((run) => run.result.code === 0 && run.normalized.runnerSuccess),
    assertionResults: assertions.map((assertion) => {
      const matches = rows.filter((row) => row.assertionId === assertion.assertionId);
      if (matches.length === 1) return matches[0];
      return {
        assertionId: assertion.assertionId,
        stepId: assertion.stepId,
        file: assertion.file,
        title: assertion.title,
        contract: assertion.contract,
        status: "failed",
        occurrences: matches.reduce((total, row) => total + row.occurrences, 0),
        runnerStatus: matches.length === 0 ? "missing" : "duplicate",
        failureMessages: matches.flatMap((row) => row.failureMessages),
      };
    }),
  };
}

function resolveNodeTestCommandOwnedFile(assertions, repoRoot, commandOwnedFile) {
  if (commandOwnedFile === undefined) return "";
  if (typeof commandOwnedFile !== "string" || commandOwnedFile.trim().length === 0) {
    throw new Error("node:test JUnit fallback requires one non-empty command-owned source file");
  }
  const normalizedCommandFile = normalizeCommandOwnedFile(commandOwnedFile, repoRoot);
  const assertionFiles = new Set(assertions.map((assertion) => assertion.file));
  if (assertionFiles.size !== 1 || !assertionFiles.has(normalizedCommandFile)) {
    throw new Error(
      `node:test JUnit fallback is ambiguous: command owns ${normalizedCommandFile}, assertions own ${[...assertionFiles].join(",")}`,
    );
  }
  return normalizedCommandFile;
}

function normalizeCommandOwnedFile(value, repoRoot) {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
  return path.relative(repoRoot, absolute).replaceAll("\\", "/");
}

function sanitizeLogPart(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function normalizeReporterFile(value, repoRoot) {
  if (typeof value !== "string") return "";
  return path.relative(repoRoot, path.resolve(value)).replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseXmlAttributes(value) {
  const attributes = {};
  for (const match of String(value).matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/gu)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  return attributes;
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
