import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SkillsService } from "./loader.js";

describe("optional OpenCode skill", () => {
  it("loads into the existing catalog and activates for explicit OpenCode requests", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/bundled");
    const service = new SkillsService([{ source: "bundled", dir }]);
    const loaded = await service.reload();
    const skill = loaded.find((item) => item.name === "opencode");
    expect(skill?.skillId).toBe("bundled:opencode");
    expect(skill?.declaredTools).toContain("shell.exec");
    expect(
      service.resolveActivation({ text: "Use OpenCode to review this project." }).selected.map((item) => item.name),
    ).toContain("opencode");
    expect(service.resolveActivation({ text: "What is the weather?" }).selected.map((item) => item.name)).not.toContain(
      "opencode",
    );
  });
});
