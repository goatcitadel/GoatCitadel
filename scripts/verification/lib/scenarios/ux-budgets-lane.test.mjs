import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NEXT_RELEASE_SURFACE_MANIFEST, resolveReleaseSurfaceHref } from "../release-surface-manifest.mjs";
import { classicManifestEntry } from "./ux-budget-measurements.mjs";
import {
  COCKPIT_ROUTES,
  UX_BUDGET_ENFORCEMENT_DEFAULTS,
  UX_BUDGET_ROUTE_SLUGS,
  selectCockpitOwnerProofs,
  runUxBudgetsLane,
} from "./ux-budgets-lane.mjs";
import { runCockpitMcpRegistrationProof } from "./cockpit-mcp-registration-proof.mjs";
import { runCockpitCitadelDirectoryProof } from "./cockpit-citadel-directory-proof.mjs";
import { runCockpitWorkspacesProof } from "./cockpit-workspaces-proof.mjs";
import { runCockpitProviderManagementProof } from "./cockpit-provider-management-proof.mjs";
import { runCockpitChatBackgroundActiveProof } from "./cockpit-chat-background-active-proof.mjs";
import { runCockpitCommandPaletteProof } from "./cockpit-command-palette-proof.mjs";
import { runCockpitInboxViewedProof } from "./cockpit-inbox-viewed-proof.mjs";
import { runCockpitShellControlsProof } from "./cockpit-shell-controls-proof.mjs";
import { runCockpitLongListsProof } from "./cockpit-long-lists-proof.mjs";

const runSource = readFileSync(new URL("../../run.mjs", import.meta.url), "utf8");
const scenariosSource = readFileSync(new URL("../scenarios.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));

describe("UX budget lane wiring", () => {
  it("preserves every owner selector and serial registration order through the public facade", () => {
    const keys = [
      "command-palette",
      "inbox-viewed",
      "hooks",
      "capability-scopes",
      "addons",
      "portable-packs",
      "schedule-lifecycle",
      "task-lifecycle",
      "mcp-mode-previews",
      "first-run-advanced",
      "chat-background-active",
      "permission-management",
      "integration-meet",
      "notification-routing",
      "citadel-vault",
      "citadel-council",
      "citadel-wards",
      "mcp-oauth",
      "citadel-mason",
      "integration-management",
      "citadel-overview",
      "runtime-controls",
      "mcp-connection",
      "llama-setup",
      "channels",
      "gateway-auth",
      "citadel-blueprint",
      "mcp-policy-requests",
      "provider-connection",
      "work-artifact",
      "library-links",
      "library-policy",
      "work-context",
      "work-lineage",
      "approval-mode",
      "health-runtime",
      "device-access",
      "personality",
      "workspaces",
      "integration-connections",
      "managed-runtime",
      "mcp-servers",
      "library-resources",
      "chat-thread-actions",
      "chat-artifact-edit",
      "appearance",
      "permission-profile",
      "system-quality",
      "settings-tabs",
      "trust-policy",
      "local-ai",
      "mcp-editor",
      "tool-grants",
      "mcp-registration",
      "citadel-directory",
      "provider-management",
      "shell-controls",
      "long-lists",
    ];
    assert.deepEqual(
      selectCockpitOwnerProofs(),
      keys.flatMap((key) => selectCockpitOwnerProofs([key])),
    );
    assert.equal(new Set(selectCockpitOwnerProofs()).size, keys.length);
    const lane = readFileSync(new URL("./ux-budgets-lane.mjs", import.meta.url), "utf8");
    assert.deepEqual(
      [...lane.matchAll(/await (runUxBudget\w+)\(environment\)/g)].map((match) => match[1]),
      [
        "runUxBudgetRoutes",
        "runUxBudgetIdleTraffic",
        "runUxBudgetInboxProposals",
        "runUxBudgetInboxChanges",
        "runUxBudgetInboxWaits",
        "runUxBudgetChat",
        "runUxBudgetOwnerExtensions",
        "runUxBudgetWork",
        "runUxBudgetBoards",
      ],
    );
  });

  it("retains owned stack and stub cleanup and package restoration if fixture setup fails", async () => {
    const calls = [],
      stack = { gatewayUrl: "owned-gateway", runtimeRoot: "owned-runtime" };
    const error = new Error("fixture unavailable");
    await assert.rejects(
      runUxBudgetsLane(
        { runId: "owned-run" },
        {
          prepareCleanRuntime: async () => "owned-runtime",
        },
        {
          NEXT_UI_PACKAGE: "owned-ui",
          forceVerificationUiPackage: () => () => {
            calls.push("restore package");
          },
          startDeterministicLlmStub: async () => ({
            baseUrl: "owned-provider",
            close: async () => {
              calls.push("close stub");
            },
          }),
          startVerificationStack: async (_context, options) => {
            assert.equal(options.runtimeRoot, "owned-runtime");
            assert.equal(options.gatewayMode, "built");
            assert.equal(options.uiMode, "preview");
            return stack;
          },
          ensureOnboardingComplete: async () => {},
          seedMissionControlNextFixture: async () => {
            throw error;
          },
          stopVerificationStack: async (actual) => {
            assert.equal(actual, stack);
            calls.push("stop stack");
          },
        },
      ),
      (candidate) => candidate === error,
    );
    assert.deepEqual(calls, ["stop stack", "close stub", "restore package"]);
  });
  it("allows focused reruns without silently accepting an empty or unknown proof", () => {
    assert.equal(selectCockpitOwnerProofs().length, 58);
    assert.equal(selectCockpitOwnerProofs(["approval-mode", "approval-mode"]).length, 1);
    assert.throws(() => selectCockpitOwnerProofs([]));
    assert.throws(() => selectCockpitOwnerProofs(["wrong-name"]));
  });
  it("selects the actual active child lifecycle proof", () => {
    assert.deepEqual(selectCockpitOwnerProofs(["chat-background-active"]), [runCockpitChatBackgroundActiveProof]);
  });
  it("selects scoped command search and explicit viewed-update proofs", () => {
    assert.deepEqual(selectCockpitOwnerProofs(["command-palette", "inbox-viewed"]), [
      runCockpitCommandPaletteProof,
      runCockpitInboxViewedProof,
    ]);
  });
  it("selects actual shell geometry and bounded list owner proofs", () => {
    assert.deepEqual(selectCockpitOwnerProofs(["shell-controls", "long-lists"]), [
      runCockpitShellControlsProof,
      runCockpitLongListsProof,
    ]);
    const source = readFileSync(new URL("./ux-budget-owner-extensions.mjs", import.meta.url), "utf8");
    assert.match(source, /await runCockpitShellControlsProof\(/);
    assert.match(source, /await runCockpitLongListsProof\(/);
  });
  it("selects the native directory and MCP registration proofs with the extended workspace owner", () => {
    assert.deepEqual(
      selectCockpitOwnerProofs(["citadel-directory", "mcp-registration", "workspaces", "provider-management"]),
      [
        runCockpitCitadelDirectoryProof,
        runCockpitMcpRegistrationProof,
        runCockpitWorkspacesProof,
        runCockpitProviderManagementProof,
      ],
    );
  });
  it("measures routes in the release surface manifest", () => {
    const known = new Set(NEXT_RELEASE_SURFACE_MANIFEST.map((entry) => entry.slug));
    for (const slug of UX_BUDGET_ROUTE_SLUGS) assert.ok(known.has(slug), slug);
  });

  it("pins release-manifest budgets to Classic now that Cockpit is the default", () => {
    for (const slug of UX_BUDGET_ROUTE_SLUGS) {
      const entry = classicManifestEntry(slug);
      assert.equal(entry.shell, "classic", slug);
      const href = new URL(resolveReleaseSurfaceHref(entry, {}, {}), "http://verification.invalid");
      assert.equal(href.searchParams.get("shell"), "classic", slug);
      assert.equal(href.searchParams.has("shellScope"), false, slug);
    }
    assert.match(
      readFileSync(new URL("./ux-budget-routes.mjs", import.meta.url), "utf8"),
      /`\/chat\?shell=classic&sessionId=/,
    );
  });

  it("measures each cockpit area and the component gallery", () => {
    assert.deepEqual(COCKPIT_ROUTES, [
      "/chat",
      "/inbox",
      "/work",
      "/work/history",
      "/work/schedules",
      "/library",
      "/system",
      "/system/spend",
      "/system/quality",
      "/system/diagnostics",
      "/system/activity",
      "/system/dashboards",
      "/settings/general",
      "/settings/models",
      "/settings/first-run",
      "/__gallery",
    ]);
  });

  it("enforces the Chat viewport and sidebar budgets", () => {
    assert.deepEqual(UX_BUDGET_ENFORCEMENT_DEFAULTS, { chatBudget: true, railReach: true });
    assert.match(
      readFileSync(new URL("./ux-budget-chat.mjs", import.meta.url), "utf8"),
      /ux-budgets\.cockpit-chat-space\.\$\{variant\}/,
    );
  });

  it("reviews seeded Inbox memory proposals at desktop and phone widths", () => {
    const source = readFileSync(new URL("./ux-budget-inbox-proposals.mjs", import.meta.url), "utf8");
    assert.match(source, /ux-budgets\.cockpit-inbox-memory-review\.\$\{variant\}/);
    assert.match(source, /The canonical memory proposal did not record rejection/);
  });

  it("checks a persisted completed background run and rejects a forged watcher on both viewports", () => {
    const source = readFileSync(new URL("./ux-budget-inbox-waits.mjs", import.meta.url), "utf8");
    assert.match(source, /ux-budgets\.cockpit-inbox-background-update\.\$\{variant\}/);
    assert.match(source, /Inbox did not project only the verified completed background run/);
    assert.match(source, /Forged background watcher appeared in the Inbox/);
  });

  it("is reachable from the verification CLI and package script", () => {
    assert.match(runSource, /lane === "ux-budgets"/);
    assert.match(scenariosSource, /export async function runUxBudgetsLane\(/);
    assert.equal(packageJson.scripts["verify:ux:budgets"], "node scripts/verification/run.mjs ux-budgets");
  });

  it("runs provider inspection against the isolated stub at both supported widths", () => {
    const source = readFileSync(new URL("./ux-budget-owner-extensions.mjs", import.meta.url), "utf8");
    assert.match(
      source,
      /await runCockpitProviderCatalogProof\(\{\s*context,\s*browser,\s*stack,\s*fixture,\s*providerId: stub\.providerId,\s*viewports: CHAT_VIEWPORTS,\s*deps,?\s*\}\)/,
    );
  });
});
