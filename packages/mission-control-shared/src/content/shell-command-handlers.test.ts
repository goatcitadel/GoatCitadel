import { describe, expect, it } from "vitest";
import { handleCommand } from "./shell-command-handlers.js";

describe("handleCommand: git", () => {
  it("decodes git push --force origin main", () => {
    const r = handleCommand(["git", "push", "--force", "origin", "main"]);
    expect(r.program).toBe("git");
    expect(r.summary).toContain("Force-push");
    expect(r.summary).toContain("main");
    expect(r.summary).toContain("origin");
    expect(r.details.some((d) => d.label === "Force" && d.value === "true")).toBe(true);
    expect(r.risks.some((x) => x.label === "Force-push")).toBe(true);
  });

  it("decodes git push --force-with-lease distinctly", () => {
    const r = handleCommand(["git", "push", "--force-with-lease", "origin", "main"]);
    expect(r.summary).toContain("with lease");
    expect(r.risks.some((x) => x.label === "Force-push with lease")).toBe(true);
  });

  it("decodes plain git push without force risk", () => {
    const r = handleCommand(["git", "push", "origin", "main"]);
    expect(r.risks.find((x) => x.label === "Force-push")).toBeUndefined();
  });

  it("flags git reset --hard", () => {
    const r = handleCommand(["git", "reset", "--hard", "HEAD~1"]);
    expect(r.risks.some((x) => x.label === "Hard reset")).toBe(true);
  });
});

describe("handleCommand: rm", () => {
  it("decodes rm -rf with target", () => {
    const r = handleCommand(["rm", "-rf", "/tmp/test"]);
    expect(r.details.some((d) => d.label === "Recursive" && d.value === "true")).toBe(true);
    expect(r.details.some((d) => d.label === "Force" && d.value === "true")).toBe(true);
    expect(r.details.some((d) => d.label === "Target" && d.value === "/tmp/test")).toBe(true);
    expect(r.risks.some((x) => x.label === "Recursive delete")).toBe(true);
  });

  it("flags rm -rf / with filesystem-root finding", () => {
    const r = handleCommand(["rm", "-rf", "/"]);
    expect(r.risks.some((x) => x.label === "Filesystem root")).toBe(true);
  });

  it("accepts combined and split flag forms", () => {
    const r1 = handleCommand(["rm", "-rf", "x"]);
    const r2 = handleCommand(["rm", "-r", "-f", "x"]);
    const r3 = handleCommand(["rm", "-fr", "x"]);
    for (const r of [r1, r2, r3]) {
      expect(r.details.some((d) => d.label === "Recursive")).toBe(true);
      expect(r.details.some((d) => d.label === "Force")).toBe(true);
    }
  });
});

describe("handleCommand: curl", () => {
  it("flags -k insecure", () => {
    const r = handleCommand(["curl", "-k", "https://e.com"]);
    expect(r.risks.some((x) => x.label === "Skip TLS verification")).toBe(true);
  });

  it("extracts URL into details", () => {
    const r = handleCommand(["curl", "https://example.com/x"]);
    expect(r.details.some((d) => d.label === "URL" && d.value === "https://example.com/x")).toBe(true);
  });
});

describe("handleCommand: pnpm", () => {
  it("recognizes pnpm install with no args as workspace install", () => {
    const r = handleCommand(["pnpm", "install"]);
    expect(r.summary).toContain("workspace dependencies");
    expect(r.risks).toEqual([]);
  });

  it("flags pnpm add --global as caution", () => {
    const r = handleCommand(["pnpm", "add", "lodash", "--global"]);
    expect(r.risks.some((x) => x.label === "Global install")).toBe(true);
  });
});

describe("handleCommand: ssh", () => {
  it("flags root login", () => {
    const r = handleCommand(["ssh", "root@host"]);
    expect(r.risks.some((x) => x.label === "Root login")).toBe(true);
  });
});

describe("handleCommand: generic fallback", () => {
  it("returns Action/Args for unknown program", () => {
    const r = handleCommand(["my-tool", "--flag", "value"]);
    expect(r.program).toBe("my-tool");
    expect(r.summary).toContain("Run my-tool");
  });
});
