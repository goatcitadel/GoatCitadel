import fs from "node:fs/promises";
import path from "node:path";

import {
  NEXT_RELEASE_SURFACE_MANIFEST,
  resolveDirectCompatibilityManifest,
  resolveLegacyRedirectManifest,
} from "../release-surface-manifest.mjs";
import {
  browserActionProofBindingsFor,
  validateBrowserActionProofContract,
} from "./usability-browser-action-registry.mjs";

const NEXT_UI_PACKAGE = "@goatcitadel/mission-control-next";

const ROUTE_TEST_REFS_BY_SLUG = Object.freeze({
  chat: [
    "apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.test.tsx",
    "apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx",
    "packages/threaded-surface-core/src/chat-thread-reducer.test.ts",
  ],
  projects: ["apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.test.tsx"],
  "library-skills": ["apps/mission-control-next/src/features/native-routes/library/SkillHubOperatorPanel.test.tsx"],
  "library-memory": ["apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.test.tsx"],
  "library-journey": ["apps/mission-control-next/src/features/native-routes/library/JourneyTimelineRoutePage.test.tsx"],
  "library-knowledge": [
    "apps/mission-control-next/src/features/native-routes/library/LibraryExternalSourcesSection.test.tsx",
  ],
  "library-prompt-packs": ["apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.test.tsx"],
  "library-curator": ["apps/mission-control-next/src/features/native-routes/library/CuratorRoutePage.test.tsx"],
  "library-citadel": ["apps/mission-control-next/src/features/native-routes/library/CitadelMasonRoutePage.test.tsx"],
  "library-citadel-overview": [
    "apps/mission-control-next/src/features/native-routes/library/CitadelOverviewRoutePage.test.tsx",
  ],
  "library-citadel-wards": [
    "apps/mission-control-next/src/features/native-routes/library/CitadelWardsRoutePage.test.tsx",
  ],
  "library-citadel-council": [
    "apps/mission-control-next/src/features/native-routes/library/CitadelCouncilRoutePage.test.tsx",
  ],
  "library-citadel-blueprint": [
    "apps/mission-control-next/src/features/native-routes/library/CitadelBlueprintRoutePage.test.tsx",
  ],
  "library-citadel-vault": [
    "apps/mission-control-next/src/features/native-routes/library/CitadelVaultRoutePage.test.tsx",
  ],
  "ops-boards": ["apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.test.tsx"],
  "ops-sessions": ["apps/mission-control-next/src/features/native-routes/ops/SessionControlPanel.test.tsx"],
  "ops-kanban": ["apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx"],
  "ops-approvals": ["apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.test.tsx"],
  "ops-runtime": ["apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.test.tsx"],
  "settings-trust-policy": [
    "apps/mission-control-next/src/features/native-routes/settings/sections/TrustPolicySection.test.tsx",
  ],
  "settings-permissions": [
    "apps/mission-control-next/src/features/native-routes/settings/sections/CapabilityScopePanel.test.tsx",
  ],
  "ops-notifications": [
    "apps/mission-control-next/src/features/native-routes/settings/sections/NotificationRoutingPanel.test.tsx",
  ],
});

const DEFAULT_NATIVE_ROUTE_TEST_REFS = Object.freeze([
  "apps/mission-control-next/src/features/native-routes/NativeRoutePages.coverage.test.tsx",
  "apps/mission-control-next/src/features/native-routes/NativeRoutePages.test.tsx",
]);

const DEFAULT_SETTINGS_TEST_REFS = Object.freeze([
  "apps/mission-control-next/src/features/native-routes/SettingsNativePage.coverage.test.tsx",
  "apps/mission-control-next/src/features/native-routes/SettingsNativePage.test.tsx",
]);

export const EXPECTED_USABILITY_SURFACE_COUNTS = Object.freeze({
  routes: 48,
  shipped: 42,
  experimental: 6,
  redirects: 20,
  directCompatibility: 3,
});

export const ROUTE_ACTIONS_BY_SLUG = Object.freeze({
  chat: [
    "send-stream",
    "stop-and-retry",
    "edit-and-branch",
    "attachments-citations-tools",
    "planning-delegation-synthesis",
    "approval-and-user-input-resume",
    "durable-restart-resume",
    "code-mode-artifacts",
  ],
  projects: ["workspace-project-crud", "revision-conflict"],
  "library-agents": ["agent-crud", "agent-default-tool-profile"],
  "library-skills": ["skill-inspect-activate-deactivate", "skill-provenance"],
  "library-capabilities": ["inspectable-callable-catalogs", "candidate-proposal-lifecycle"],
  "library-memory": ["memory-edit-pin-forget-history", "memory-scope-and-provenance"],
  "library-journey": ["journey-event-detail", "experimental-label-and-safe-failure"],
  "library-knowledge": ["external-source-register-scan-import", "chat-attach-and-governed-copy"],
  "library-notes": ["note-crud-and-conflict"],
  "library-communications": ["communication-list-and-agenda", "approval-gated-draft-no-send"],
  "library-files": ["file-list-upload-download"],
  "library-artifacts": ["artifact-list-detail-download"],
  "library-prompt-packs": ["author-edit", "run-selected-and-all", "compare-review-export"],
  "library-curator": ["curator-inspection", "experimental-label-and-safe-failure"],
  "library-citadel": ["citadel-create-and-isolation"],
  "library-citadel-overview": ["citadel-charter-lifecycle"],
  "library-citadel-wards": ["ward-create-delete-and-evaluate"],
  "library-citadel-council": ["council-seat-and-remove"],
  "library-citadel-blueprint": ["blueprint-edit-export"],
  "library-citadel-vault": ["vault-secret-status-and-governance"],
  "ops-boards": ["board-crud-and-widgets"],
  "ops-activity": ["activity-filter-and-detail", "realtime-reconnect"],
  "ops-sessions": ["session-list-detail-control"],
  "ops-schedules": ["schedule-create-list-cancel-and-run"],
  "ops-improvement": ["improvement-review", "experimental-label-and-safe-failure"],
  "ops-notifications": ["notification-target-rule-crud", "notification-test-and-operator-policy"],
  "ops-approvals": ["approval-approve-deny", "approval-resume-canonical-run"],
  "ops-costs": ["cost-filter-and-budget-truth"],
  "ops-quality": ["quality-evidence-and-status"],
  "ops-runtime": ["runtime-health-and-owner-truth", "restart-recovery"],
  "ops-diagnostics": ["diagnostic-list-detail-export", "backup-recovery-entry"],
  "ops-kanban": ["task-board-lifecycle", "experimental-label-and-safe-failure"],
  "settings-general": ["interface-preferences-persist-across-reload"],
  "settings-onboarding": ["onboarding-complete-and-revisit"],
  "settings-providers": ["provider-activate-model-select", "oauth-status-and-invalid-credential"],
  "settings-personalities": ["personality-inspection", "experimental-label-and-safe-failure"],
  "settings-access": ["token-basic-device-grants", "revoked-and-persisted-credentials"],
  "settings-permissions": ["permission-profile-crud", "deny-wins-preview"],
  "settings-trust-policy": ["trust-policy-inspection-and-owner-handoff"],
  "settings-runtime": ["runtime-settings-update-and-conflict"],
  "settings-local-ai": ["hardware-readiness-and-not-configured-reason"],
  "settings-workspaces": ["workspace-create-select-archive-restore", "workspace-isolation"],
  "settings-budget": ["budget-mode-update-and-conflict"],
  "settings-addons": ["addon-inspection", "experimental-label-and-safe-failure"],
  "settings-integrations": ["integration-validation-and-diagnostics", "sandbox-destination"],
  "settings-channels": ["channel-validation-and-diagnostics", "sandbox-destination"],
  "settings-mcp": ["mcp-server-tool-grant-lifecycle", "unsupported-transport-truth"],
  "settings-tools": ["tool-catalog-and-grants", "approval-and-policy-boundary"],
});

export function buildUsabilityRouteActionInventory(baseSha, sourceState) {
  assertRouteActionDefinitions();
  const redirects = resolveLegacyRedirectManifest(NEXT_UI_PACKAGE);
  const directCompatibility = resolveDirectCompatibilityManifest(NEXT_UI_PACKAGE);
  const rows = [];

  for (const route of NEXT_RELEASE_SURFACE_MANIFEST) {
    rows.push({
      journeyId: `route.${route.slug}`,
      stepId: `route.${route.slug}.navigate-and-render`,
      kind: "route",
      route: route.href,
      releaseStatus: route.releaseStatus,
      action: "navigate-and-render",
      expectedResult: "The canonical route renders from Gateway-backed state without a browser or network failure.",
      proofMode: "browser",
      implementationRefs: routeImplementationRefs(route.slug),
      testRefs: routeTestRefs(route.slug),
      proofBindings: [scenarioBinding(`surface-regression.${route.slug}`)],
      requiredCondition: "always",
      required: true,
    });
    for (const action of ROUTE_ACTIONS_BY_SLUG[route.slug]) {
      rows.push({
        journeyId: `route.${route.slug}`,
        stepId: `route.${route.slug}.${action}`,
        kind: "route-action",
        route: route.href,
        releaseStatus: route.releaseStatus,
        action,
        expectedResult: `The ${action.replaceAll("-", " ")} journey completes against canonical Gateway state and preserves operator feedback.`,
        proofMode: resolveActionProofMode(route.slug, action),
        implementationRefs: routeImplementationRefs(route.slug),
        testRefs: routeTestRefs(route.slug),
        proofBindings: browserActionProofBindingsFor(`route.${route.slug}.${action}`),
        requiredCondition: "always",
        required: true,
      });
    }
  }

  for (const redirect of redirects) {
    rows.push({
      journeyId: "compatibility-redirects",
      stepId: `redirect.${redirect.slug}`,
      kind: "compatibility-redirect",
      route: redirect.href,
      action: "redirect-and-preserve-contract",
      expectedResult: `The compatibility input resolves to ${redirect.expectedPath} without presenting a legacy primary surface.`,
      proofMode: "browser",
      implementationRefs: ["apps/mission-control-next/src/app/legacy-route-adapter.ts"],
      testRefs: ["apps/mission-control-next/src/app/legacy-route-adapter.test.ts"],
      proofBindings: [scenarioBinding(`surface-regression.redirect.${redirect.slug}`)],
      requiredCondition: "always",
      required: true,
    });
  }

  for (const compatibilityPath of directCompatibility) {
    rows.push({
      journeyId: "direct-compatibility-paths",
      stepId: `direct-compatibility.${compatibilityPath.slug}`,
      kind: "direct-compatibility-path",
      route: compatibilityPath.href,
      action: "normalize-direct-path",
      expectedResult: `The direct compatibility path resolves to ${compatibilityPath.expectedPath} without presenting a legacy primary surface.`,
      proofMode: "browser",
      implementationRefs: ["apps/mission-control-next/src/app/route-model.ts"],
      testRefs: directCompatibilityTestRefs(compatibilityPath.slug),
      proofBindings: [scenarioBinding(`surface-regression.direct-compatibility.${compatibilityPath.slug}`)],
      requiredCondition: "always",
      required: true,
    });
  }

  rows.push(
    optionalEnvironmentRow({
      journeyId: "deployment.local-ai-hardware",
      stepId: "environment.local-ai-hardware-execution",
      action: "hardware-backed-local-inference",
      expectedResult: "Compatible optional local-AI hardware executes its vendor-specific smoke when present.",
      requiredCondition: "compatible_local_ai_hardware_present",
      skipReason:
        "Optional vendor hardware is not a release prerequisite; readiness and not-configured behavior remain required route actions.",
      implementationRefs: ["apps/gateway/src/services/npu-sidecar-service.ts"],
    }),
    optionalEnvironmentRow({
      journeyId: "integrations.live-sandbox-destinations",
      stepId: "environment.live-integration-sandbox-delivery",
      action: "credentialed-sandbox-delivery",
      expectedResult: "Credentialed integrations deliver only to explicit sandbox destinations when configured.",
      requiredCondition: "sandbox_integration_credentials_present",
      skipReason:
        "No credentialed external integration is required; deterministic validation, lifecycle, and diagnostics remain required.",
      implementationRefs: ["packages/policy-engine/src/tool-executor.ts"],
    }),
  );

  const counts = countUsabilitySurfaces();
  assertExpectedCounts(counts);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    sourceState: sourceState ?? null,
    source: "scripts/verification/lib/release-surface-manifest.mjs",
    counts: { ...counts, actionRows: rows.length },
    rows,
  };
}

export function countUsabilitySurfaces() {
  const redirects = resolveLegacyRedirectManifest(NEXT_UI_PACKAGE);
  const directCompatibility = resolveDirectCompatibilityManifest(NEXT_UI_PACKAGE);
  return {
    routes: NEXT_RELEASE_SURFACE_MANIFEST.length,
    shipped: NEXT_RELEASE_SURFACE_MANIFEST.filter((route) => route.releaseStatus === "ship").length,
    experimental: NEXT_RELEASE_SURFACE_MANIFEST.filter((route) => route.releaseStatus === "experimental").length,
    redirects: redirects.length,
    directCompatibility: directCompatibility.length,
  };
}

export function appendLiveCapabilityRows(inventory, capabilitySnapshot) {
  if (!inventory || !Array.isArray(inventory.rows)) throw new Error("usability inventory is malformed");
  const inspectable = requireCapabilityProofs(capabilitySnapshot?.inspectable, "inspectable");
  const callable = requireCapabilityProofs(capabilitySnapshot?.callable, "callable");
  const inspectableById = new Map(inspectable.map((item) => [item.capabilityId, item]));
  const callableIds = new Set();

  for (const item of callable) {
    const inspectableItem = inspectableById.get(item.capabilityId);
    if (!inspectableItem)
      throw new Error(`callable capability ${item.capabilityId} is absent from inspectable catalog`);
    assertCapabilityOwner(item);
    assertCapabilityOwner(inspectableItem);
    assertCallableCapability(item);
    assertCallableCapability(inspectableItem);
    callableIds.add(item.capabilityId);
  }

  const dynamicRows = [];
  for (const item of inspectable) {
    assertCapabilityOwner(item);
    const callableItem = callableIds.has(item.capabilityId);
    if ((item.callable === true) !== callableItem) {
      throw new Error(`capability ${item.capabilityId} callable flag disagrees with the callable catalog`);
    }
    dynamicRows.push(capabilityRow(item, "inspectability", false));
    if (callableItem) dynamicRows.push(capabilityRow(item, "callability-governance", true));
  }

  const existingStepIds = new Set(inventory.rows.map((row) => row.stepId));
  for (const row of dynamicRows) {
    if (existingStepIds.has(row.stepId)) throw new Error(`duplicate live capability usability row ${row.stepId}`);
    existingStepIds.add(row.stepId);
    inventory.rows.push(row);
  }
  inventory.counts = {
    ...inventory.counts,
    capabilityInspectableRows: inspectable.length,
    capabilityCallableRows: callable.length,
    capabilityRows: dynamicRows.length,
    actionRows: inventory.rows.length,
  };
  inventory.generatedAt = new Date().toISOString();
  return dynamicRows;
}

export function assertRouteActionDefinitions() {
  const manifestSlugs = NEXT_RELEASE_SURFACE_MANIFEST.map((route) => route.slug).sort();
  const definitionSlugs = Object.keys(ROUTE_ACTIONS_BY_SLUG).sort();
  if (JSON.stringify(manifestSlugs) !== JSON.stringify(definitionSlugs)) {
    const missing = manifestSlugs.filter((slug) => !definitionSlugs.includes(slug));
    const stale = definitionSlugs.filter((slug) => !manifestSlugs.includes(slug));
    throw new Error(`usability route actions are out of sync (missing=${missing.join(",")}; stale=${stale.join(",")})`);
  }
  for (const [slug, actions] of Object.entries(ROUTE_ACTIONS_BY_SLUG)) {
    if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => !action.trim())) {
      throw new Error(`usability route ${slug} has no explicit primary action coverage`);
    }
  }
  validateBrowserActionProofContract(
    Object.entries(ROUTE_ACTIONS_BY_SLUG).flatMap(([slug, actions]) =>
      actions.map((action) => `route.${slug}.${action}`),
    ),
  );
}

export async function collectVerificationSecretEnvKeys(configRoot, env = process.env) {
  const keys = new Set(Object.keys(env).filter(isSensitiveVerificationEnvKey));
  for (const key of [...keys]) {
    if (!/_ENV$/iu.test(key)) continue;
    const referencedKey = env[key]?.trim();
    if (referencedKey && /^[A-Z][A-Z0-9_]+$/u.test(referencedKey)) keys.add(referencedKey);
  }
  await collectConfiguredEnvReferences(configRoot, keys);
  return [...keys].sort();
}

function isSensitiveVerificationEnvKey(key) {
  return (
    /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|WEBHOOK|ACCESS_?KEY)(?:_(?:PATH|FILE|DIR|ENV))?$/iu.test(key) ||
    /(?:^|_)(?:URL|CONNECTION_?STRING)(?:_ENV)?$/iu.test(key) ||
    /(?:^|_)PRIVATE_?KEY(?:_(?:PATH|FILE|BASE64|PEM|PFX|ENV))?$/iu.test(key) ||
    /(?:^|_)CREDENTIALS?(?:_(?:PATH|FILE|JSON|ENV))?$/iu.test(key) ||
    /(?:^|_)(?:CERT|CERTIFICATE)(?:_(?:PATH|FILE|BASE64|PEM|PFX|BUNDLE|ENV))?$/iu.test(key) ||
    /(?:^|_)COOKIE(?:_(?:ID|VALUE|JAR|PATH|FILE|NAME))?$/iu.test(key) ||
    /(?:^|_)SESSION(?:_(?:ID|KEY|TOKEN|SECRET|COOKIE|CREDENTIALS?))?$/iu.test(key) ||
    /^(?:GOATCITADEL_(?:DATABASE|(?:BUNDLED_|TEST_)?POSTGRES)_|DATABASE_|POSTGRES_|DB_)/iu.test(key) ||
    /^PG(?:APPNAME|CHANNELBINDING|CLIENTENCODING|CONNECT_TIMEOUT|DATA|DATABASE|GSSENCMODE|GSSLIB|HOST|HOSTADDR|KRBSRVNAME|LOADBALANCEHOSTS|OPTIONS|PASSFILE|PASSWORD|PORT|REQUIRESSL|SERVICE|SERVICEFILE|SSLCERT|SSLCRL|SSLCRLDIR|SSLCOMPRESSION|SSLKEY|SSLMODE|SSLROOTCERT|TARGETSESSIONATTRS|USER)$/iu.test(
      key,
    ) ||
    /^(?:GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET)$/iu.test(key)
  );
}

function resolveActionProofMode(routeSlug, action) {
  if (action === "experimental-label-and-safe-failure") return "browser-degraded-fixture";
  if (routeSlug === "library-knowledge" || action === "chat-attach-and-governed-copy") {
    return "browser-and-deterministic-fixture";
  }
  if (routeSlug === "chat" && action === "send-stream") return "browser-and-canonical-api";
  return "browser-and-focused-regression";
}

function routeTestRefs(routeSlug) {
  if (ROUTE_TEST_REFS_BY_SLUG[routeSlug]) return [...ROUTE_TEST_REFS_BY_SLUG[routeSlug]];
  if (routeSlug.startsWith("settings-")) return [...DEFAULT_SETTINGS_TEST_REFS];
  return [...DEFAULT_NATIVE_ROUTE_TEST_REFS];
}

function directCompatibilityTestRefs(slug) {
  return [
    slug === "direct-settings-safety"
      ? "apps/mission-control-next/src/app/route-model.loop26.test.ts"
      : "apps/mission-control-next/src/app/route-model.unified-surface.test.ts",
  ];
}

function routeImplementationRefs(routeSlug) {
  if (routeSlug === "chat") {
    return ["apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx"];
  }
  if (routeSlug === "library-prompt-packs") {
    return ["apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx"];
  }
  if (routeSlug.startsWith("settings-")) {
    return ["apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx"];
  }
  return ["apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx"];
}

function scenarioBinding(scenarioId) {
  return { mode: "scenario", scenarioIds: [scenarioId], requireArtifacts: true };
}

function optionalEnvironmentRow(input) {
  return {
    ...input,
    kind: "optional-environment",
    route: null,
    releaseStatus: "optional",
    proofMode: "environment",
    testRefs: [],
    proofBindings: [],
    required: false,
  };
}

function capabilityRow(item, action, callable) {
  const stepId = `capability.${encodeURIComponent(item.capabilityId)}.${action}`;
  return {
    journeyId: `capability.${encodeURIComponent(item.capabilityId)}`,
    stepId,
    kind: "capability-action",
    route: null,
    releaseStatus: "live-configured",
    capabilityId: item.capabilityId,
    action,
    expectedResult: callable
      ? `Capability ${item.capabilityId} is callable only with active lifecycle, owner provenance, and no proposal/candidate identity.`
      : `Capability ${item.capabilityId} is present in the inspectable catalog with owner provenance and truthful callable state.`,
    proofMode: "live-catalog-governance",
    implementationRefs: ["apps/gateway/src/services/capability-system-service.ts"],
    testRefs: ["apps/gateway/src/services/capability-system-service.test.ts"],
    proofBindings: [
      {
        mode: "capability-disposition",
        scenarioIds: ["usability.foundation.chat-send-stream"],
        capabilityIds: [item.capabilityId],
        capabilityAction: action,
        requireArtifacts: true,
      },
    ],
    requiredCondition: "always",
    required: true,
  };
}

function requireCapabilityProofs(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`live ${label} capability catalog is empty`);
  }
  const ids = value.map((item) => item?.capabilityId);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`live ${label} capability catalog contains an empty identity`);
  }
  if (new Set(ids).size !== ids.length)
    throw new Error(`live ${label} capability catalog contains duplicate identities`);
  return value;
}

function assertCapabilityOwner(item) {
  const owner =
    item.sourceProvider ??
    item.sourceRef ??
    item.skillId ??
    item.toolName ??
    item.mesh?.publisherNodeId ??
    item.mesh?.publicationId;
  if (typeof owner !== "string" || !owner.trim()) {
    throw new Error(`live capability ${item.capabilityId} has no owner provenance`);
  }
}

function assertCallableCapability(item) {
  if (item.callable !== true) throw new Error(`callable capability ${item.capabilityId} is not marked callable`);
  if (item.proposalId || item.candidateId) {
    throw new Error(`callable capability ${item.capabilityId} still carries proposal/candidate identity`);
  }
  if (item.lifecycleState && item.lifecycleState !== "approved" && item.lifecycleState !== "trusted") {
    throw new Error(`callable capability ${item.capabilityId} is inactive (${item.lifecycleState})`);
  }
}

function assertExpectedCounts(counts) {
  for (const [key, expected] of Object.entries(EXPECTED_USABILITY_SURFACE_COUNTS)) {
    if (counts[key] !== expected) {
      throw new Error(`usability ${key} count drifted: expected ${expected}, received ${counts[key]}`);
    }
  }
}

async function collectConfiguredEnvReferences(root, output) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectConfiguredEnvReferences(fullPath, output);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    let value;
    try {
      value = JSON.parse(await fs.readFile(fullPath, "utf8"));
    } catch {
      continue;
    }
    walkConfig(value, "", output);
  }
}

function walkConfig(value, key, output) {
  if (typeof value === "string") {
    if (/env$/iu.test(key) && /^[A-Z][A-Z0-9_]+$/u.test(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkConfig(item, key, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    walkConfig(childValue, childKey, output);
  }
}
