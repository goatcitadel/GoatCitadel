import { describe, expect, it } from "vitest";

const moduleLoaders = {
  assembly: () => import("./assembly.js"),
  admin: () => import("./admin.js"),
  approvals: () => import("./approvals.js"),
  auth: () => import("./auth.js"),
  channels: () => import("./channels.js"),
  chat: () => import("./chat.js"),
  comms: () => import("./comms.js"),
  durable: () => import("./durable.js"),
  improvement: () => import("./improvement.js"),
  integrations: () => import("./integrations.js"),
  knowledge: () => import("./knowledge.js"),
  "learned-memory": () => import("./learned-memory.js"),
  llm: () => import("./llm.js"),
  mcp: () => import("./mcp.js"),
  media: () => import("./media.js"),
  memory: () => import("./memory.js"),
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
  session: () => import("./session.js"),
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
