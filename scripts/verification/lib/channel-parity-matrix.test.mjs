import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ADVERTISED_CHANNEL_PARITY_MATRIX,
  REQUIRED_CHANNEL_FAMILIES,
  validateAdvertisedChannelParityMatrix,
} from "./channel-parity-matrix.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

test("advertised channel parity matrix is complete and internally consistent", () => {
  assert.deepEqual(validateAdvertisedChannelParityMatrix(), []);
  assert.equal(new Set(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => row.id)).size, 20);
  assert.deepEqual(
    [...new Set(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => row.family))].sort(),
    [...REQUIRED_CHANNEL_FAMILIES].sort(),
  );
});

test("Slack and Discord variants retain exact inbound and lifecycle posture", () => {
  const byId = new Map(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => [row.id, row]));
  assert.deepEqual(byId.get("slack.bot-signed")?.expected.inboundModes, ["webhook"]);
  assert.deepEqual(byId.get("slack.bot-outbound")?.expected.inboundModes, ["none"]);
  assert.deepEqual(byId.get("slack.webhook-signed")?.expected.inboundModes, ["webhook"]);
  assert.deepEqual(byId.get("slack.webhook-outbound")?.expected.inboundModes, ["none"]);
  assert.equal(byId.get("discord.gateway")?.expected.lifecycle, "persistent");
  assert.deepEqual(byId.get("discord.gateway")?.expected.inboundModes, ["gateway"]);
  assert.equal(byId.get("discord.bridge")?.expected.lifecycle, "stateless");
  assert.deepEqual(byId.get("discord.bridge")?.expected.inboundModes, ["none"]);
  assert.deepEqual(byId.get("discord.webhook")?.expected.inboundModes, ["none"]);
  assert.match(byId.get("discord.gateway")?.proof.reconnect ?? "", /discord-runtime-service/);
});

test("hard quarantine and provider-callability truths cannot drift green", () => {
  const byId = new Map(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => [row.id, row]));
  const signal = byId.get("signal.bridge-outbound");
  assert.equal(signal?.expected.inboundModes[0], "none");
  assert.equal(signal?.durability.inboundCommitBeforeAck, false);
  assert.match(signal?.proof.inboundQuarantine ?? "", /signal-inbound-runtime-service/);

  const blueBubbles = byId.get("imessage.bluebubbles");
  const photon = byId.get("imessage.photon-diagnostics");
  assert.equal(blueBubbles?.callability, "callable");
  assert.equal(photon?.callability, "diagnostic_only");
  assert.equal(photon?.durability.outboundCommitBeforeSend, false);
  assert.equal(photon?.durability.unknownAfterSend, "blocked_before_send");
  assert.equal(photon?.liveEnvironment.status, "not_applicable");
  assert.match(photon?.proof.outboundBlocked ?? "", /tool-executor-channel-failures/);
});

test("inbound-capable rows require commit-before-ack, dedupe, and final-reply recovery proof", () => {
  for (const row of ADVERTISED_CHANNEL_PARITY_MATRIX) {
    const inboundCapable = row.expected.inboundModes.some((mode) => mode !== "none");
    assert.equal(row.durability.inboundCommitBeforeAck, inboundCapable, row.id);
    if (inboundCapable) {
      assert.equal(row.durability.dedupeReplay, "persistent_provider_identity", row.id);
      assert.equal(row.durability.finalReplyRecovery, "deterministic_delivery_idempotency", row.id);
      assert.match(row.proof.sharedInbound ?? "", /inbound-channel-event-service/, row.id);
      assert.ok(row.proof.inboundAdapter, `${row.id} is missing its adapter ingress proof`);
    }
  }
});

test("every evidence anchor exists and external live validation stays explicitly unclaimed", async () => {
  const proofPaths = new Set();
  for (const row of ADVERTISED_CHANNEL_PARITY_MATRIX) {
    assert.notEqual(row.liveEnvironment.status, "passed", row.id);
    for (const value of Object.values(row.proof)) {
      if (typeof value === "string") {
        proofPaths.add(value);
      }
    }
  }
  await Promise.all(
    [...proofPaths].map(async (proofPath) => {
      await fs.access(path.join(repoRoot, proofPath));
    }),
  );
});
