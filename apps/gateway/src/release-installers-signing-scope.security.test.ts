import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression coverage for CODEX_FINDING #7 + #10: the Windows release job
// previously declared WINDOWS_SIGN_CERT_BASE64 / WINDOWS_SIGN_CERT_PASSWORD
// at job-level env, exposing them to every step (pnpm install, cargo,
// third-party setup actions). It also resolved signtool via Get-Command,
// which a compromised earlier step could hijack by planting a fake
// signtool.exe on GITHUB_PATH. This test pins:
//   - secrets present only in step-level env of signing steps,
//   - signtool resolved from the Windows SDK install path, not PATH.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workflowPath = path.resolve(__dirname, "..", "..", "..", ".github", "workflows", "release-installers.yml");

describe("release-installers workflow signing-secret scope (codex #7, #10)", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("does NOT expose WINDOWS_SIGN_CERT_BASE64 at job level", () => {
    const jobEnvRegion = workflow.split("strategy:", 2)[0] ?? "";
    expect(jobEnvRegion).not.toMatch(/^\s+WINDOWS_SIGN_CERT_BASE64:\s*\$\{\{\s*secrets\./m);
    expect(jobEnvRegion).not.toMatch(/^\s+WINDOWS_SIGN_CERT_PASSWORD:\s*\$\{\{\s*secrets\./m);
  });

  it("scopes the cert+password references to step-level env only (presence check uses the !='' form)", () => {
    // Four expected references each:
    //   1x in the job-level *_PRESENT boolean (`secrets.X != ''`) — fine, this only leaks a boolean
    //   3x in step-level env on the signing steps (desktop + package identity + installer)
    // No additional references should appear — that would indicate
    // accidental job-level inheritance.
    const baseRefs = workflow.match(/secrets\.WINDOWS_SIGN_CERT_BASE64\b/g) ?? [];
    const passRefs = workflow.match(/secrets\.WINDOWS_SIGN_CERT_PASSWORD\b/g) ?? [];
    expect(baseRefs.length).toBe(4);
    expect(passRefs.length).toBe(4);
    // Crucially: the cert/password should never appear under a top-level
    // job `env:` block as a string value (only as `!= ''` boolean form).
    const jobEnvRegion = workflow.split("strategy:", 2)[0] ?? "";
    expect(jobEnvRegion).toMatch(/_PRESENT:\s*\$\{\{\s*secrets\.WINDOWS_SIGN_CERT_BASE64\s*!=\s*''\s*\}\}/);
    expect(jobEnvRegion).toMatch(/_PRESENT:\s*\$\{\{\s*secrets\.WINDOWS_SIGN_CERT_PASSWORD\s*!=\s*''\s*\}\}/);
  });

  it("does NOT rely on PATH for signtool resolution", () => {
    expect(workflow).not.toMatch(/Get-Command\s+signtool\.exe/);
  });

  it("resolves signtool from the Windows 10/11 SDK install path", () => {
    expect(workflow).toContain("Windows Kits\\10\\bin");
  });

  it("does not sign manual allow_unsigned smoke artifacts even when signing secrets exist", () => {
    const publicReleaseSigningCondition =
      "if: ${{ (github.event_name != 'workflow_dispatch' || github.event.inputs.allow_unsigned != 'true') && env.WINDOWS_SIGN_CERT_BASE64_PRESENT == 'true' && env.WINDOWS_SIGN_CERT_PASSWORD_PRESENT == 'true' }}";
    expect(workflow.match(new RegExp(escapeRegExp(publicReleaseSigningCondition), "g")) ?? []).toHaveLength(3);
  });

  it("uses unique per-run cert file names", () => {
    expect(workflow).toMatch(/goatcitadel-signing-cert-\$\(\[Guid\]::NewGuid\(\)\)\.pfx/);
  });

  it("removes temporary cert files from every signing step", () => {
    const cleanupCalls =
      workflow.match(/Remove-Item\s+-LiteralPath\s+\$certPath\s+-Force\s+-ErrorAction\s+SilentlyContinue/g) ?? [];
    expect(cleanupCalls).toHaveLength(3);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
