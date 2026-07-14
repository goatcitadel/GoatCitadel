import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression coverage for CODEX_FINDING #7 + #10. Reusable signing secrets
// belong only to fresh, closed-purpose signer jobs and their one signing step.
// Build/test jobs must never inherit those secrets or perform signing.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workflowPath = path.resolve(__dirname, "..", "..", "..", ".github", "workflows", "release-installers.yml");

describe("release-installers workflow signing-secret scope (codex #7, #10)", () => {
  const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
  const windowsComponentSigner = extractJobBlock(workflow, "windows-component-sign");
  const windowsInstallerSigner = extractJobBlock(workflow, "windows-installer-sign");
  const macSigner = extractJobBlock(workflow, "macos-sign-notarize");
  const publicReleaseCondition =
    "if: ${{ github.event_name == 'push' && github.repository == 'goatcitadel/GoatCitadel' && startsWith(github.ref, 'refs/tags/v') }}";

  it("does NOT expose WINDOWS_SIGN_CERT_BASE64 at job level", () => {
    expect(workflow).not.toMatch(/^ {6}WINDOWS_SIGN_CERT_BASE64:\s*\$\{\{\s*secrets\./m);
    expect(workflow).not.toMatch(/^ {6}WINDOWS_SIGN_CERT_PASSWORD:\s*\$\{\{\s*secrets\./m);
  });

  it("scopes Windows PFX secrets to one step in each of the two isolated signer jobs", () => {
    const baseRefs = workflow.match(/secrets\.WINDOWS_SIGN_CERT_BASE64\b/g) ?? [];
    const passRefs = workflow.match(/secrets\.WINDOWS_SIGN_CERT_PASSWORD\b/g) ?? [];
    expect(baseRefs).toHaveLength(2);
    expect(passRefs).toHaveLength(2);

    for (const signer of [windowsComponentSigner, windowsInstallerSigner]) {
      expect(signer.match(/^ {10}WINDOWS_SIGN_CERT_BASE64:\s*\$\{\{\s*secrets\./gm) ?? []).toHaveLength(1);
      expect(signer.match(/^ {10}WINDOWS_SIGN_CERT_PASSWORD:\s*\$\{\{\s*secrets\./gm) ?? []).toHaveLength(1);
    }

    const nonWindowsSignerWorkflow = workflow.replace(windowsComponentSigner, "").replace(windowsInstallerSigner, "");
    expect(nonWindowsSignerWorkflow).not.toMatch(/secrets\.WINDOWS_SIGN_CERT_(?:BASE64|PASSWORD)\b/);
  });

  it("keeps the two Windows signer jobs isolated from checkout and repository execution", () => {
    expect(workflow.match(/^ {2}windows-(?:component|installer)-sign:/gm) ?? []).toHaveLength(2);
    for (const signer of [windowsComponentSigner, windowsInstallerSigner]) {
      expect(signer).toContain(publicReleaseCondition);
      expect(signer).toContain("environment: release");
      expect(signer).toContain("GOATCITADEL_RELEASE_TRUST_READY");
      expect(signer).toContain("actions/download-artifact@");
      expect(signer).not.toMatch(/actions\/checkout@|\b(?:pnpm|npm|cargo|rustup|node)\b/);
    }
  });

  it("does NOT rely on PATH for signtool resolution", () => {
    expect(workflow).not.toMatch(/Get-Command\s+signtool\.exe/);
  });

  it("resolves signtool from the Windows 10/11 SDK install path", () => {
    expect(workflow).toContain("Windows Kits\\10\\bin");
  });

  it("does not expose secrets or signing commands to allow_unsigned build jobs", () => {
    const windowsBuild = extractJobBlock(workflow, "windows-build-inputs");
    const macBuild = extractJobBlock(workflow, "macos-build-inputs");
    expect(windowsBuild).toContain("github.event.inputs.allow_unsigned == 'true'");
    expect(windowsBuild).not.toMatch(/WINDOWS_SIGN_CERT|\$signtool\s+sign/);
    expect(macBuild).toContain("github.event.inputs.allow_unsigned == 'true'");
    expect(macBuild).not.toMatch(
      /MACOS_DEVELOPER_ID_CERT|APPLE_APP_SPECIFIC_PASSWORD|\bcodesign\b|\bnotarytool\b|security create-keychain/,
    );
  });

  it("uses distinct unique per-run certificate files for component and installer signing", () => {
    expect(windowsComponentSigner).toMatch(/goatcitadel-component-\$\(\[Guid\]::NewGuid\(\)\)\.pfx/);
    expect(windowsInstallerSigner).toMatch(/goatcitadel-installer-\$\(\[Guid\]::NewGuid\(\)\)\.pfx/);
    expect(workflow).not.toContain("goatcitadel-signing-cert-");
  });

  it("removes both temporary Windows certificate files", () => {
    const cleanupCalls =
      workflow.match(/Remove-Item\s+-LiteralPath\s+\$certPath\s+-Force\s+-ErrorAction\s+SilentlyContinue/g) ?? [];
    expect(cleanupCalls).toHaveLength(2);
    for (const signer of [windowsComponentSigner, windowsInstallerSigner]) {
      expect(
        signer.match(/Remove-Item\s+-LiteralPath\s+\$certPath\s+-Force\s+-ErrorAction\s+SilentlyContinue/g) ?? [],
      ).toHaveLength(1);
    }
  });

  it("isolates macOS signing and always removes its ephemeral keychain", () => {
    expect(macSigner).toContain(publicReleaseCondition);
    expect(macSigner).toContain("environment: release");
    expect(macSigner).toContain("GOATCITADEL_RELEASE_TRUST_READY");
    expect(macSigner).toContain("actions/download-artifact@");
    expect(macSigner).not.toMatch(/actions\/checkout@|\b(?:pnpm|npm|cargo|rustup|node)\b/);
    expect(macSigner).toContain("security create-keychain");
    expect(macSigner).toContain("if: ${{ always() }}");
    expect(macSigner).toContain('security delete-keychain "$RUNNER_TEMP/goatcitadel-macos-signing.keychain-db"');

    const macSecretNames = [
      "MACOS_DEVELOPER_ID_CERT_BASE64",
      "MACOS_DEVELOPER_ID_CERT_PASSWORD",
      "MACOS_DEVELOPER_ID_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
    ];
    const nonMacSignerWorkflow = workflow.replace(macSigner, "");
    for (const secretName of macSecretNames) {
      expect(workflow).not.toMatch(new RegExp(`^ {6}${secretName}:\\s*\\$\\{\\{\\s*secrets\\.`, "m"));
      expect(macSigner.match(new RegExp(`^ {10}${secretName}:\\s*\\$\\{\\{\\s*secrets\\.`, "gm")) ?? []).toHaveLength(
        1,
      );
      expect(nonMacSignerWorkflow).not.toMatch(new RegExp(`secrets\\.${secretName}\\b`));
    }
  });
});

function extractJobBlock(source: string, jobName: string): string {
  const header = `  ${jobName}:\n`;
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`Missing release workflow job: ${jobName}`);
  const remainder = source.slice(start + header.length);
  const nextJob = remainder.search(/\n {2}[a-z0-9][a-z0-9-]*:\n/u);
  return source.slice(start, nextJob < 0 ? source.length : start + header.length + nextJob);
}
