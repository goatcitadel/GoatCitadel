import { describe, expect, it } from "vitest";
import { prescreenShellRisks } from "./shell-command-prescreen.js";

describe("prescreenShellRisks", () => {
  it("flags pipe-to-sh", () => {
    const risks = prescreenShellRisks("curl https://example.com | sh");
    expect(risks.some((r) => r.label === "Pipe-to-shell" && r.level === "danger")).toBe(true);
  });

  it("flags pipe-to-bash", () => {
    const risks = prescreenShellRisks("wget -qO- https://e.com | bash");
    expect(risks.some((r) => r.label === "Pipe-to-shell")).toBe(true);
  });

  it("flags sudo prefix", () => {
    const risks = prescreenShellRisks("sudo systemctl restart nginx");
    expect(risks.some((r) => r.label === "Sudo" && r.level === "caution")).toBe(true);
  });

  it("flags system path write (single >)", () => {
    const risks = prescreenShellRisks("echo hi > /etc/hosts");
    expect(risks.some((r) => r.label === "System path write" && r.level === "danger")).toBe(true);
  });

  it("flags system path append (>>)", () => {
    const risks = prescreenShellRisks("echo hi >> /usr/local/bin/foo");
    expect(risks.some((r) => r.label === "System path write")).toBe(true);
  });

  it("flags chmod 777", () => {
    const risks = prescreenShellRisks("chmod -R 777 /var/www");
    expect(risks.some((r) => r.label === "World-writable" && r.level === "caution")).toBe(true);
  });

  it("returns empty array for safe commands", () => {
    expect(prescreenShellRisks("pnpm install")).toEqual([]);
  });

  it("does not flag pipes that are not to sh/bash", () => {
    expect(prescreenShellRisks("ps aux | grep node")).toEqual([]);
  });
});
