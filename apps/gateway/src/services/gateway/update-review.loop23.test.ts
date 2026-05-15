import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProviderModelStaleness,
  collectVendorChangelogDrift,
  collectWorkspaceDependencyDrift,
  renderUpdateReviewMarkdown,
} from "./update-review.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("update review warning branches loop 23", () => {
  it("surfaces pnpm stderr when no outdated rows can be parsed", async () => {
    const result = await collectWorkspaceDependencyDrift("F:/code/personal-ai", async () => ({
      stdout: "No table here",
      stderr: "registry unavailable",
    }));

    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(["pnpm outdated reported an error without parseable rows: registry unavailable"]);
  });

  it("reports unparseable and non-ok vendor changelog responses as warnings", async () => {
    const result = await collectVendorChangelogDrift("F:/code/personal-ai", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openclaw")) {
        return new Response("not a changelog", { status: 200 });
      }
      return new Response("offline", { status: 503, statusText: "Service Unavailable" });
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "openai", status: "warning" }),
        expect.objectContaining({ sourceId: "anthropic", status: "warning" }),
        expect.objectContaining({
          sourceId: "openclaw",
          status: "warning",
          message: "Unable to parse the latest changelog entry from the upstream source.",
        }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "openai: Changelog fetch failed (503 Service Unavailable).",
        "anthropic: Changelog fetch failed (503 Service Unavailable).",
        "openclaw: Unable to parse the latest changelog entry from the upstream source.",
      ]),
    );
  });

  it("warns when provider defaults cannot be read or required providers are absent", async () => {
    const missingConfigRoot = await createTempRoot();
    const configuredRoot = await createTempRoot();
    await fs.mkdir(path.join(configuredRoot, "config"), { recursive: true });
    await fs.writeFile(
      path.join(configuredRoot, "config", "llm-providers.json"),
      JSON.stringify({ providers: [{ providerId: "openai", apiStyle: "openai-responses", defaultModel: "gpt-5.4" }] }),
      "utf8",
    );

    const missingConfig = await collectProviderModelStaleness(missingConfigRoot);
    const missingAnthropic = await collectProviderModelStaleness(configuredRoot);

    expect(missingConfig.items).toEqual([]);
    expect(missingConfig.warnings[0]).toContain("Unable to read config/llm-providers.json");
    expect(missingAnthropic.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "openai", status: "current" }),
        expect.objectContaining({ providerId: "anthropic", status: "warning" }),
      ]),
    );
    expect(missingAnthropic.warnings).toContain("anthropic: Provider is not configured in config/llm-providers.json.");
  });

  it("renders empty review sections without adding a warnings block", () => {
    const markdown = renderUpdateReviewMarkdown({
      generatedAt: "2026-05-14T12:00:00.000Z",
      dependencyDrift: { items: [], warnings: [] },
      skillSourceDrift: { items: [], warnings: [] },
      vendorChangelogDrift: { items: [], warnings: [] },
      providerModelStaleness: { items: [], warnings: [] },
      summary: {
        outdatedDependencyCount: 0,
        changedSkillSourceCount: 0,
        checkedVendorSourceCount: 0,
        staleProviderCount: 0,
        warningCount: 0,
        checkedSkillCount: 0,
      },
    });

    expect(markdown).toContain("_No dependency drift detected by `pnpm outdated -r`._");
    expect(markdown).toContain("_No repo-managed extra skills were available for drift review._");
    expect(markdown).toContain("_No vendor changelog checks were completed._");
    expect(markdown).toContain("_No direct-provider defaults were available for staleness review._");
    expect(markdown).not.toContain("## Warnings");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-update-review-loop23-"));
  tempRoots.push(root);
  return root;
}
