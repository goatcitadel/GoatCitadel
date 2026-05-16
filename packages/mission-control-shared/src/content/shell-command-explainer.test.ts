import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./shell-command-explainer.js";

describe("explainShellCommand — verification cases", () => {
  it("git push --force origin main → danger, force-push detail", () => {
    const r = explainShellCommand("git push --force origin main");
    expect(r.parsed).toBe(true);
    expect(r.highestRisk).toBe("danger");
    expect(r.summary).toMatch(/force-push/i);
    expect(r.details.some((d) => d.label === "Force")).toBe(true);
    expect(r.risks.some((x) => x.label === "Force-push")).toBe(true);
  });

  it("rm -rf /tmp/test → danger", () => {
    const r = explainShellCommand("rm -rf /tmp/test");
    expect(r.highestRisk).toBe("danger");
    expect(r.details.some((d) => d.label === "Recursive")).toBe(true);
    expect(r.details.some((d) => d.label === "Force")).toBe(true);
    expect(r.details.some((d) => d.label === "Target" && d.value === "/tmp/test")).toBe(true);
  });

  it("curl https://example.com | sh → danger pipe-to-shell, URL extracted", () => {
    const r = explainShellCommand("curl https://example.com | sh");
    expect(r.highestRisk).toBe("danger");
    expect(r.risks.some((x) => x.label === "Pipe-to-shell")).toBe(true);
    expect(r.details.some((d) => d.label === "URL" && d.value === "https://example.com")).toBe(true);
  });

  it("pnpm install → info, workspace dependencies", () => {
    const r = explainShellCommand("pnpm install");
    expect(r.highestRisk).toBe("info");
    expect(r.summary).toMatch(/workspace dependencies/i);
    expect(r.risks).toEqual([]);
  });
});

describe("explainShellCommand — extra cases", () => {
  it("git push --force-with-lease origin main → danger w/ lease distinction", () => {
    const r = explainShellCommand("git push --force-with-lease origin main");
    expect(r.summary).toContain("with lease");
    expect(r.risks.some((x) => x.label === "Force-push with lease")).toBe(true);
  });

  it("git push origin main → info, no force", () => {
    const r = explainShellCommand("git push origin main");
    expect(r.highestRisk).toBe("info");
  });

  it("git reset --hard HEAD~1 → danger hard-reset", () => {
    const r = explainShellCommand("git reset --hard HEAD~1");
    expect(r.highestRisk).toBe("danger");
  });

  it("rm -rf / → filesystem-root finding", () => {
    const r = explainShellCommand("rm -rf /");
    expect(r.risks.some((x) => x.label === "Filesystem root")).toBe(true);
  });

  it("curl -k https://example.com → caution insecure", () => {
    const r = explainShellCommand("curl -k https://example.com");
    expect(r.highestRisk).toBe("caution");
  });

  it("pnpm add lodash --global → caution global", () => {
    const r = explainShellCommand("pnpm add lodash --global");
    expect(r.highestRisk).toBe("caution");
  });

  it("sudo systemctl restart nginx → caution sudo", () => {
    const r = explainShellCommand("sudo systemctl restart nginx");
    expect(r.highestRisk).toBe("caution");
    expect(r.risks.some((x) => x.label === "Sudo")).toBe(true);
  });

  it("echo hi > /etc/hosts → danger system-path-write", () => {
    const r = explainShellCommand("echo hi > /etc/hosts");
    expect(r.highestRisk).toBe("danger");
    expect(r.risks.some((x) => x.label === "System path write")).toBe(true);
  });

  it("chmod -R 777 /var/www → caution world-writable", () => {
    const r = explainShellCommand("chmod -R 777 /var/www");
    expect(r.highestRisk).toBe("caution");
  });

  it("empty string → parsed:false, empty", () => {
    const r = explainShellCommand("");
    expect(r.parsed).toBe(false);
    expect(r.summary).toMatch(/empty/i);
    expect(r.risks).toEqual([]);
  });

  it("unmatched quote → parsed:false fallback", () => {
    const r = explainShellCommand('git commit -m "oops');
    expect(r.parsed).toBe(false);
    expect(r.command).toBe('git commit -m "oops');
  });

  it("generic fallback for unknown program", () => {
    const r = explainShellCommand("unknown-cmd --foo bar");
    expect(r.parsed).toBe(true);
    expect(r.program).toBe("unknown-cmd");
    expect(r.summary).toMatch(/Run unknown-cmd with 2 argument/);
  });
});
