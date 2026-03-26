import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectSkillSourceDrift,
  collectWorkspaceDependencyDrift,
  parsePnpmOutdatedOutput,
  renderUpdateReviewMarkdown,
} from "./update-review.js";

describe("parsePnpmOutdatedOutput", () => {
  it("parses pnpm outdated table output with wrapped dependents", () => {
    const rows = parsePnpmOutdatedOutput([
      "┌──────────────────────────────────┬──────────┬─────────┬────────────────────────────────┐",
      "│ Package                          │ Current  │ Latest  │ Dependents                     │",
      "├──────────────────────────────────┼──────────┼─────────┼────────────────────────────────┤",
      "│ @types/node (dev)                │ 24.10.15 │ 25.5.0  │ goatcitadel                    │",
      "├──────────────────────────────────┼──────────┼─────────┼────────────────────────────────┤",
      "│ zod                              │ 3.25.76  │ 4.3.6   │ @goatcitadel/contracts,        │",
      "│                                  │          │         │ @goatcitadel/gateway,          │",
      "│                                  │          │         │ @goatcitadel/orchestration     │",
      "└──────────────────────────────────┴──────────┴─────────┴────────────────────────────────┘",
    ].join("\n"));

    expect(rows).toEqual([
      {
        packageName: "@types/node",
        dependencyType: "dev",
        currentVersion: "24.10.15",
        latestVersion: "25.5.0",
        dependents: ["goatcitadel"],
      },
      {
        packageName: "zod",
        dependencyType: undefined,
        currentVersion: "3.25.76",
        latestVersion: "4.3.6",
        dependents: [
          "@goatcitadel/contracts",
          "@goatcitadel/gateway",
          "@goatcitadel/orchestration",
        ],
      },
    ]);
  });
});

describe("collectWorkspaceDependencyDrift", () => {
  it("uses stdout rows even when pnpm exits nonzero", async () => {
    const result = await collectWorkspaceDependencyDrift(
      "F:/code/personal-ai",
      async () => {
        const error = new Error("outdated found changes") as Error & {
          stdout: string;
          stderr: string;
        };
        error.stdout = [
          "┌─────────┬─────────┬────────┬─────────────┐",
          "│ Package │ Current │ Latest │ Dependents  │",
          "├─────────┼─────────┼────────┼─────────────┤",
          "│ nanoid  │ 5.1.6   │ 5.1.7  │ gateway-core │",
          "└─────────┴─────────┴────────┴─────────────┘",
        ].join("\n");
        error.stderr = "";
        throw error;
      },
    );

    expect(result.warnings).toEqual([]);
    expect(result.items).toEqual([
      {
        packageName: "nanoid",
        dependencyType: undefined,
        currentVersion: "5.1.6",
        latestVersion: "5.1.7",
        dependents: ["gateway-core"],
      },
    ]);
  });
});

describe("collectSkillSourceDrift", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-update-review-"));
    fs.mkdirSync(path.join(rootDir, "skills", "extra", "cloudflare-api"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "skills", "extra", "cloudflare-api", "source.json"),
      JSON.stringify({
        manifestVersion: 2,
        duplicateFamily: "cloudflare_dns",
        resolvedUpstream: {
          url: "https://github.com/example/cloudflare-api",
          ref: "HEAD",
          version: "abc123",
        },
      }, null, 2),
      "utf8",
    );
    fs.mkdirSync(path.join(rootDir, "skills", "extra", "local-only"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "skills", "extra", "local-only", "source.json"),
      JSON.stringify({
        manifestVersion: 2,
        candidate: {
          sourceRef: "C:/skills/local-only",
        },
      }, null, 2),
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("reports upstream drift and local-source warnings", async () => {
    const result = await collectSkillSourceDrift(rootDir, async (_file, args) => {
      if (args[0] === "ls-remote") {
        return {
          stdout: "def456\tHEAD\n",
          stderr: "",
        };
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skillId: "cloudflare-api",
        status: "changed",
        currentVersion: "abc123",
        latestVersion: "def456",
      }),
      expect.objectContaining({
        skillId: "local-only",
        status: "warning",
      }),
    ]));
    expect(result.warnings.some((warning) => warning.includes("local-only"))).toBe(true);
  });
});

describe("renderUpdateReviewMarkdown", () => {
  it("renders dependency and skill sections with warnings", () => {
    const markdown = renderUpdateReviewMarkdown({
      generatedAt: "2026-03-22T12:00:00.000Z",
      dependencyDrift: {
        items: [
          {
            packageName: "nanoid",
            currentVersion: "5.1.6",
            latestVersion: "5.1.7",
            dependents: ["@goatcitadel/gateway-core"],
          },
        ],
        warnings: [],
      },
      skillSourceDrift: {
        items: [
          {
            skillId: "cloudflare-api",
            status: "changed",
            currentVersion: "abc123",
            latestVersion: "def456",
            message: "Upstream repository HEAD differs from the recorded installed revision.",
          },
        ],
        warnings: ["cloudflare-api: upstream changed"],
      },
      summary: {
        outdatedDependencyCount: 1,
        changedSkillSourceCount: 1,
        warningCount: 1,
        checkedSkillCount: 1,
      },
    });

    expect(markdown).toContain("# Daily Update Review");
    expect(markdown).toContain("| nanoid | 5.1.6 | 5.1.7 | @goatcitadel/gateway-core |");
    expect(markdown).toContain("| cloudflare-api | changed | abc123 | def456 |");
    expect(markdown).toContain("## Warnings");
  });
});
