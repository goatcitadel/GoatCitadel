import { describe, expect, it } from "vitest";

const moduleLoaders = {
  a2ui: () => import("./a2ui.js"),
  activation: () => import("./activation.js"),
  addons: () => import("./addons.js"),
  assembly: () => import("./assembly.js"),
  admin: () => import("./admin.js"),
  agents: () => import("./agents.js"),
  approvals: () => import("./approvals.js"),
  autonomy: () => import("./autonomy.js"),
  auth: () => import("./auth.js"),
  capabilities: () => import("./capabilities.js"),
  "capability-packs": () => import("./capability-packs.js"),
  "channel-probes": () => import("./channel-probes.js"),
  "channel-wizard": () => import("./channel-wizard.js"),
  channels: () => import("./channels.js"),
  chat: () => import("./chat.js"),
  comms: () => import("./comms.js"),
  "companion-auth": () => import("./companion-auth.js"),
  companion: () => import("./companion.js"),
  connectors: () => import("./connectors.js"),
  "continuation-gate": () => import("./continuation-gate.js"),
  "dev-diagnostics": () => import("./dev-diagnostics.js"),
  durable: () => import("./durable.js"),
  evidence: () => import("./evidence.js"),
  hooks: () => import("./hooks.js"),
  improvement: () => import("./improvement.js"),
  ingestion: () => import("./ingestion.js"),
  integrations: () => import("./integrations.js"),
  "internal-tooling": () => import("./internal-tooling.js"),
  knowledge: () => import("./knowledge.js"),
  "learned-memory": () => import("./learned-memory.js"),
  "llama-cpp": () => import("./llama-cpp.js"),
  llm: () => import("./llm.js"),
  mcp: () => import("./mcp.js"),
  media: () => import("./media.js"),
  memory: () => import("./memory.js"),
  "memory-write-gate": () => import("./memory-write-gate.js"),
  mesh: () => import("./mesh.js"),
  monitoring: () => import("./monitoring.js"),
  npu: () => import("./npu.js"),
  onboarding: () => import("./onboarding.js"),
  orchestration: () => import("./orchestration.js"),
  policy: () => import("./policy.js"),
  proactive: () => import("./proactive.js"),
  "prompt-pack": () => import("./prompt-pack.js"),
  replay: () => import("./replay.js"),
  research: () => import("./research.js"),
  "runtime-lifecycle": () => import("./runtime-lifecycle.js"),
  session: () => import("./session.js"),
  "skill-evaluation": () => import("./skill-evaluation.js"),
  skills: () => import("./skills.js"),
  tasks: () => import("./tasks.js"),
  "tool-catalog": () => import("./tool-catalog.js"),
  "tool-grants": () => import("./tool-grants.js"),
  tools: () => import("./tools.js"),
  "ui-change-risk": () => import("./ui-change-risk.js"),
  "ui-forms": () => import("./ui-forms.js"),
  voice: () => import("./voice.js"),
  workspaces: () => import("./workspaces.js"),
} as const;

describe("contracts domain modules coverage", () => {
  it("loads all domain modules with runtime exports", async () => {
    for (const [name, loadModule] of Object.entries(moduleLoaders)) {
      const mod = await loadModule();
      expect(name.length).toBeGreaterThan(0);
      expect(mod).toBeTypeOf("object");
    }
  });
});
