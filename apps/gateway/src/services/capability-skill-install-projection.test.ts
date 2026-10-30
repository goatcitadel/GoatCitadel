import { describe, expect, it } from "vitest";
import type { CapabilitySkillInstall } from "@goatcitadel/contracts";
import { buildCapabilitySkillInstall, isUnfinishedInstall } from "./capability-skill-install-projection.js";
import { HIMALAYA_PACK_PATH, hubApproval, hubItem } from "./capability-skill-install.test-support.js";

const INSTALLED = { inactiveCandidate: true };
const ACTIVE = { activeVersion: true, callable: true };
const ALREADY_INSTALLED = {
  install_inactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
};

/** Ruling R41: total, read in this order, from the check, its two approvals and their settlements. */
const STEP_ROWS: Array<[string, Parameters<typeof hubItem>[0], Partial<CapabilitySkillInstall>]> = [
  [
    "a check with its own blocker codes",
    { snapshot: { blockerCodes: ["AUDIT_MISSING", "PERMISSION_WIDENED"], trustDisposition: "blocked" } },
    { step: "blocked", blockers: ["AUDIT_MISSING", "PERMISSION_WIDENED"] },
  ],
  [
    "a pending switch-on approval",
    { runtime: INSTALLED, approvals: { activate: hubApproval("activate", "pending") } },
    { step: "waiting_switch_on", approvalId: "approval-activate", blockers: [] },
  ],
  [
    "an approved switch-on that hasn't settled",
    { runtime: INSTALLED, approvals: { activate: hubApproval("activate", "approved") } },
    { step: "switching_on", blockers: [] },
  ],
  [
    "a switch-on settled as blocked",
    { runtime: INSTALLED, approvals: { activate: hubApproval("activate", "approved", "blocked") } },
    { step: "failed", failure: "GoatCitadel's checks stopped switching it on.", blockers: [] },
  ],
  [
    "a switch-on that needs manual reconciliation",
    { runtime: INSTALLED, approvals: { activate: hubApproval("activate", "approved", "manual_reconciliation") } },
    { step: "failed", failure: "Switching it on didn't finish and needs a manual fix.", blockers: [] },
  ],
  [
    "an applied switch-on whose skill is now off",
    {
      runtime: { activeVersion: true, callable: false },
      approvals: { activate: hubApproval("activate", "approved", "applied") },
    },
    { step: "done", installedSkillId: "extra:himalaya", blockers: [] },
  ],
  ["an active version with no switch-on approval", { runtime: ACTIVE }, { step: "done", blockers: [] }],
  [
    "a declined switch-on",
    { runtime: INSTALLED, approvals: { activate: hubApproval("activate", "rejected") } },
    { step: "installed_off", blockers: [] },
  ],
  [
    "a pending install approval",
    { approvals: { install_inactive: hubApproval("install_inactive", "pending") } },
    { step: "waiting_install", approvalId: "approval-install_inactive", blockers: [] },
  ],
  [
    "an approved install that hasn't settled",
    { approvals: { install_inactive: hubApproval("install_inactive", "approved") } },
    { step: "installing", blockers: [] },
  ],
  [
    "an install settled as blocked",
    { approvals: { install_inactive: hubApproval("install_inactive", "approved", "blocked") } },
    { step: "failed", failure: "GoatCitadel's checks stopped the install.", blockers: [] },
  ],
  [
    "an install that needs manual reconciliation",
    { approvals: { install_inactive: hubApproval("install_inactive", "approved", "manual_reconciliation") } },
    { step: "failed", failure: "The install didn't finish and needs a manual fix.", blockers: [] },
  ],
  [
    "an installed candidate that isn't switched on",
    {
      runtime: INSTALLED,
      approvals: { install_inactive: hubApproval("install_inactive", "approved", "applied") },
      actions: ALREADY_INSTALLED,
    },
    { step: "installed_off", blockers: [] },
  ],
  ["a passed check with nothing asked yet", {}, { step: "check_passed", blockers: [] }],
  [
    "a declined install",
    { approvals: { install_inactive: hubApproval("install_inactive", "rejected") } },
    { step: "check_passed", blockers: [] },
  ],
  [
    "an edited install",
    { approvals: { install_inactive: hubApproval("install_inactive", "edited") } },
    { step: "check_passed", blockers: [] },
  ],
  [
    "a fresh check of a source that is already installed",
    { actions: ALREADY_INSTALLED },
    { step: "blocked", blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
  ],
];

describe("buildCapabilitySkillInstall", () => {
  it.each(STEP_ROWS)("reads %s as its step", (_label, overrides, expected) => {
    const install = buildCapabilitySkillInstall(hubItem(overrides));

    expect(install).toMatchObject(expected);
    // Only a waiting step names its approval, only done names the skill, and only failed says why.
    if (expected.approvalId === undefined) expect(install?.approvalId).toBeUndefined();
    if (expected.step !== "done") expect(install?.installedSkillId).toBeUndefined();
    if (expected.failure === undefined) expect(install?.failure).toBeUndefined();
  });

  it("names a shipped pack by its id and label, never by its folder", () => {
    const install = buildCapabilitySkillInstall(hubItem());

    expect(install).toMatchObject({
      snapshotId: "skill-hub-review-1",
      name: "Email over IMAP/SMTP (Himalaya)",
      description: "Read, search, organise and send mail for any IMAP/SMTP account.",
      source: { kind: "pack", packId: "himalaya" },
    });
    expect(JSON.stringify(install)).not.toContain(HIMALAYA_PACK_PATH);
    expect(JSON.stringify(install)).not.toContain("import-packs");
  });

  it.each([
    ["a forward-slash", "/srv/goatcitadel/skills/import-packs/github-cli", "github-cli"],
    ["a backslash", "D:\\goatcitadel\\skills\\import-packs\\github-cli", "github-cli"],
  ])("reads a pack folder with %s separator", (_label, sourceRef, packId) => {
    expect(buildCapabilitySkillInstall(hubItem({ snapshot: { sourceRef } }))?.source).toEqual({
      kind: "pack",
      packId,
    });
  });

  it.each([
    ["a local folder that isn't a pack", { sourceType: "local_path", sourceRef: "/srv/skills/my-skill" }],
    ["a pack id GoatCitadel doesn't ship", { sourceType: "local_path", sourceRef: "/srv/skills/import-packs/gog" }],
    ["a hosted bundle", { sourceType: "remote_bundle", sourceRef: "https://example.com/skills/a/skill.md" }],
  ])("leaves out %s, since it can't be named without a server path", (_label, snapshot) => {
    expect(buildCapabilitySkillInstall(hubItem({ snapshot }))).toBeUndefined();
  });

  it("names a Git source by its address, host and commit", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const install = buildCapabilitySkillInstall(
      hubItem({
        title: "release-notes",
        skillId: "extra:release-notes",
        snapshot: {
          sourceProvider: "github",
          sourceType: "git_url",
          sourceRef: "https://github.com/example/release-notes",
          resolvedVersion: commit,
        },
      }),
    );

    expect(install).toMatchObject({
      name: "release-notes",
      description: "",
      source: { kind: "git", sourceRef: "https://github.com/example/release-notes", host: "github.com", commit },
    });
  });

  it("leaves the commit out when the check pinned only the content", () => {
    const install = buildCapabilitySkillInstall(
      hubItem({ snapshot: { sourceType: "git_url", sourceRef: "https://gitlab.com/example/notes" } }),
    );

    expect(install?.source).toEqual({ kind: "git", sourceRef: "https://gitlab.com/example/notes", host: "gitlab.com" });
  });

  it("says what the skill asks for, from its check's permission envelope", () => {
    const install = buildCapabilitySkillInstall(
      hubItem({
        snapshot: {
          permissionEnvelope: {
            version: "goatcitadel.skill-permission-envelope.v1",
            toolIds: ["tool:browser.search", "tool:shell.exec"],
            environmentVariableNames: ["NOTES_TOKEN"],
            networkOrigins: ["https://api.example.com", "https://api.example.com:8443", "wss://live.example.com"],
            filesystem: { readScopes: ["notes/**"], writeScopes: ["notes/out/**"] },
            scripts: ["scripts/sync.sh"],
            dependencies: { packages: [], nativeRequirements: ["require:git", "require:jq", "skill:research"] },
          },
        },
      }),
    );

    expect(install?.asksFor).toEqual({
      tools: ["tool:browser.search", "tool:shell.exec"],
      networkHosts: ["api.example.com", "api.example.com:8443", "live.example.com"],
      envVars: ["NOTES_TOKEN"],
      readsFiles: ["notes/**"],
      writesFiles: ["notes/out/**"],
      includesScripts: true,
      requires: ["git", "jq"],
    });
  });

  it("says it asks for nothing when its envelope is empty", () => {
    const install = buildCapabilitySkillInstall(
      hubItem({
        snapshot: {
          permissionEnvelope: {
            version: "goatcitadel.skill-permission-envelope.v1",
            toolIds: [],
            environmentVariableNames: [],
            networkOrigins: [],
            filesystem: { readScopes: [], writeScopes: [] },
            scripts: [],
            dependencies: { packages: [], nativeRequirements: [] },
          },
        },
      }),
    );

    expect(install?.asksFor).toEqual({
      tools: [],
      networkHosts: [],
      envVars: [],
      readsFiles: [],
      writesFiles: [],
      includesScripts: false,
      requires: [],
    });
  });
});

describe("isUnfinishedInstall", () => {
  it.each([
    ["check_passed", false],
    ["blocked", false],
    ["done", false],
    ["waiting_install", true],
    ["installing", true],
    ["installed_off", true],
    ["waiting_switch_on", true],
    ["switching_on", true],
    ["failed", true],
  ] as const)("counts %s as unfinished: %s", (step, unfinished) => {
    expect(isUnfinishedInstall({ step })).toBe(unfinished);
  });
});
