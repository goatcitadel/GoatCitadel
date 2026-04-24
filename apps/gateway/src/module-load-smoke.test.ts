import { describe, expect, it } from "vitest";

describe("gateway module load smoke", () => {
  it("loads core route and service modules without import-time failures", async () => {
    const modules = await Promise.all([
      import("./config.js"),
      import("./cors-origin-guard.js"),
      import("./path-guard.js"),
      import("./startup-guard.js"),
      import("./routes/memory.js"),
      import("./routes/files.js"),
      import("./routes/chat.js"),
      import("./routes/durable.js"),
      import("./routes/integrations.js"),
      import("./routes/mcp.js"),
      import("./routes/tasks.js"),
      import("./routes/tools.js"),
      import("./routes/dashboard.js"),
      import("./services/llm-service.js"),
      import("./services/security-utils.js"),
      import("./services/obsidian-vault-service.js"),
      import("./services/skill-import-service.js"),
    ]);

    expect(modules.length).toBeGreaterThan(10);
  }, 30_000);
});
