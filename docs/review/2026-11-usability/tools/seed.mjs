// Seeds the usability-review sandbox. Usage: node docs/review/2026-11-usability/tools/seed.mjs <gatewayUrl>
// 1. POST /api/v1/demo/bootstrap (two pending approvals)
// 2. scripts/verification/lib/scenarios/fixture-seeding.mjs (stops at the Ops board step under auth "none": 403)
// 3. Finishes by hand what comes after the Ops board: memory admin flag, memory item, file, prompt pack.
// Prints one JSON object with the ids it produced. Review only: it writes through the sandbox Gateway API.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

const gatewayUrl = process.argv[2];
if (!gatewayUrl) {
  console.error("usage: node seed.mjs <gatewayUrl>");
  process.exit(2);
}
const root = process.cwd();
const lib = (rel) => pathToFileURL(path.join(root, "scripts", "verification", "lib", rel)).href;
const { requestJson, delay } = await import(lib("runtime.mjs"));
const { seedMissionControlNextFixture, settleApprovedSettingsChangePlan } = await import(
  lib("scenarios/fixture-seeding.mjs")
);

class StepError extends Error {
  constructor(label, response) {
    super(`${label}: HTTP ${response?.status} ${JSON.stringify(response?.body)?.slice(0, 300)}`);
    this.label = label;
    this.status = response?.status;
  }
}
const assertOk = (response, label) => {
  if (!response?.ok) throw new StepError(label, response);
};
const deps = {
  assertOk,
  delay,
  randomUUID,
  requestJson,
  stabilizeMissionControlNextFileFixtureMtime: async () => {},
};
const out = { notes: [] };

const demo = await requestJson(gatewayUrl, "/api/v1/demo/bootstrap", { method: "POST" });
out.demoBootstrap = { status: demo.status, body: demo.body };

let seeded = null;
try {
  seeded = await seedMissionControlNextFixture(gatewayUrl, { runtimeRoot: undefined }, deps);
} catch (error) {
  out.notes.push(`fixture seeding stopped: ${error.message}`);
  if (!/Ops board/i.test(error.message)) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
}

if (seeded) {
  // The fixture completed (the Ops board step did not 403 in the testbench): nothing to finish by hand.
  out.seeded = seeded;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// Manual finish for the steps after the Ops board.
const settings = await requestJson(gatewayUrl, "/api/v1/settings");
if (settings.body?.features?.memoryLifecycleAdminV1Enabled !== true) {
  const patched = await requestJson(gatewayUrl, "/api/v1/settings", {
    method: "PATCH",
    body: { expectedRevision: settings.body.revision, features: { memoryLifecycleAdminV1Enabled: true } },
  });
  out.memoryAdminFlag = { status: patched.status };
  const receipt = patched.body?.changePlanReceipt;
  const action = receipt?.requiredAction;
  if (receipt?.status === "awaiting_approval" && action?.approvalId) {
    const approved = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(action.approvalId)}/resolve`, {
      method: "POST",
      body: { decision: "approve", resolutionNote: "Seeding the usability-review sandbox." },
    });
    out.memoryAdminFlag.approve = approved.status;
    await settleApprovedSettingsChangePlan(gatewayUrl, receipt.planId, deps);
  }
}
const workspaceId = seeded?.workspaceId ?? (await requestJson(gatewayUrl, "/api/v1/workspaces")).body?.items?.[0]?.workspaceId;
out.workspaceId = workspaceId;
const memory = await requestJson(gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
  method: "POST",
  body: {
    workspaceId,
    namespace: "mission-control-next",
    title: "Mission Control Next shell posture",
    content: "Chat owns conversation, structured agentic work, and governed code-capability context.",
    metadata: { tags: ["verification", "ui"], source: "verification" },
  },
});
out.memory = { status: memory.status, itemId: memory.body?.itemId };
const upload = await requestJson(gatewayUrl, "/api/v1/files/upload", {
  method: "POST",
  body: {
    relativePath: "workspace/verification/mission-control-next-proof.md",
    content: "# Mission Control Next\n\n- Seeded for visual proof.\n- Safe to overwrite.\n",
  },
});
out.file = { status: upload.status };
const pack = await requestJson(gatewayUrl, "/api/v1/prompt-packs/import", {
  method: "POST",
  body: {
    name: "Mission Control Next Verification Pack",
    sourceLabel: "verification",
    content: [
      "[TEST-01] Mission Control Next shell posture",
      "Confirm the new shell is calmer than the legacy frame.",
      "",
      "[TEST-02] Context panel posture",
      "Explain what the context panel should reveal without overwhelming the operator.",
    ].join("\n"),
  },
});
out.promptPack = { status: pack.status };
out.seeded = seeded;
console.log(JSON.stringify(out, null, 2));
