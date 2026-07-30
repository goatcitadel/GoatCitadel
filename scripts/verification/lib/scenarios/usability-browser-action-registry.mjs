const DEDICATED_BROWSER_PROOFS = Object.freeze({
  "route.chat.send-stream": dedicated(
    "usability.foundation.chat-send-stream",
    "The isolated Chromium foundation sends an exact disposable prompt, observes exact completed output, and verifies the canonical thread.",
  ),
  "route.library-journey.experimental-label-and-safe-failure": dedicated(
    "surface-regression.library-journey",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
  "route.library-curator.experimental-label-and-safe-failure": dedicated(
    "surface-regression.library-curator",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
  "route.ops-improvement.experimental-label-and-safe-failure": dedicated(
    "surface-regression.ops-improvement",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
  "route.ops-kanban.experimental-label-and-safe-failure": dedicated(
    "surface-regression.ops-kanban",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
  "route.settings-personalities.experimental-label-and-safe-failure": dedicated(
    "surface-regression.settings-personalities",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
  "route.settings-addons.experimental-label-and-safe-failure": dedicated(
    "surface-regression.settings-addons",
    "The route-specific Chromium scenario asserts its unique Experimental badge and safe route-owned failure state.",
  ),
});

const SUPPLEMENTAL_ACTION_PROOFS = Object.freeze({
  "route.chat.durable-restart-resume": dedicated(
    "runtime-truth.approval-restart-durable-truth",
    "The named runtime-truth owner restarts its isolated Gateway and resumes the same approval-blocked durable Chat run through canonical state before browser-visible detach and reattach controls are accepted as complete.",
  ),
  "route.ops-activity.realtime-reconnect": dedicated(
    "realtime-truth.disconnect-reconnect-resubscribe",
    "The named realtime-truth owner disconnects the isolated Gateway event stream, reconnects, resubscribes from the retained cursor, and proves fresh post-reconnect activity without duplicate delivery.",
  ),
  "route.ops-runtime.restart-recovery": dedicated(
    "runtime-truth.approval-restart-durable-truth",
    "The named runtime-truth owner stops and restarts only its isolated SQLite Gateway process, waits for the same loopback endpoint to become healthy, and resumes the same durable run through canonical APIs.",
  ),
  "route.ops-diagnostics.backup-recovery-entry": dedicated(
    "backup-roundtrip.runtime.config-restore",
    "The named backup-roundtrip owner creates and verifies through the live admin API, stops only its isolated Gateway before the supported offline CLI restore, restarts it, and verifies the minimum recoverable set.",
  ),
  "route.settings-access.token-basic-device-grants": dedicated(
    "auth-matrix.basic-restart-device-revocation",
    "The named auth-matrix owner proves token, Basic, and device credentials across an isolated Gateway restart, including exact operator access and non-operator denial.",
  ),
  "route.settings-access.revoked-and-persisted-credentials": dedicated(
    "auth-matrix.basic-restart-device-revocation",
    "The named auth-matrix owner proves persisted Basic/device credentials survive the isolated restart while revoked credentials remain denied.",
  ),
});

const TERMINAL_EVIDENCE_KINDS = new Set([
  "api",
  "assert-checked",
  "assert-control",
  "assert-image-loaded",
  "assert-table-text",
  "assert-test-id-text",
  "assert-text",
  "assert-text-absent",
  "assert-text-pattern",
  "assert-value",
  "download",
]);

// There are intentionally no active exemptions. If a browser action ever
// cannot expose a terminal UI or canonical API readback, its exact step ID and
// reviewed reason must be added here; arbitrary per-step reasons fail closed.
const APPROVED_TERMINAL_EVIDENCE_EXEMPTIONS = Object.freeze({});
const DOWNLOAD_CONTROL_PATTERN = /(?:\bdownload\b|^Export diagnostics$)/iu;
const APPROVED_DOWNLOAD_CONTENT_CONTRACTS = new Set(["citadel-blueprint-v1", "ops-diagnostics-v1"]);
const MAX_OPERATION_TIMEOUT_MS = 120_000;

export const EXPECTED_BROWSER_ACTION_BUNDLE_COUNTS = Object.freeze({
  "chat-lifecycle": 3,
  "chat-agentic-durable-code": 4,
  "projects-workspaces": 4,
  "library-catalog-memory": 10,
  "library-content": 10,
  citadel: 6,
  "ops-work": 6,
  "ops-governance-reliability": 11,
  "settings-core-auth-provider": 8,
  "settings-governance-runtime-integrations": 14,
});

const STEPS = [
  step("chat-lifecycle", "route.chat.stop-and-retry", "chat", [
    api("arm-stop-provider"),
    fill("Message composer", "Stop this deterministic usability turn."),
    click("Send"),
    click("Stop turn"),
    click("Retry turn"),
    text("Verification stub reply."),
  ]),
  step("chat-lifecycle", "route.chat.edit-and-branch", "chat", [
    api("chat-retry-completed"),
    click("Open turn: Stop this deterministic usability turn."),
    waitEnabled("Edit and resend turn ", false),
    clickPattern("Edit and resend turn "),
    text("Branching from turn"),
    fill("Message composer", "Branch this deterministic turn."),
    click("Send branch"),
    api("chat-branch-completed"),
  ]),
  step("chat-lifecycle", "route.chat.attachments-citations-tools", "chat", [
    api("chat-branch-completed"),
    api("chat-attachment-evidence-seed"),
    reload(),
    click("Work Record"),
    text("Deterministic attachment citation"),
    text("1 citation"),
    text("verification.inspect"),
    text("1 event"),
    click("Close"),
    click("Open chat actions"),
    fill("Knowledge URL", "https://fixture.example.invalid/usability-attachment-source"),
    select("Knowledge URL mode", "Use retrieval"),
    click("Attach source"),
    text("Attached a thread knowledge source."),
    click("Open chat actions"),
    binaryFile(
      "Upload files",
      "usability-image.png",
      "image/png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    loadedImage("usability-image.png"),
    binaryFile(
      "Upload files",
      "usability-audio.wav",
      "audio/wav",
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=",
    ),
    text("usability-audio.wav"),
    fill("Message composer", "Inspect deterministic image and audio attachments."),
    click("Send"),
    text("Verification stub reply."),
    api("chat-attachments-canonical"),
  ]),

  step("chat-agentic-durable-code", "route.chat.planning-delegation-synthesis", "chat", [
    click("Plan"),
    text("Planning mode is on"),
    fill("Message composer", "Plan this deterministic usability turn."),
    click("Send"),
    text("Verification stub reply."),
    api("planning-turn-completed"),
    api("delegate-suggest-accept"),
  ]),
  step("chat-agentic-durable-code", "route.chat.approval-and-user-input-resume", "chat", [
    fixtureSession("approval"),
    text("Approval needed"),
    click("Allow once"),
    text("Approved once."),
    fixtureSession("userInput"),
    text("Input needed"),
    clickPattern("Continue with the current plan"),
    click("Submit answer"),
    api("approval-and-user-input"),
  ]),
  step("chat-agentic-durable-code", "route.chat.durable-restart-resume", "chat", [
    click("Work Record"),
    click("Background tasks"),
    click("Refresh background tasks"),
    clickPattern("Detach background task "),
    text("detached"),
    clickPattern("Reattach background task "),
    text("attached"),
    api("durable-run-read"),
  ]),
  step("chat-agentic-durable-code", "route.chat.code-mode-artifacts", "chat", [
    api("arm-code-helper-provider"),
    fill("Message composer", "Create a deterministic TypeScript helper snippet."),
    click("Send"),
    text("CHAT_CODE_MODE_OK"),
    api("code-helper-turn-completed"),
    click("Open turn: Create a deterministic TypeScript helper snippet."),
    click("Build editor"),
    click("Snippets"),
    click("Run helper snippet"),
    text("Queued a code helper run for this snippet."),
    click("Run log"),
    text("approval_pending"),
    click("Inspect run"),
    text("Execution: approval_pending"),
    text("Open approval queue"),
    api("code-mode-helper-approve-complete"),
    reload(),
    click("Build editor"),
    click("Run log"),
    text("completed"),
    click("Inspect run"),
    text("Execution: completed"),
    text("Verification: completed_unverified"),
    text("Artifact integrity: hashes matched"),
    text("Capability profile"),
    text("frozen"),
    click("Source"),
    api("code-mode-helper-artifacts"),
    click("Run named proof"),
    text("Verification: verified"),
    api("code-mode-helper-proof"),
    api("capability-catalog-read"),
    click("Hide build editor"),
    click("Open turn: Create a deterministic TypeScript helper snippet."),
    clickPattern("Open durable run trace "),
    text("Signed evidence receipt"),
    text("Timeline"),
    api("code-mode-helper-run-detail"),
  ]),

  step("projects-workspaces", "route.projects.workspace-project-crud", "projects", [
    fill("Release readiness", "Usability browser project"),
    fill("Local project path", "workspace/verification/usability-browser-project"),
    fill("What this project is for.", "Created by the isolated Chromium usability journey."),
    click("Create project from form"),
    text("Usability browser project"),
    fill("Edit project description", "Updated by the visible project edit flow."),
    click("Save project"),
    text("Updated by the visible project edit flow."),
    click("Archive project Usability browser project"),
    clickPattern("Archived projects"),
    text("Usability browser project"),
    click("Unarchive project Usability browser project"),
    text("No archived projects in this workspace."),
  ]),
  step("projects-workspaces", "route.projects.revision-conflict", "projects", [
    clickPattern("Usability browser project"),
    fill("Edit project description", "Local draft preserved across the revision conflict."),
    api("project-revision-conflict"),
    click("Save project"),
    text("changed elsewhere"),
    text("draft was preserved"),
    click("Save project"),
    text("Local draft preserved across the revision conflict."),
    api("project-revision-persisted"),
  ]),
  step(
    "projects-workspaces",
    "route.settings-workspaces.workspace-create-select-archive-restore",
    "settings-workspaces",
    [
      fill("Name", "Usability browser workspace"),
      click("Create workspace"),
      clickPattern("Make active workspace Usability browser workspace"),
      clickPattern("Archive workspace Usability browser workspace"),
      click("Confirm archive workspace"),
      text("Workspace Usability browser workspace archived."),
      click("Archived workspaces"),
      clickPattern("Usability browser workspace"),
      clickPattern("Restore workspace Usability browser workspace"),
      text("Workspace Usability browser workspace restored."),
      click("Active workspaces"),
      clickPattern("Usability browser workspace"),
      api("workspace-lifecycle-active"),
    ],
  ),
  step("projects-workspaces", "route.settings-workspaces.workspace-isolation", "settings-workspaces", [
    clickPattern("Usability browser workspace"),
    api("workspace-isolation"),
    text("Usability browser workspace"),
  ]),

  step("library-catalog-memory", "route.library-agents.agent-crud", "library-agents", [
    click("New profile"),
    fill("Role ID", "usability-browser-agent"),
    fill("Name", "Usability Browser Agent"),
    fill("Title", "Usability Evidence Agent"),
    fill("Summary", "Deterministic agent created by the isolated Chromium usability journey."),
    click("Create agent"),
    click("Archive"),
    click("Restore"),
    text("Agent profile restored."),
  ]),
  step("library-catalog-memory", "route.library-agents.agent-default-tool-profile", "library-agents", [
    clickPattern("Usability Browser Agent"),
    fill("Default tools", "fs.read, fs.list"),
    click("Save changes"),
    value("Default tools", "fs.read, fs.list"),
    api("agent-default-tools-persisted"),
  ]),
  step("library-catalog-memory", "route.library-skills.skill-inspect-activate-deactivate", "library-skills", [
    fill("Search skills", "coding"),
    api("skill-lifecycle-approval-baseline"),
    click("Enable"),
    textPattern("(?:Approval requested to set coding to enabled|coding is already enabled; nothing to approve\\.)"),
    api("skill-lifecycle-enabled-readback"),
    click("Sleep"),
    textPattern("(?:Approval requested to set coding to sleep|coding is already sleep; nothing to approve\\.)"),
    api("skill-lifecycle-sleep-readback"),
    click("Disable"),
    textPattern("(?:Approval requested to set coding to disabled|coding is already disabled; nothing to approve\\.)"),
    api("skill-lifecycle-disabled-readback"),
  ]),
  step("library-catalog-memory", "route.library-skills.skill-provenance", "library-skills", [
    clickPattern("coding"),
    text("Provenance"),
    text("Version"),
  ]),
  step("library-catalog-memory", "route.library-capabilities.inspectable-callable-catalogs", "library-capabilities", [
    click("Refresh catalog"),
    text("Inspectable"),
    text("Callable"),
  ]),
  step("library-catalog-memory", "route.library-capabilities.candidate-proposal-lifecycle", "library-capabilities", [
    api("candidate-proposal-read"),
    click("Refresh catalog"),
    clickPattern("Usability browser capability proposal"),
    text("Proposal review"),
    text("Inspectable only until governance activation"),
  ]),
  step("library-catalog-memory", "route.library-memory.memory-scope-and-provenance", "library-memory", [
    fill("Search memory", "Mission Control Next shell posture"),
    clickPattern("Memory item Mission Control Next shell posture"),
    text("Provenance"),
  ]),
  step("library-catalog-memory", "route.library-memory.memory-edit-pin-forget-history", "library-memory", [
    fill("Search memory", "Mission Control Next shell posture"),
    clickPattern("Memory item Mission Control Next shell posture"),
    checkPattern("Select memory item"),
    click("Pin selected"),
    fill("Memory item content", "Edited deterministic memory content."),
    clickPattern("Save changes to memory item"),
    text("Item history"),
    clickPattern("Forget memory item"),
    click("Forget"),
    text("Memory forget requires approval"),
  ]),
  step("library-catalog-memory", "route.library-journey.journey-event-detail", "library-journey", [
    click("Include global evidence"),
    clickPattern("Mutation requested"),
    text("Evidence"),
  ]),
  step("library-catalog-memory", "route.library-curator.curator-inspection", "library-curator", [
    click("Generate report"),
    text("Report complete"),
    clickPattern("Archive "),
    click("Archive"),
    text("Archived"),
  ]),

  externalStep("library-content", "route.library-knowledge.external-source-register-scan-import", "library-knowledge", [
    "library-register-source",
    "library-scan-seals-catalog",
    "library-dry-run-plan",
    "library-apply-import",
  ]),
  externalStep("library-content", "route.library-knowledge.chat-attach-and-governed-copy", "library-knowledge", [
    "chat-attach-goes-live",
    "select-attachment-for-turn",
    "send-with-frozen-refs-clears-selection",
    "request-knowledge-copy",
    "approve-in-approvals-inbox",
    "recovered-snapshot-visible-with-provenance",
  ]),
  step("library-content", "route.library-notes.note-crud-and-conflict", "library-notes", [
    fill("Title", "Usability browser note"),
    fill("Body", "Deterministic note body from the isolated Chromium journey."),
    click("Save note"),
    clickPattern("Usability browser note"),
    fill("Edit body", "Edited deterministic note body."),
    api("note-revision-conflict"),
    click("Save changes"),
    text("Your draft is preserved"),
    click("Reload canonical"),
    click("Archive note"),
    text("Usability browser note archived."),
  ]),
  step("library-content", "route.library-communications.communication-list-and-agenda", "library-communications", [
    text("Fixture inbox readiness"),
    text("Deterministic inbox content; no provider credential was configured."),
    text("Fixture usability agenda"),
    api("communications-uncredentialed-fixture"),
  ]),
  step("library-content", "route.library-communications.approval-gated-draft-no-send", "library-communications", [
    fill("To", "fixture-recipient@example.invalid"),
    fill("Subject", "Usability fixture approval draft"),
    fill("Body", "This message remains inside the isolated approval fixture."),
    click("Queue approval"),
    text("approval_required"),
    api("communications-approval-no-send"),
  ]),
  step("library-content", "route.library-files.file-list-upload-download", "library-files", [
    fill("Upload path", "workspace/verification/usability-upload.txt"),
    fill("Upload content", "isolated upload fixture"),
    click("Upload file"),
    text("usability-upload.txt"),
    download("Download file", {
      expectedFileName: "usability-upload.txt",
      expectedSha256: "4676d58172dd6456a60cb8a27f89f2033db272ff8f9a1e9b2d363f1a28a9ddb6",
    }),
  ]),
  step("library-content", "route.library-artifacts.artifact-list-detail-download", "library-artifacts", [
    clickPattern("Generated note"),
    text("Artifact provenance"),
    download("Download artifact", {
      expectedFileName: "Generated note.txt",
      expectedSha256: "22639a23fb590b8008d0479ec46c6e111b0dc990e68c138e26b5ebea47106bf9",
    }),
  ]),
  step("library-content", "route.library-prompt-packs.author-edit", "library-prompt-packs", [
    clickPattern("Import a new pack"),
    fill(
      "Prompt-pack markdown",
      [
        "Pack-Version: Usability Author Draft",
        "[TEST-91] Initial authored fixture prompt",
        "Reply with exactly: PROMPT_PACK_DRAFT_OK",
      ].join("\n"),
    ),
    fill(
      "Prompt-pack markdown",
      [
        "Pack-Version: Usability Authored Prompt Pack",
        "[TEST-91] Authored fixture prompt revised",
        "Reply with exactly: PROMPT_PACK_AUTHORED_OK",
        "",
        "[TEST-92] Authored fixture comparison",
        "Compare the deterministic fixture response and report the final result.",
      ].join("\n"),
    ),
    click("Import pack"),
    text("Imported 2 tests."),
    text("Usability Authored Prompt Pack"),
    text("TEST-91"),
  ]),
  step("library-content", "route.library-prompt-packs.run-selected-and-all", "library-prompt-packs", [
    click("Run selected"),
    text("Ran TEST-91."),
    click("Auto score this run"),
    text("Auto-scored TEST-91:"),
    click("Fill pass defaults"),
    fill("Notes", "Deterministic operator review of the authored fixture."),
    click("Save review"),
    text("Saved review for TEST-91."),
    waitEnabled("Run all"),
    click("Run all", {
      captureJsonResponse: {
        method: "POST",
        pathPattern: "^/api/v1/prompt-packs/[^/]+/benchmark/run$",
        status: 200,
        field: "benchmarkRunId",
        valuePattern: "^ppb-[a-f0-9-]{36}$",
        stateKey: "promptPackRunAllBenchmarkRunId",
        expectedBody: {
          allTests: true,
          providers: [{ providerId: "verification-stub", model: "verification-stub-chat" }],
          executionStyle: "single_turn_harness",
        },
      },
    }),
    text("Benchmark completed 2/2"),
    api("prompt-pack-run-all-canonical-settle"),
  ]),
  step("library-content", "route.library-prompt-packs.compare-review-export", "library-prompt-packs", [
    clickPattern("Advanced quality ops"),
    fill("Test codes", "TEST-91, TEST-92"),
    fill(
      "Benchmark matrix",
      ["verification-stub/verification-stub-chat", "verification-stub/verification-stub-chat-alt"].join("\n"),
    ),
    api("prompt-pack-benchmark-provider-readiness"),
    click("Start benchmark", {
      captureJsonResponse: {
        method: "POST",
        pathPattern: "^/api/v1/prompt-packs/[^/]+/benchmark/run$",
        status: 200,
        field: "benchmarkRunId",
        valuePattern: "^ppb-[a-f0-9-]{36}$",
        stateKey: "promptPackBenchmarkRunId",
        expectedBody: {
          testCodes: ["TEST-91", "TEST-92"],
          providers: [
            { providerId: "verification-stub", model: "verification-stub-chat" },
            { providerId: "verification-stub", model: "verification-stub-chat-alt" },
          ],
          executionStyle: "single_turn_harness",
        },
      },
    }),
    text("Benchmark completed 4/4", { timeoutMs: MAX_OPERATION_TIMEOUT_MS }),
    api("prompt-pack-benchmark-provider-dispatch"),
    clickPattern("Insights and regression evidence"),
    text("Latest benchmark"),
    text("verification-stub/verification-stub-chat"),
    text("verification-stub/verification-stub-chat-alt"),
    click("Export report"),
    text("Saved prompt-pack log to"),
  ]),

  step("citadel", "route.library-citadel.citadel-create-and-isolation", "library-citadel", [
    click("Start setup"),
    fill("Message the Mason", "Stage a verification company Citadel with explicit review boundaries."),
    click("Send to the Mason"),
    text("Session is staged"),
    api("citadel-isolation"),
  ]),
  step("citadel", "route.library-citadel-overview.citadel-charter-lifecycle", "library-citadel-overview", [
    fill("Purpose", "Govern the isolated Chromium Citadel journey."),
    click("Save charter"),
    click("Archive Citadel"),
    click("Restore Citadel"),
    text("Citadel restored."),
  ]),
  step("citadel", "route.library-citadel-wards.ward-create-delete-and-evaluate", "library-citadel-wards", [
    fill("Name", "Usability Browser Ward"),
    fill("Action pattern", "verification.*"),
    click("Add Ward"),
    text("Usability Browser Ward"),
    fill("Action", "verification.read"),
    click("Evaluate"),
    text("verification.read"),
    click("Delete Ward"),
    click("Confirm delete Ward"),
    textAbsent("Usability Browser Ward"),
  ]),
  step("citadel", "route.library-citadel-council.council-seat-and-remove", "library-citadel-council", [
    select("Council agent", "Operator Scout"),
    click("Remove"),
    text("Agent removed from this Citadel Council"),
    click("Seat"),
    text("Agent seated in this Citadel"),
  ]),
  step("citadel", "route.library-citadel-blueprint.blueprint-edit-export", "library-citadel-blueprint", [
    click("Load export for import"),
    click("Validate"),
    click("Import"),
    text("Blueprint imported"),
    download("Download blueprint", {
      expectedFileNamePattern: "^[A-Za-z0-9._-]+-blueprint\\.json$",
      contentContract: "citadel-blueprint-v1",
      expectedBlueprintPurpose: "Govern the isolated Chromium Citadel journey.",
    }),
  ]),
  step("citadel", "route.library-citadel-vault.vault-secret-status-and-governance", "library-citadel-vault", [
    fill("Name", "usability-browser-vault-fixture"),
    fill("Value", "verification-only-non-secret"),
    click("Seal & store"),
    text("usability-browser-vault-fixture"),
    click("Reveal"),
    click("Hide"),
    clickPattern("Delete usability-browser-vault-fixture"),
    click("Delete"),
    textAbsent("usability-browser-vault-fixture"),
  ]),

  step("ops-work", "route.ops-boards.board-crud-and-widgets", "ops-boards", [
    click("New board"),
    fill("Board name", "Usability browser board"),
    click("Create board"),
    click("Edit layout"),
    click("Save changes"),
    click("Archive"),
    click("Archive board"),
    click("Restore"),
    click("Restore board"),
    control("Archive"),
  ]),
  step("ops-work", "route.ops-activity.activity-filter-and-detail", "ops-activity", [
    click("Errors"),
    click("Approvals"),
    click("Runtime"),
    click("All"),
    clickPattern("Inspect activity event"),
    text("Activity event detail"),
  ]),
  step("ops-work", "route.ops-activity.realtime-reconnect", "ops-activity", [
    clickPattern("Refresh Ops runtime data"),
    text("Updated"),
  ]),
  step("ops-work", "route.ops-sessions.session-list-detail-control", "ops-sessions", [
    click("Browser Sessions"),
    click("Refresh"),
    fill("New session label", "Usability browser governed session"),
    click("Create governed session"),
    text("Browser session created"),
    fill("Allowed hosts", "fixture.example.invalid"),
    click("Create scoped grant"),
    text("Scoped browser-session grant created"),
    click("Rotate"),
    text("Grant rotated"),
    click("Revoke"),
    text("Grant revoked"),
    click("Close session and revoke grants"),
    text("Browser session closed"),
  ]),
  step("ops-work", "route.ops-schedules.schedule-create-list-cancel-and-run", "ops-schedules", [
    fill("Name", "Usability browser schedule"),
    fill("Schedule", "0 9 * * *"),
    click("Create schedule"),
    text("Schedule created"),
    clickPattern("Run Usability browser schedule now"),
    clickPattern("Cancel Usability browser schedule"),
    clickPattern("Confirm cancel Usability browser schedule"),
    text("cancelled"),
  ]),
  step("ops-work", "route.ops-kanban.task-board-lifecycle", "ops-kanban", [
    checkPattern("Select Watch runtime approvals and costs"),
    click("Unblock"),
    checkPattern("Select Review task board and agent board cohesion"),
    click("Retry"),
    checkPattern("Select Capture prompt-pack quality posture"),
    click("Close"),
    api("kanban-task-lifecycle-readback"),
  ]),

  step("ops-governance-reliability", "route.ops-improvement.improvement-review", "ops-improvement", [
    clickPattern("Refresh Ops runtime data"),
    text("Improvement reports"),
  ]),
  step("ops-governance-reliability", "route.ops-notifications.notification-target-rule-crud", "ops-notifications", [
    fill("Label", "Usability notification destination"),
    select("Kind", "Keychain HTTPS webhook"),
    fill("Webhook URL secret reference", "keychain:goatcitadel:notification-webhook:usability-fixture"),
    click("Add destination"),
    text("Notification target created"),
    fill("Rule label", "Usability notification rule"),
    checkPattern("Usability notification destination"),
    click("Create rule"),
    text("Notification rule created"),
  ]),
  step(
    "ops-governance-reliability",
    "route.ops-notifications.notification-test-and-operator-policy",
    "ops-notifications",
    [
      clickPattern("Test notification destination Usability notification destination"),
      text("Test delivery: failed"),
      clickPattern("Archive notification rule Usability notification rule"),
      api("notification-rule-archive-readback"),
      clickPattern("Archive notification destination Usability notification destination"),
      api("notification-archive-and-non-operator-denial"),
    ],
  ),
  step("ops-governance-reliability", "route.ops-approvals.approval-resume-canonical-run", "ops-approvals", [
    fixtureSession("opsApproval"),
    api("durable-run-pause"),
    click("Load durable status"),
    click("Resume paused run"),
    click("Resume run"),
    api("approval-durable-run-read"),
  ]),
  step("ops-governance-reliability", "route.ops-approvals.approval-approve-deny", "ops-approvals", [
    api("approval-decision-baseline"),
    click("Approve now"),
    click("Approve"),
    click("Reject"),
    click("Confirm rejection"),
    api("approval-decisions-resolved"),
  ]),
  step("ops-governance-reliability", "route.ops-costs.cost-filter-and-budget-truth", "ops-costs", [
    click("Verification Stub"),
    tableText("Provider spend breakdown", "Verification Stub"),
    click("All providers"),
    click("Open budget controls"),
    text("Budget"),
  ]),
  step("ops-governance-reliability", "route.ops-quality.quality-evidence-and-status", "ops-quality", [
    click("Copy eval proof export"),
    text("Copied eval proof export"),
    click("Refresh"),
    text("Quality gates"),
  ]),
  step("ops-governance-reliability", "route.ops-runtime.runtime-health-and-owner-truth", "ops-runtime", [
    clickPattern("Refresh Ops runtime data"),
    click("Runtime posture"),
    text("Runtime authority map"),
    api("runtime-health-read"),
  ]),
  step("ops-governance-reliability", "route.ops-runtime.restart-recovery", "ops-runtime", [
    api("runtime-diagnostic-fixture"),
    click("Recovery"),
    text("Recovery and diagnostics"),
  ]),
  step("ops-governance-reliability", "route.ops-diagnostics.diagnostic-list-detail-export", "ops-diagnostics", [
    clickPattern("Refresh Ops runtime data"),
    clickPattern("Inspect diagnostic"),
    text("Diagnostic detail"),
    download("Export diagnostics", {
      expectedFileName: "goatcitadel-ops-diagnostics.json",
      contentContract: "ops-diagnostics-v1",
    }),
  ]),
  step("ops-governance-reliability", "route.ops-diagnostics.backup-recovery-entry", "ops-diagnostics", [
    click("Open backup posture"),
    text("Backup posture"),
  ]),

  step(
    "settings-core-auth-provider",
    "route.settings-general.interface-preferences-persist-across-reload",
    "settings-general",
    [
      select("Display density", "Compact"),
      select("Sound cue", "Subtle"),
      uncheckPattern("Show operator attention toasts"),
      reload(),
      value("Display density", "compact"),
      value("Sound cue", "subtle"),
      assertChecked("Show operator attention toasts", false),
    ],
  ),
  step(
    "settings-core-auth-provider",
    "route.settings-onboarding.onboarding-complete-and-revisit",
    "settings-onboarding",
    [
      click("Apply defaults"),
      text("First-run defaults applied."),
      click("Mark complete"),
      text("Onboarding marked complete."),
      click("Refresh"),
      text("Complete"),
    ],
  ),
  step("settings-core-auth-provider", "route.settings-providers.provider-activate-model-select", "settings-providers", [
    select("Provider", "Verification stub (loopback)"),
    select("Model", "verification-stub-chat"),
    click("Save routing"),
    text("Provider routing updated."),
  ]),
  step(
    "settings-core-auth-provider",
    "route.settings-providers.oauth-status-and-invalid-credential",
    "settings-providers",
    [
      click("Add ChatGPT setup"),
      text("ChatGPT provider added. Start ChatGPT login below."),
      text("Not started"),
      api("invalid-provider-credential"),
    ],
  ),
  step("settings-core-auth-provider", "route.settings-personalities.personality-inspection", "settings-personalities", [
    click("Refresh"),
    text("Personality"),
  ]),
  step("settings-core-auth-provider", "route.settings-access.token-basic-device-grants", "settings-access", [
    select("Auth mode", "Token"),
    click("Save access settings"),
    text("Access posture updated."),
    click("Generate install token"),
    text("Install token resolved from"),
    api("authenticated-access-variants"),
  ]),
  step("settings-core-auth-provider", "route.settings-access.revoked-and-persisted-credentials", "settings-access", [
    click("Revoke"),
    confirm("Revoke"),
    text("Device access revoked."),
    api("revoked-credential-denial"),
  ]),
  step("settings-core-auth-provider", "route.settings-budget.budget-mode-update-and-conflict", "settings-budget", [
    select("Mode", "Saver"),
    click("Save budget mode"),
    text("Budget mode saved."),
    api("settings-revision-conflict"),
    select("Mode", "Power"),
    click("Save budget mode"),
    text("changed elsewhere"),
  ]),

  step(
    "settings-governance-runtime-integrations",
    "route.settings-permissions.permission-profile-crud",
    "settings-permissions",
    [
      fill("Name", "Usability deny-wins profile"),
      select("Approval behavior", "Ask for risky work"),
      fill("Description", "Deterministic Settings permission profile."),
      select("Read access", "Workspace roots only"),
      fill("Tool patterns", "fs.write\nsession.status"),
      fill("Allow patterns", "fs.*"),
      fill("Deny patterns", "fs.write"),
      click("Create profile"),
      text("Permission profile created."),
      fill("Description", "Updated deterministic Settings permission profile."),
      click("Save profile"),
      text("Permission profile updated."),
    ],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-permissions.deny-wins-preview",
    "settings-permissions",
    [
      clickPattern("Usability deny-wins profile"),
      text("Deny"),
      text("fs.write"),
      api("tool-deny-wins"),
      click("Archive profile"),
      confirm("Archive profile"),
      text("Permission profile archived."),
    ],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-trust-policy.trust-policy-inspection-and-owner-handoff",
    "settings-trust-policy",
    [click("Refresh snapshot"), click("Open Permissions"), text("Permission profiles")],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-runtime.runtime-settings-update-and-conflict",
    "settings-runtime",
    [
      fill("Alias", "Usability llama runtime"),
      click("Save"),
      text("llama.cpp settings saved."),
      api("settings-revision-conflict"),
      fill("Alias", "Usability llama runtime conflict draft"),
      click("Save"),
      text("changed elsewhere"),
    ],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-local-ai.hardware-readiness-and-not-configured-reason",
    "settings-local-ai",
    [click("Refresh readiness"), text("not configured")],
  ),
  step("settings-governance-runtime-integrations", "route.settings-addons.addon-inspection", "settings-addons", [
    clickPattern("Arena"),
    text("Trust tier"),
    text("Catalog provenance"),
  ]),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-integrations.integration-validation-and-diagnostics",
    "settings-integrations",
    [
      clickPattern("Verification webhook diagnostics"),
      click("Save changes"),
      text("Connection updated."),
      click("Run diagnostics"),
      text("Diagnostics refreshed."),
      text("Webhook base URL"),
    ],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-integrations.sandbox-destination",
    "settings-integrations",
    [clickPattern("Verification sandbox bridge"), text("Read Sample"), click("Run"), text("fixture bridge ok")],
  ),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-channels.channel-validation-and-diagnostics",
    "settings-channels",
    [
      clickPattern("Verification sandbox channel"),
      click("Save draft"),
      text("Channel draft saved."),
      click("Validate"),
      text("Channel draft validated."),
    ],
  ),
  step("settings-governance-runtime-integrations", "route.settings-channels.sandbox-destination", "settings-channels", [
    clickPattern("Verification sandbox channel"),
    click("Test"),
    text("Finalize the connection"),
    text("Test results"),
    click("Finalize"),
    text("Verification sandbox channel finalized."),
  ]),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-mcp.mcp-server-tool-grant-lifecycle",
    "settings-mcp",
    [
      clickPattern("Verification local MCP"),
      fill("Label", "Verification local MCP updated"),
      click("Save changes"),
      text("MCP server updated."),
      click("Connect"),
      text("MCP server connect requested."),
      text("goatcitadel.context.list"),
      click("Health check"),
      text("MCP health check complete."),
      click("Disconnect"),
      text("MCP server disconnect requested."),
      click("Manage tool grants"),
      fill("Search", "mcp.invoke"),
      clickPattern("mcp.invoke"),
      fill("Tool pattern", "mcp.*"),
      select("Decision", "Deny"),
      click("Create grant"),
      text("Tool grant created."),
      click("Revoke"),
      confirm("Revoke"),
      text("Tool grant revoked."),
    ],
  ),
  step("settings-governance-runtime-integrations", "route.settings-mcp.unsupported-transport-truth", "settings-mcp", [
    clickPattern("Remote MCP preview"),
    text("Verification remote MCP"),
    text("governed Gateway bridge"),
  ]),
  step("settings-governance-runtime-integrations", "route.settings-tools.tool-catalog-and-grants", "settings-tools", [
    fill("Search", "session.status"),
    clickPattern("session.status"),
    fill("Tool pattern", "session.status"),
    select("Decision", "Deny"),
    click("Create grant"),
    text("Tool grant created."),
    click("Revoke"),
    confirm("Revoke"),
    text("Tool grant revoked."),
  ]),
  step(
    "settings-governance-runtime-integrations",
    "route.settings-tools.approval-and-policy-boundary",
    "settings-tools",
    [
      select("Tool approvals", "Ask for risky work"),
      click("Save mode"),
      text("Tool approval mode saved."),
      api("tool-approval-boundary"),
      text("Hard blocks"),
    ],
  ),
];

export const BROWSER_ACTION_STEP_REGISTRY = Object.freeze(
  Object.fromEntries(
    STEPS.map((item) => [
      item.stepId,
      Object.freeze({
        ...item,
        operations: Object.freeze(item.operations.map((operation) => Object.freeze({ ...operation }))),
        externalSourceStepNames: Object.freeze([...(item.externalSourceStepNames ?? [])]),
      }),
    ]),
  ),
);

export const BROWSER_ACTION_BUNDLES = Object.freeze(
  Object.fromEntries(
    Object.keys(EXPECTED_BROWSER_ACTION_BUNDLE_COUNTS).map((bundleId) => [
      bundleId,
      Object.freeze(Object.values(BROWSER_ACTION_STEP_REGISTRY).filter((item) => item.bundleId === bundleId)),
    ]),
  ),
);

export function browserActionProofBindingsFor(stepId) {
  const dedicatedProof = DEDICATED_BROWSER_PROOFS[stepId];
  if (dedicatedProof) return [dedicatedProof];
  const registered = BROWSER_ACTION_STEP_REGISTRY[stepId];
  if (!registered) {
    return [
      {
        mode: "missing-browser-action-proof",
        scenarioIds: [],
        browserStepIds: [],
        requireArtifacts: false,
        contract: "No exact Chromium operator-action step is registered.",
      },
    ];
  }
  const browserBinding = {
    mode: "browser-action-step",
    scenarioIds: [registered.ownerScenarioId],
    browserStepIds: [stepId],
    requireArtifacts: true,
    contract: registered.expectedResult,
    bundleId: registered.bundleId,
    externalSourceStepNames: [...registered.externalSourceStepNames],
  };
  const supplementalProof = SUPPLEMENTAL_ACTION_PROOFS[stepId];
  return supplementalProof ? [browserBinding, supplementalProof] : [browserBinding];
}

export function validateBrowserActionProofContract(requiredActionStepIds) {
  const expected = new Set(requiredActionStepIds);
  const registered = new Set([...Object.keys(BROWSER_ACTION_STEP_REGISTRY), ...Object.keys(DEDICATED_BROWSER_PROOFS)]);
  const supplemental = Object.keys(SUPPLEMENTAL_ACTION_PROOFS);
  const stale = [...registered].filter((stepId) => !expected.has(stepId));
  const missing = [...expected].filter((stepId) => !registered.has(stepId));
  if (stale.length > 0 || missing.length > 0) {
    throw new Error(
      `usability browser action contract drifted (stale=${stale.join(",")}; missing=${missing.join(",")})`,
    );
  }
  if (registered.size !== expected.size) {
    throw new Error("usability browser action contract contains duplicate or missing action identities");
  }
  const invalidSupplemental = supplemental.filter(
    (stepId) => !expected.has(stepId) || !Object.hasOwn(BROWSER_ACTION_STEP_REGISTRY, stepId),
  );
  if (invalidSupplemental.length > 0) {
    throw new Error(`usability supplemental action proof has no Chromium owner: ${invalidSupplemental.join(",")}`);
  }
  for (const [bundleId, expectedCount] of Object.entries(EXPECTED_BROWSER_ACTION_BUNDLE_COUNTS)) {
    const steps = BROWSER_ACTION_BUNDLES[bundleId] ?? [];
    if (steps.length !== expectedCount) {
      throw new Error(`usability browser bundle ${bundleId} expected ${expectedCount} steps, received ${steps.length}`);
    }
  }
  for (const item of Object.values(BROWSER_ACTION_STEP_REGISTRY)) {
    if (!item.ownerScenarioId || !item.expectedResult || item.operations.length === 0) {
      throw new Error(`usability browser action ${item.stepId} has no executable evidence contract`);
    }
    if (!item.external && item.operations.every((operation) => operation.kind === "assert-text")) {
      throw new Error(`usability browser action ${item.stepId} performs no operator action`);
    }
    if (item.external && item.externalSourceStepNames.length === 0) {
      throw new Error(`external-source action ${item.stepId} has no exact browser step names`);
    }
    validateBrowserActionTerminalEvidenceContract(item);
  }
  return {
    registeredActions: registered.size,
    chromiumBundleActions: Object.keys(BROWSER_ACTION_STEP_REGISTRY).length,
    dedicatedActions: Object.keys(DEDICATED_BROWSER_PROOFS).length,
    supplementalActions: supplemental.length,
    bundleCounts: Object.fromEntries(
      Object.entries(BROWSER_ACTION_BUNDLES).map(([bundleId, steps]) => [bundleId, steps.length]),
    ),
  };
}

export function validateBrowserActionTerminalEvidenceContract(item) {
  const operations = Array.isArray(item?.operations) ? item.operations : [];
  if (operations.length === 0) {
    throw new Error(`usability browser action ${String(item?.stepId ?? "unknown")} has no operations`);
  }

  const unverifiedDownload = operations.find((operation) => {
    if (operation?.kind !== "click" && operation?.kind !== "click-pattern") return false;
    const accessibleName = operation.name ?? operation.namePattern ?? "";
    return DOWNLOAD_CONTROL_PATTERN.test(accessibleName);
  });
  if (unverifiedDownload) {
    throw new Error(
      `usability browser action ${item.stepId} must observe and validate the Playwright download for ${unverifiedDownload.name ?? unverifiedDownload.namePattern}`,
    );
  }

  for (const operation of operations) {
    if (
      operation.timeoutMs !== undefined &&
      (!Number.isInteger(operation.timeoutMs) ||
        operation.timeoutMs < 1 ||
        operation.timeoutMs > MAX_OPERATION_TIMEOUT_MS)
    ) {
      throw new Error(
        `usability browser action ${item.stepId} has an invalid operation timeout (${String(operation.timeoutMs)})`,
      );
    }
    if (operation.captureJsonResponse !== undefined) {
      const capture = operation.captureJsonResponse;
      if (
        operation.kind !== "click" ||
        typeof capture.method !== "string" ||
        typeof capture.pathPattern !== "string" ||
        !Number.isInteger(capture.status) ||
        typeof capture.field !== "string" ||
        typeof capture.valuePattern !== "string" ||
        typeof capture.stateKey !== "string"
      ) {
        throw new Error(`usability browser action ${item.stepId} has an invalid JSON response capture`);
      }
      try {
        new RegExp(capture.pathPattern, "u");
        new RegExp(capture.valuePattern, "u");
      } catch (error) {
        throw new Error(
          `usability browser action ${item.stepId} has an invalid JSON response capture pattern: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }

  for (const operation of operations.filter((candidate) => candidate?.kind === "download")) {
    const filenameSelectors = [operation.expectedFileName, operation.expectedFileNamePattern].filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    if (filenameSelectors.length !== 1) {
      throw new Error(`verified download in ${item.stepId} requires exactly one expected filename selector`);
    }
    if (operation.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(operation.expectedSha256)) {
      throw new Error(`verified download in ${item.stepId} has an invalid expected SHA-256`);
    }
    if (operation.expectedSha256 === undefined && operation.contentContract === undefined) {
      throw new Error(`verified download in ${item.stepId} requires a SHA-256 or approved content contract`);
    }
    if (
      operation.contentContract !== undefined &&
      !APPROVED_DOWNLOAD_CONTENT_CONTRACTS.has(operation.contentContract)
    ) {
      throw new Error(`verified download in ${item.stepId} has an unapproved content contract`);
    }
    if (
      operation.contentContract === "citadel-blueprint-v1" &&
      (typeof operation.expectedBlueprintPurpose !== "string" || !operation.expectedBlueprintPurpose.trim())
    ) {
      throw new Error(`verified Citadel Blueprint download in ${item.stepId} requires the exact fixture purpose`);
    }
    if (typeof operation.expectedFileNamePattern === "string") {
      try {
        new RegExp(operation.expectedFileNamePattern, "iu");
      } catch (error) {
        throw new Error(
          `verified download in ${item.stepId} has an invalid filename pattern: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }

  const finalOperation = operations.at(-1);
  if (TERMINAL_EVIDENCE_KINDS.has(finalOperation?.kind)) return true;

  const approvedReason = APPROVED_TERMINAL_EVIDENCE_EXEMPTIONS[item.stepId];
  if (
    typeof approvedReason === "string" &&
    approvedReason.length > 0 &&
    item.terminalEvidenceExemption === approvedReason
  ) {
    return true;
  }
  if (item.terminalEvidenceExemption !== undefined) {
    throw new Error(`usability browser action ${item.stepId} has an unapproved terminal-evidence exemption`);
  }
  throw new Error(
    `usability browser action ${item.stepId} ends with ${String(finalOperation?.kind)} instead of a terminal UI/API readback`,
  );
}

export function listBrowserActionProofGaps() {
  return Object.values(BROWSER_ACTION_STEP_REGISTRY)
    .filter((item) => item.knownUiGap)
    .map((item) => ({ stepId: item.stepId, bundleId: item.bundleId, expectedResult: item.expectedResult }));
}

function step(bundleId, stepId, routeSlug, operations, options = {}) {
  return {
    bundleId,
    stepId,
    routeSlug,
    operations,
    ownerScenarioId: options.ownerScenarioId ?? `usability.browser-actions.${bundleId}`,
    external: options.external === true,
    knownUiGap: options.knownUiGap === true,
    externalSourceStepNames: options.externalSourceStepNames ?? [],
    ...(options.terminalEvidenceExemption ? { terminalEvidenceExemption: options.terminalEvidenceExemption } : {}),
    expectedResult:
      options.expectedResult ??
      `Chromium completes the ${stepId.split(".").at(-1).replaceAll("-", " ")} operator action against isolated Gateway state.`,
  };
}

function externalStep(bundleId, stepId, routeSlug, externalSourceStepNames) {
  return step(bundleId, stepId, routeSlug, [api("external-sources-browser-flow")], {
    external: true,
    ownerScenarioId: "usability.external-sources",
    externalSourceStepNames,
  });
}

function click(name, options = {}) {
  return { kind: "click", name, exact: true, ...options };
}

function clickPattern(namePattern) {
  return { kind: "click-pattern", namePattern };
}

function waitEnabled(name, exact = true) {
  return { kind: "wait-enabled", name, exact };
}

function confirm(name) {
  return { kind: "confirm", name };
}

function fill(label, value) {
  return { kind: "fill", label, value };
}

function fixtureSession(sessionKey) {
  return { kind: "fixture-session", sessionKey };
}

function select(label, optionLabel) {
  return { kind: "select", label, optionLabel };
}

function checkPattern(namePattern) {
  return { kind: "check-pattern", namePattern };
}

function uncheckPattern(namePattern) {
  return { kind: "uncheck-pattern", namePattern };
}

function assertChecked(namePattern, checked) {
  return { kind: "assert-checked", namePattern, checked };
}

function binaryFile(name, fileName, mimeType, contentBase64) {
  return { kind: "file", name, fileName, mimeType, encoding: "base64", contentBase64 };
}

function loadedImage(name) {
  return { kind: "assert-image-loaded", name };
}

function reload() {
  return { kind: "reload" };
}

function text(value, options = {}) {
  return { kind: "assert-text", value, ...options };
}

function textPattern(valuePattern) {
  return { kind: "assert-text-pattern", valuePattern };
}

function textAbsent(value) {
  return { kind: "assert-text-absent", value };
}

function control(name) {
  return { kind: "assert-control", name, exact: true };
}

function download(name, options) {
  return { kind: "download", name, exact: true, ...options };
}

function value(label, expectedValue) {
  return { kind: "assert-value", label, value: expectedValue };
}

function tableText(tableName, value) {
  return { kind: "assert-table-text", tableName, value };
}

function api(probe) {
  return { kind: "api", probe };
}

function dedicated(scenarioId, contract) {
  return Object.freeze({ mode: "dedicated-scenario", scenarioIds: [scenarioId], requireArtifacts: true, contract });
}
