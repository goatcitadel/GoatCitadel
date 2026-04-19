import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.MISSION_CONTROL_BASE_URL ?? "http://127.0.0.1:5180";
const OUTPUT_ROOT = process.env.MISSION_CONTROL_SCREENSHOT_DIR
  ?? path.resolve(process.cwd(), "apps/mission-control/docs/ui-review/2026-04-13-desktop");

const ROUTES = [
  { slug: "01-work-chat", label: "Work · Chat", search: "?space=operate&page=surface&surface=chat" },
  { slug: "02-work-cowork", label: "Work · Cowork", search: "?space=operate&page=surface&surface=cowork" },
  { slug: "03-work-code", label: "Work · Code", search: "?space=operate&page=surface&surface=code" },
  { slug: "04-work-tasks", label: "Work · Tasks", search: "?space=operate&page=tasks" },
  { slug: "05-work-approvals", label: "Work · Approvals", search: "?space=operate&page=approvals" },
  { slug: "06-observe-activity", label: "Watch · Activity", search: "?space=observe&page=activity&tab=activity" },
  { slug: "07-observe-scheduler", label: "Watch · Scheduler", search: "?space=observe&page=activity&tab=scheduler" },
  { slug: "08-observe-improvement", label: "Watch · Improvement", search: "?space=observe&page=activity&tab=improvement" },
  { slug: "09-observe-sessions", label: "Watch · Sessions", search: "?space=observe&page=sessions" },
  { slug: "10-observe-artifacts-memory", label: "Watch · Artifacts / Memory", search: "?space=observe&page=artifacts&tab=memory" },
  { slug: "11-observe-artifacts-files", label: "Watch · Artifacts / Files", search: "?space=observe&page=artifacts&tab=files" },
  { slug: "12-observe-costs", label: "Watch · Costs", search: "?space=observe&page=costs" },
  { slug: "13-observe-system", label: "Watch · System", search: "?space=observe&page=system" },
  { slug: "14-observe-quality", label: "Watch · Quality", search: "?space=observe&page=quality" },
  { slug: "15-tune-general", label: "Setup · General", search: "?space=configure&page=settings&tab=general" },
  { slug: "16-tune-providers", label: "Setup · Providers", search: "?space=configure&page=settings&tab=providers" },
  { slug: "17-tune-access", label: "Setup · Access", search: "?space=configure&page=settings&tab=access" },
  { slug: "18-tune-budget", label: "Setup · Budget", search: "?space=configure&page=settings&tab=budget" },
  { slug: "19-tune-runtime", label: "Setup · Runtime", search: "?space=configure&page=settings&tab=runtime" },
  { slug: "20-tune-workspaces", label: "Setup · Workspaces", search: "?space=configure&page=settings&tab=workspaces" },
  { slug: "21-tune-addons", label: "Setup · Addons", search: "?space=configure&page=settings&tab=addons" },
  { slug: "22-tune-onboarding", label: "Setup · Onboarding", search: "?space=configure&page=settings&tab=onboarding" },
  { slug: "23-tune-integrations-overview", label: "Setup · Integrations / Overview", search: "?space=configure&page=integrations&tab=overview" },
  { slug: "24-tune-integrations-channels", label: "Setup · Integrations / Channels", search: "?space=configure&page=integrations&tab=channels" },
  { slug: "25-tune-integrations-mcp", label: "Setup · Integrations / MCP", search: "?space=configure&page=integrations&tab=mcp" },
  { slug: "26-tune-tools", label: "Setup · Tools", search: "?space=configure&page=tools" },
  { slug: "27-tune-agents-overview", label: "Setup · Agents / Overview", search: "?space=configure&page=agents&tab=overview" },
  { slug: "28-tune-agents-herd-live", label: "Setup · Agents / Herd Live", search: "?space=configure&page=agents&tab=herd-live" },
  { slug: "29-tune-agents-herd-lab", label: "Setup · Agents / Herd Lab", search: "?space=configure&page=agents&tab=herd-lab" },
  { slug: "30-tune-agents-skills", label: "Setup · Agents / Skills", search: "?space=configure&page=agents&tab=skills" },
];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function waitForPageStable(page) {
  await page.waitForSelector("main.shell-main", { timeout: 20_000 });
  await page.waitForTimeout(900);

  const loadingLocator = page.locator(".shell-page-loading");
  const isLoadingVisible = await loadingLocator.isVisible().catch(() => false);
  if (isLoadingVisible) {
    await loadingLocator.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

async function captureAllRoutes() {
  const screenshotsDir = path.join(OUTPUT_ROOT, "screenshots");
  await ensureDir(screenshotsDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    colorScheme: "dark",
    reducedMotion: "no-preference",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const manifest = [];

  for (const route of ROUTES) {
    const targetUrl = `${BASE_URL}/${route.search}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForPageStable(page);

    const fileName = `${route.slug}.png`;
    const filePath = path.join(screenshotsDir, fileName);
    await page.screenshot({ path: filePath, fullPage: true });

    manifest.push({
      ...route,
      url: targetUrl,
      file: path.relative(OUTPUT_ROOT, filePath).replaceAll("\\", "/"),
      title: await page.title(),
    });
  }

  await fs.writeFile(
    path.join(OUTPUT_ROOT, "manifest.json"),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      viewport: { width: 1600, height: 1100 },
      routes: manifest,
    }, null, 2)}\n`,
    "utf8",
  );

  const readme = [
    "# Mission Control Route Screenshots",
    "",
    `Generated from \`${BASE_URL}\` on ${new Date().toISOString()}.`,
    "",
    "## Captured Routes",
    "",
    ...manifest.map((entry) => `- ${entry.label}: \`${entry.file}\``),
    "",
  ].join("\n");

  await fs.writeFile(path.join(OUTPUT_ROOT, "README.md"), `${readme}\n`, "utf8");
  await browser.close();

  console.log(`Saved ${manifest.length} screenshots to ${OUTPUT_ROOT}`);
}

captureAllRoutes().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
