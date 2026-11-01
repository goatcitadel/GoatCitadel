// Manual check for the errand browser: opens a headed browser on a scratch profile through the egress guard,
// then waits for Enter. Use it to confirm extensions (for example a password manager) work in the profile.
//
//   pnpm --filter @goatcitadel/policy-engine build
//   node scripts/dev/errand-browser-smoke.mjs [--channel chrome]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "../../packages/policy-engine/dist/index.js");
if (!fs.existsSync(distEntry)) {
  console.error("Build the policy engine first: pnpm --filter @goatcitadel/policy-engine build");
  process.exit(1);
}
const { launchErrandBrowser } = await import(pathToFileURL(distEntry).href);

const channelIndex = process.argv.indexOf("--channel");
const channel = channelIndex >= 0 ? process.argv[channelIndex + 1] : undefined;
if (channel !== undefined && channel !== "chrome") {
  console.error('Only "--channel chrome" is supported.');
  process.exit(1);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-smoke-"));
console.log(`Scratch profile: ${profileDir}`);
const browser = await launchErrandBrowser({
  profileDir,
  channel,
  headless: false,
  networkAllowlist: ["*"],
});
await browser.page().goto("https://example.com");
console.log("Browser is open. Press Enter here to close it and delete the scratch profile.");
await new Promise((resolve) => {
  browser.onClosed(resolve);
  readline.createInterface({ input: process.stdin }).once("line", resolve);
});
await browser.close();
fs.rmSync(profileDir, { recursive: true, force: true });
