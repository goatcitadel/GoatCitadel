import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilitySkillDiscoverItem,
  CapabilitySkillInstall,
  SkillMergedSourceResult,
  SkillSourceListResponse,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillDiscoverService,
  type CapabilitySkillDiscoverSources,
} from "./capability-skill-discover-service.js";
import { SkillImportService, type InstalledSkillSource } from "./skill-import-service.js";

const WORKSPACE = "default";
const GOG_ID = "source:clawhub.ai/steipete/gog";
const TEN_MINUTES_MS = 10 * 60 * 1000;

function createSystemSettingsRepo() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      return store.has(key) ? { value: store.get(key) as T } : undefined;
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

function idsOf(items: readonly CapabilitySkillDiscoverItem[]): string[] {
  return items.map((item) => item.id);
}

function itemOf(items: readonly CapabilitySkillDiscoverItem[], id: string): CapabilitySkillDiscoverItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No Discover item ${id}. Items: ${idsOf(items).join(", ")}`);
  return item;
}

/** A marketplace home page that links to the given skill slugs. */
function homePage(provider: "agentskill" | "skillsmp", slugs: readonly string[]): string {
  const base = provider === "agentskill" ? "https://agentskill.sh" : "https://skillsmp.com";
  return `<html><body>${slugs.map((slug) => `<a href="${base}/skills/${slug}">${slug}</a>`).join("")}</body></html>`;
}

type MarketplaceAnswer = { html: string } | { down: true };

/** Stubs `fetch` for the two marketplaces' home pages, and counts every call. */
function stubMarketplaces(answers: () => { agentskill: MarketplaceAnswer; skillsmp: MarketplaceAnswer }) {
  const calls: string[] = [];
  const stub = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const provider = url.startsWith("https://agentskill.sh") ? "agentskill" : "skillsmp";
    const answer = answers()[provider];
    if ("down" in answer) throw new Error("marketplace offline");
    return new Response(answer.html, { status: 200 });
  });
  vi.stubGlobal("fetch", stub);
  return { calls, stub };
}

/** A curated-style entry, as `presentSourceCatalog` hands it over. */
function listing(
  name: string,
  overrides: Partial<SkillMergedSourceResult> & { sourceUrl: string },
): SkillMergedSourceResult {
  return {
    sourceProvider: "github",
    name,
    description: `${name} description`,
    tags: [],
    canonicalKey: overrides.sourceUrl.replace(/^https?:\/\//u, "").toLowerCase(),
    alternateProviders: [],
    qualityScore: 0.5,
    freshnessScore: 0.5,
    trustScore: 0.5,
    combinedScore: 0.5,
    ...overrides,
  };
}

/** Sources whose catalog answer is exactly these listings, with no ranking and nothing installed. */
function sourcesAnswering(
  items: SkillMergedSourceResult[],
  overrides: Partial<CapabilitySkillDiscoverSources> = {},
): CapabilitySkillDiscoverSources {
  const response: SkillSourceListResponse = {
    generatedAt: "2026-10-29T00:00:00.000Z",
    providers: [{ provider: "github", providerLabel: "GitHub", available: true, status: "ok" }],
    items,
  };
  return {
    readSourceCatalog: vi.fn(async () => ({ providers: response.providers, items })),
    presentSourceCatalog: vi.fn(() => response),
    listInstalledSources: vi.fn((): InstalledSkillSource[] => []),
    listInstalls: vi.fn(async (): Promise<CapabilitySkillInstall[]> => []),
    ...overrides,
  };
}

function install(
  source: CapabilitySkillInstall["source"],
  step: CapabilitySkillInstall["step"] = "installed_off",
  snapshotId = "skill-hub-review-1",
): CapabilitySkillInstall {
  return {
    snapshotId,
    name: "A skill",
    description: "",
    source,
    step,
    blockers: [],
    asksFor: {
      tools: [],
      networkHosts: [],
      envVars: [],
      readsFiles: [],
      writesFiles: [],
      includesScripts: false,
      requires: [],
    },
  };
}

describe("Capabilities skill discovery", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-skill-discover-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A Discover service over a real source owner on this root, with the installs list and the clock given. */
  function wire(options: { installs?: CapabilitySkillInstall[]; now?: () => Date } = {}) {
    const imports = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    return new CapabilitySkillDiscoverService(
      {
        readSourceCatalog: (readOptions) => imports.readSourceCatalog(readOptions),
        presentSourceCatalog: (catalog, query, limit) => imports.presentSourceCatalog(catalog, query, limit),
        listInstalledSources: () => imports.listInstalledSources(),
        listInstalls: async () => options.installs ?? [],
      },
      options.now ? { now: options.now } : {},
    );
  }

  it("makes no network call without a search term", async () => {
    const { stub } = stubMarketplaces(() => {
      throw new Error("Discover went online without a search term");
    });

    const response = await wire().list(WORKSPACE);

    expect(stub).not.toHaveBeenCalled();
    expect(response.query).toBeUndefined();
    expect(response.unavailableProviders).toEqual([]);
    // The two packs come first, then the curated listings, which can only be looked at.
    expect(idsOf(response.items).slice(0, 2)).toEqual(["pack:himalaya", "pack:github-cli"]);
    const listings = response.items.filter((item) => item.id.startsWith("source:"));
    expect(listings.length).toBeGreaterThan(20);
    expect(listings.every((item) => item.state === "view_only" && item.install === undefined)).toBe(true);
    expect(listings.every((item) => typeof item.listingUrl === "string")).toBe(true);
  });

  it("describes a pack with its label, summary, category and a GoatCitadel provider", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const response = await wire().list(WORKSPACE);

    expect(itemOf(response.items, "pack:himalaya")).toEqual({
      id: "pack:himalaya",
      name: "Email over IMAP/SMTP (Himalaya)",
      description: "Read, search, organise and send mail for any IMAP/SMTP account.",
      category: "email",
      provider: "goatcitadel",
      providerLabel: "GoatCitadel",
      state: "available",
      install: { kind: "pack", packId: "himalaya" },
    });
    expect(itemOf(response.items, "pack:github-cli")).toMatchObject({ category: "coding", state: "available" });
  });

  it("offers Install only for packs and trusted Git hosts", async () => {
    const sources = sourcesAnswering([
      listing("Trusted", { sourceUrl: "https://github.com/example/trusted", installability: "direct" }),
      listing("Gitlab", { sourceUrl: "https://gitlab.com/example/trusted", installability: "direct" }),
      listing("Listing then repo", {
        sourceUrl: "https://clawhub.ai/example/listing-then-repo",
        repositoryUrl: "https://codeberg.org/example/listing-then-repo",
        installability: "direct",
      }),
      listing("Not installable", {
        sourceUrl: "https://github.com/example/not-installable",
        installability: "not_installable",
      }),
      listing("Review only", { sourceUrl: "https://github.com/example/review-only", installability: "review_only" }),
      // The review asks a Git address for an owner and a repository, so an owner's page can't be installed.
      listing("Owner only", { sourceUrl: "https://github.com/owner", installability: "direct" }),
      listing("Host only", { sourceUrl: "https://github.com/", installability: "direct" }),
      listing("Repository with a slash", {
        sourceUrl: "https://github.com/example/slashed/",
        installability: "direct",
      }),
      listing("No flag", { sourceUrl: "https://github.com/example/no-flag" }),
      listing("Other host", { sourceUrl: "https://example.com/example/other-host", installability: "direct" }),
      listing("Plain http", { sourceUrl: "http://github.com/example/plain-http", installability: "direct" }),
      listing("With credentials", {
        sourceUrl: "https://user:secret@github.com/example/with-credentials",
        installability: "direct",
      }),
      listing("A www host", { sourceUrl: "https://www.github.com/example/www-host", installability: "direct" }),
      listing("Marketplace", {
        sourceProvider: "skillsmp",
        sourceUrl: "https://skillsmp.com/skills/marketplace",
        installability: "review_only",
      }),
    ]);

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    const byName = (name: string) => items.find((item) => item.name === name);
    expect(byName("Trusted")).toMatchObject({
      state: "available",
      install: { kind: "git", sourceRef: "https://github.com/example/trusted" },
    });
    expect(byName("Gitlab")).toMatchObject({
      install: { kind: "git", sourceRef: "https://gitlab.com/example/trusted" },
    });
    // The repository address wins over the listing's.
    expect(byName("Listing then repo")).toMatchObject({
      install: { kind: "git", sourceRef: "https://codeberg.org/example/listing-then-repo" },
      listingUrl: "https://clawhub.ai/example/listing-then-repo",
    });
    expect(byName("Repository with a slash")).toMatchObject({
      state: "available",
      install: { kind: "git", sourceRef: "https://github.com/example/slashed/" },
    });
    for (const name of [
      "Not installable",
      "Review only",
      "Owner only",
      "Host only",
      "No flag",
      "Other host",
      "Plain http",
      "With credentials",
      "A www host",
      "Marketplace",
    ]) {
      expect(byName(name), name).toMatchObject({ state: "view_only" });
      expect(byName(name)?.install, name).toBeUndefined();
    }
    // The packs are the only items that install without a Git address.
    expect(itemOf(items, "pack:himalaya").install).toEqual({ kind: "pack", packId: "himalaya" });
  });

  it("offers a listing's address only when it is https", async () => {
    const sources = sourcesAnswering([
      listing("Secure", { sourceUrl: "https://clawhub.ai/someone/secure" }),
      listing("Plain http", { sourceUrl: "http://clawhub.ai/someone/plain-http" }),
      listing("Script", { sourceUrl: "javascript:void(agentskill.sh/skills/script)" }),
      listing("Data", { sourceUrl: "data:text/html,agentskill.sh/skills/data" }),
      listing("Not an address", { sourceUrl: "agentskill.sh/skills/not-an-address" }),
    ]);

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    const byName = (name: string) => items.find((item) => item.name === name);
    expect(byName("Secure")?.listingUrl).toBe("https://clawhub.ai/someone/secure");
    for (const name of ["Plain http", "Script", "Data", "Not an address"]) {
      expect(byName(name), name).toBeDefined();
      expect(byName(name)?.listingUrl, name).toBeUndefined();
    }
  });

  it("never hands out a hostile link a marketplace page carries", async () => {
    stubMarketplaces(() => ({
      agentskill: {
        html: `<a href="/skills/zebra-planner">ok</a>
          <a href="javascript:void(agentskill.sh/skills/zebra-script)">x</a>
          <a href="data:text/html,agentskill.sh/skills/zebra-data">x</a>
          <a href="https://evil.example/agentskill.sh/skills/zebra-away">x</a>`,
      },
      skillsmp: { html: homePage("skillsmp", []) },
    }));

    const response = await wire().list(WORKSPACE, { query: "zebra" });

    const zebras = response.items.filter((item) => item.name.toLowerCase().includes("zebra"));
    expect(zebras.map((item) => item.listingUrl)).toEqual(["https://agentskill.sh/skills/zebra-planner"]);
    expect(JSON.stringify(response)).not.toMatch(/javascript:|data:text|evil\.example/u);
  });

  it("sends a listing's address only through the public projection", async () => {
    const sources = sourcesAnswering([
      listing("Leaky", {
        sourceUrl: "https://github.com/example/leaky",
        repositoryUrl: "https://token123:x-oauth-basic@github.com/example/leaky",
        installability: "direct",
      }),
    ]);

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    expect(JSON.stringify(items)).not.toContain("token123");
  });

  it("marks a source installed when an installed skill came from it, ignoring .git, www. and letter case", async () => {
    const sources = sourcesAnswering(
      [
        listing("Playwright", {
          sourceUrl: "https://github.com/example/playwright-skill",
          installability: "direct",
        }),
        listing("Notes", { sourceUrl: "https://github.com/Example/Notes-Skill", installability: "direct" }),
        listing("Untouched", { sourceUrl: "https://github.com/example/untouched", installability: "direct" }),
        listing("Marked by the owner", {
          sourceUrl: "https://github.com/example/marked-by-owner",
          installability: "direct",
          alreadyInstalled: true,
        }),
        listing("Listing only", { sourceUrl: "https://clawhub.ai/someone/listing-only" }),
      ],
      {
        listInstalledSources: vi.fn((): InstalledSkillSource[] => [
          {
            skillName: "playwright",
            sourceType: "git_url",
            sourceRefs: ["https://WWW.GitHub.com/Example/Playwright-Skill.git/"],
          },
          { skillName: "notes", sourceType: "git_url", sourceRefs: ["git@github.com:example/notes-skill.git"] },
          { skillName: "listed", sourceType: "git_url", sourceRefs: ["https://clawhub.ai/someone/listing-only"] },
        ]),
      },
    );

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    const byName = (name: string) => items.find((item) => item.name === name);
    expect(byName("Playwright")).toMatchObject({ state: "installed", installedSkillId: "extra:playwright" });
    expect(byName("Notes")).toMatchObject({ state: "installed", installedSkillId: "extra:notes" });
    expect(byName("Listing only")).toMatchObject({ state: "installed", installedSkillId: "extra:listed" });
    // The owner's own flag marks it installed too, though it can't name the skill.
    expect(byName("Marked by the owner")).toMatchObject({ state: "installed" });
    expect(byName("Marked by the owner")?.installedSkillId).toBeUndefined();
    expect(byName("Untouched")).toMatchObject({ state: "available" });
  });

  it("finds the installed skills' sources in the runtime folder the source owner reads", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const skillDir = path.join(rootDir, "skills", "extra", "playwright");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceProvider: "github",
          sourceRef: "https://www.github.com/Example/Playwright-Skill.git",
          sourceType: "git_url",
        },
      }),
    );
    const imports = new SkillImportService(rootDir, createSystemSettingsRepo() as never);
    const sources = sourcesAnswering(
      [listing("Playwright", { sourceUrl: "https://github.com/example/playwright-skill", installability: "direct" })],
      { listInstalledSources: () => imports.listInstalledSources() },
    );

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    expect(itemOf(items, "source:github.com/example/playwright-skill")).toMatchObject({
      state: "installed",
      installedSkillId: "extra:playwright",
    });
  });

  it("marks a pack installed once its skill is installed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // A pack install leaves its folder on the server as the skill's source, whichever separator the install used.
    for (const [skillName, sourceRef] of [
      ["himalaya", "C:\\goatcitadel\\skills\\import-packs\\himalaya"],
      ["github", "/opt/goatcitadel/skills/import-packs/github-cli"],
    ] as const) {
      const skillDir = path.join(rootDir, "skills", "extra", skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "source.json"),
        JSON.stringify({
          candidate: { sourceProvider: "local", sourceRef, sourceType: "local_path" },
          provenance: { sourceProvider: "local", sourceRef, sourceType: "local_path" },
        }),
      );
    }

    const { items } = await wire().list(WORKSPACE);

    expect(itemOf(items, "pack:himalaya")).toMatchObject({ state: "installed", installedSkillId: "extra:himalaya" });
    expect(itemOf(items, "pack:github-cli")).toMatchObject({ state: "installed", installedSkillId: "extra:github" });
    // It never carries the folder.
    expect(JSON.stringify(items)).not.toContain("import-packs");
  });

  it("doesn't take a Git repository named like a pack for the pack", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const skillDir = path.join(rootDir, "skills", "extra", "lookalike");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "source.json"),
      JSON.stringify({
        candidate: { sourceRef: "https://github.com/someone/import-packs/himalaya", sourceType: "git_url" },
      }),
    );

    const { items } = await wire().list(WORKSPACE);

    expect(itemOf(items, "pack:himalaya")).toMatchObject({ state: "available" });
  });

  it("marks a source installing while it is between steps", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const sources = sourcesAnswering(
      [
        listing("Between steps", { sourceUrl: "https://github.com/example/between-steps", installability: "direct" }),
        listing("Waiting", { sourceUrl: "https://github.com/example/waiting", installability: "direct" }),
        listing("Untouched", { sourceUrl: "https://github.com/example/untouched", installability: "direct" }),
      ],
      {
        listInstalls: vi.fn(async () => [
          install({ kind: "pack", packId: "himalaya" }, "installed_off", "check-pack"),
          install(
            {
              kind: "git",
              sourceRef: "https://www.github.com/Example/Between-Steps.git",
              host: "www.github.com",
            },
            "installed_off",
            "check-between",
          ),
          install({ kind: "git", sourceRef: "https://github.com/example/waiting" }, "waiting_install", "check-waiting"),
        ]),
      },
    );

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    // Each names the check whose install Continue opens.
    expect(itemOf(items, "pack:himalaya")).toMatchObject({
      state: "installing",
      install: { kind: "pack" },
      installSnapshotId: "check-pack",
    });
    expect(itemOf(items, "pack:github-cli")).toMatchObject({ state: "available" });
    expect(itemOf(items, "pack:github-cli").installSnapshotId).toBeUndefined();
    const byName = (name: string) => items.find((item) => item.name === name);
    expect(byName("Between steps")).toMatchObject({ state: "installing", installSnapshotId: "check-between" });
    expect(byName("Waiting")).toMatchObject({ state: "installing", installSnapshotId: "check-waiting" });
    expect(byName("Untouched")).toMatchObject({ state: "available" });
    expect(byName("Untouched")?.installSnapshotId).toBeUndefined();
    expect(sources.listInstalls).toHaveBeenCalledWith(WORKSPACE);
  });

  it("names the install that is still on its way in when a newer one of the same source stopped", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const repository = { kind: "git", sourceRef: "https://github.com/example/twice" } as const;
    const sources = sourcesAnswering(
      [listing("Twice", { sourceUrl: "https://github.com/example/twice", installability: "direct" })],
      {
        // Newest first, as the installs read lists them.
        listInstalls: vi.fn(async () => [
          install({ kind: "pack", packId: "himalaya" }, "failed", "pack-failed"),
          install({ kind: "pack", packId: "himalaya" }, "waiting_install", "pack-waiting"),
          install({ kind: "pack", packId: "github-cli" }, "failed", "cli-failed-newer"),
          install({ kind: "pack", packId: "github-cli" }, "failed", "cli-failed-older"),
          install({ ...repository, sourceRef: "https://www.github.com/example/twice.git" }, "failed", "git-failed"),
          install(repository, "waiting_switch_on", "git-waiting"),
        ]),
      },
    );

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    expect(itemOf(items, "pack:himalaya")).toMatchObject({ state: "installing", installSnapshotId: "pack-waiting" });
    // Every install of it stopped: the newest.
    expect(itemOf(items, "pack:github-cli")).toMatchObject({
      state: "installing",
      installSnapshotId: "cli-failed-newer",
    });
    expect(items.find((item) => item.name === "Twice")).toMatchObject({
      state: "installing",
      installSnapshotId: "git-waiting",
    });
  });

  it("reads an installed pack as installed, not installing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const sources = sourcesAnswering([], {
      listInstalledSources: vi.fn((): InstalledSkillSource[] => [
        { skillName: "himalaya", sourceType: "local_path", sourceRefs: ["/srv/goat/skills/import-packs/himalaya"] },
      ]),
      listInstalls: vi.fn(async () => [install({ kind: "pack", packId: "himalaya" }, "switching_on")]),
    });

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    expect(itemOf(items, "pack:himalaya")).toMatchObject({ state: "installed" });
    expect(itemOf(items, "pack:himalaya").installSnapshotId).toBeUndefined();
  });

  it("still lists everything when the installs can't be read", async () => {
    const sources = sourcesAnswering(
      [listing("Trusted", { sourceUrl: "https://github.com/example/trusted", installability: "direct" })],
      {
        listInstalls: vi.fn(async (): Promise<CapabilitySkillInstall[]> => {
          throw new Error("storage is locked");
        }),
      },
    );

    const { items } = await new CapabilitySkillDiscoverService(sources).list(WORKSPACE);

    expect(itemOf(items, "pack:himalaya")).toMatchObject({ state: "available" });
    expect(items.find((item) => item.name === "Trusted")).toMatchObject({ state: "available" });
  });

  it("keeps packs and curated entries when a marketplace is down, and names it", async () => {
    stubMarketplaces(() => ({ agentskill: { down: true }, skillsmp: { down: true } }));

    const response = await wire().list(WORKSPACE, { query: "Mail" });

    expect(response.query).toBe("mail");
    expect(response.unavailableProviders).toEqual(["AgentSkill", "SkillsMP"]);
    expect(idsOf(response.items)).toContain("pack:himalaya");
    // The curated entries still answer the search: ranked, so a name that matches is there.
    const chrome = await wire().list(WORKSPACE, { query: "chrome" });
    expect(idsOf(chrome.items)).toContain("source:clawhub.ai/aiwithabidi/chrome-devtools-mcp");
    expect(chrome.unavailableProviders).toEqual(["AgentSkill", "SkillsMP"]);
  });

  it("names only the marketplace that is down", async () => {
    stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: { down: true },
    }));

    const response = await wire().list(WORKSPACE, { query: "zebra" });

    expect(response.unavailableProviders).toEqual(["SkillsMP"]);
    expect(idsOf(response.items)).toContain("source:agentskill.sh/skills/zebra-planner");
  });

  it("only lists the packs a search term matches", async () => {
    stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", []) },
      skillsmp: { html: homePage("skillsmp", []) },
    }));

    const response = await wire().list(WORKSPACE, { query: "github pull requests" });

    expect(idsOf(response.items)).toContain("pack:github-cli");
    expect(idsOf(response.items)).not.toContain("pack:himalaya");
  });

  it("caches a search for 10 minutes and searches again on refresh", async () => {
    const { calls } = stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: { html: homePage("skillsmp", ["quokka-notes"]) },
    }));
    let clock = Date.parse("2026-10-29T10:00:00.000Z");
    const service = wire({ now: () => new Date(clock) });

    await service.list(WORKSPACE, { query: "zebra" });
    expect(calls).toHaveLength(2);

    clock += TEN_MINUTES_MS - 1_000;
    await service.list(WORKSPACE, { query: "zebra" });
    expect(calls).toHaveLength(2);

    clock += 2_000;
    await service.list(WORKSPACE, { query: "zebra" });
    expect(calls).toHaveLength(4);

    await service.list(WORKSPACE, { query: "zebra", refresh: true });
    expect(calls).toHaveLength(6);

    await service.list(WORKSPACE, { query: "zebra", refresh: false });
    expect(calls).toHaveLength(6);
  });

  it("doesn't cache an answer from a marketplace that was down", async () => {
    let skillsmpDown = true;
    const { calls } = stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: skillsmpDown ? { down: true } : { html: homePage("skillsmp", ["quokka-notes"]) },
    }));
    const service = wire();

    const degraded = await service.list(WORKSPACE, { query: "quokka" });
    expect(degraded.unavailableProviders).toEqual(["SkillsMP"]);
    expect(idsOf(degraded.items)).not.toContain("source:skillsmp.com/skills/quokka-notes");
    expect(calls).toHaveLength(2);

    // The next search asks again, and now finds it.
    skillsmpDown = false;
    const recovered = await service.list(WORKSPACE, { query: "quokka" });
    expect(calls).toHaveLength(4);
    expect(recovered.unavailableProviders).toEqual([]);
    expect(idsOf(recovered.items)).toContain("source:skillsmp.com/skills/quokka-notes");

    // A whole answer is kept.
    await service.list(WORKSPACE, { query: "quokka" });
    expect(calls).toHaveLength(4);
  });

  it("shares one fetch between searches that run at the same time", async () => {
    const { calls } = stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: { html: homePage("skillsmp", ["quokka-notes"]) },
    }));
    const service = wire();

    const [first, second] = await Promise.all([
      service.list(WORKSPACE, { query: "zebra" }),
      service.list(WORKSPACE, { query: "quokka" }),
    ]);

    expect(calls).toHaveLength(2);
    expect(idsOf(first.items)).toContain("source:agentskill.sh/skills/zebra-planner");
    expect(idsOf(second.items)).toContain("source:skillsmp.com/skills/quokka-notes");
  });

  it("ranks a second term from the cached answer without fetching again", async () => {
    const { calls } = stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: { html: homePage("skillsmp", ["quokka-notes"]) },
    }));
    const service = wire();

    const zebra = await service.list(WORKSPACE, { query: "zebra" });
    const quokka = await service.list(WORKSPACE, { query: "  QUOKKA " });

    expect(calls).toHaveLength(2);
    expect(idsOf(zebra.items)).toContain("source:agentskill.sh/skills/zebra-planner");
    expect(idsOf(zebra.items)).not.toContain("source:skillsmp.com/skills/quokka-notes");
    expect(quokka.query).toBe("quokka");
    expect(idsOf(quokka.items)).toContain("source:skillsmp.com/skills/quokka-notes");
    expect(idsOf(quokka.items)).not.toContain("source:agentskill.sh/skills/zebra-planner");
  });

  it("leaves out the GoG listing", async () => {
    stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", []) },
      skillsmp: { html: homePage("skillsmp", []) },
    }));
    const service = wire();

    const curated = await service.list(WORKSPACE);
    const searched = await service.list(WORKSPACE, { query: "gog" });

    expect(idsOf(curated.items)).not.toContain(GOG_ID);
    expect(idsOf(searched.items)).not.toContain(GOG_ID);
    // The other curated Google-adjacent listings are still offered.
    expect(curated.items.some((item) => item.id.startsWith("source:clawhub.ai/"))).toBe(true);
  });

  it("labels each listing by its provider", async () => {
    stubMarketplaces(() => ({
      agentskill: { html: homePage("agentskill", ["zebra-planner"]) },
      skillsmp: { html: homePage("skillsmp", []) },
    }));

    const response = await wire().list(WORKSPACE, { query: "zebra" });

    expect(itemOf(response.items, "source:agentskill.sh/skills/zebra-planner")).toMatchObject({
      provider: "agentskill",
      providerLabel: "AgentSkill",
      name: "Zebra Planner",
      state: "view_only",
      listingUrl: "https://agentskill.sh/skills/zebra-planner",
    });
  });
});
