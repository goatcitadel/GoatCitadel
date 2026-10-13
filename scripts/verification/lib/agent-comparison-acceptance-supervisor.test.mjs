import assert from "node:assert/strict";
import { it } from "node:test";
import { sha256 } from "./agent-comparison.mjs";
import {
  createAcceptanceSupervisor,
  prepareFeatureAcceptanceLaunch,
  readAcceptanceDriverFingerprint,
} from "./agent-comparison-acceptance-supervisor.mjs";
import { FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";

it("launch review binds imported authority helpers and native children, not just the entry module", async () => {
  const fingerprint = await readAcceptanceDriverFingerprint();
  assert.equal(fingerprint.sha256, sha256(fingerprint.files));
  for (const name of [
    "agent-comparison-acceptance-faults.mjs",
    "agent-comparison-provider.mjs",
    "agent-comparison-session.mjs",
    "agent-comparison-native-driver.mjs",
    "agent-comparison-native-approval-console.mjs",
    "agent-comparison-acceptance-goat-child.mjs",
    "agent-comparison-acceptance-openclaw-child.mjs",
  ])
    assert.match(fingerprint.files.find((file) => file.name === name)?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(await readAcceptanceDriverFingerprint(), fingerprint);
});

it("refuses inline credentials and missing launch review before opening a review console or runtime", async () => {
  let consoleOpened = false;
  const reviewConsoleFactory = () => {
    consoleOpened = true;
    throw new Error("must not open");
  };
  for (const settings of [
    undefined,
    {},
    {
      operatorId: "reviewer",
      expectedLaunchSha256: "a".repeat(64),
      executablePath: process.execPath,
      apiKey: "controlled-forbidden-inline-value",
    },
  ]) {
    await assert.rejects(createAcceptanceSupervisor({ settings, reviewConsoleFactory }), /exact supervisor launch/);
  }
  assert.equal(consoleOpened, false);
});

it("unsupported native recovery stops read-only launch preparation before checkout or executable access", async () => {
  await assert.rejects(
    prepareFeatureAcceptanceLaunch({
      manifest: { products: { openclaw: { revision: FEATURE_ACCEPTANCE_PINS.openclaw, contextTokens: 64000 } } },
      options: { cellId: "openclaw:scheduled_agent_work:1", checkoutRoot: "missing-checkout" },
      executablePath: "missing-executable",
    }),
    /unsupported/,
  );
});
