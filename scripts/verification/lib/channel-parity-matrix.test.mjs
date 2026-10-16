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
  assert.equal(new Set(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => row.id)).size, 24);
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
  assert.equal(signal?.proof.inboundQuarantine, undefined);
  const signalStream = byId.get("signal.daemon-events");
  assert.equal(signalStream?.expected.inboundModes[0], "stream");
  assert.equal(signalStream?.expected.lifecycle, "persistent");
  assert.equal(signalStream?.durability.inboundCommitBeforeAck, false);
  assert.equal(signalStream?.durability.inboundReplay, "none");
  assert.match(signalStream?.proof.inboundAdapter ?? "", /signal-stream-adapter\.test\.ts$/);

  const googleChatWebhook = byId.get("google-chat.webhook");
  assert.deepEqual(googleChatWebhook?.expected.inboundModes, ["none"]);
  assert.equal(googleChatWebhook?.expected.outboundTransport, "webhook");
  const googleChatApp = byId.get("google-chat.app-service-account");
  assert.deepEqual(googleChatApp?.expected.inboundModes, ["webhook"]);
  assert.equal(googleChatApp?.expected.outboundTransport, "api");
  assert.equal(googleChatApp?.durability.inboundCommitBeforeAck, true);
  assert.match(googleChatApp?.proof.inboundAdapter ?? "", /integrations\.google-chat-webhook\.test\.ts$/);

  const blueBubbles = byId.get("imessage.bluebubbles");
  const photon = byId.get("imessage.photon-diagnostics");
  assert.equal(blueBubbles?.callability, "callable");
  assert.equal(photon?.callability, "diagnostic_only");
  assert.equal(photon?.durability.outboundCommitBeforeSend, false);
  assert.equal(photon?.durability.unknownAfterSend, "blocked_before_send");
  assert.equal(photon?.liveEnvironment.status, "not_applicable");
  assert.match(photon?.proof.outboundBlocked ?? "", /tool-executor-channel-failures/);
});

const NO_PROVIDER_ACK_STREAM_ROWS = new Set([
  "ntfy.publish-and-stream",
  "signal.daemon-events",
  "mattermost.bot-websocket",
]);

test("stream rows without provider acknowledgement or replay state that honestly", () => {
  const byId = new Map(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => [row.id, row]));
  for (const id of ["signal.daemon-events", "mattermost.bot-websocket"]) {
    const row = byId.get(id);
    assert.equal(row?.durability.inboundCommitBeforeAck, false, id);
    assert.equal(row?.durability.inboundReplay, "none", id);
    assert.equal(row?.durability.restartRecovery, "no_provider_replay_messages_lost_while_disconnected", id);
  }
  const ntfy = byId.get("ntfy.publish-and-stream");
  assert.equal(ntfy?.durability.inboundCommitBeforeAck, false);
  assert.equal(ntfy?.durability.inboundReplay, "in_process_reconnect_only");
  assert.equal(ntfy?.durability.restartRecovery, "no_replay_after_restart_messages_skipped");
  for (const row of ADVERTISED_CHANNEL_PARITY_MATRIX) {
    if (row.expected.lifecycle === "persistent" && !NO_PROVIDER_ACK_STREAM_ROWS.has(row.id)) {
      assert.equal(row.durability.restartRecovery, "persistent_runtime_plus_shared_durable_recovery", row.id);
    }
  }
});

test("an inbound row that drops commit-before-ack without stating replay fails validation", () => {
  const signalStream = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "signal.daemon-events");
  const { inboundReplay: _omitted, ...durability } = signalStream.durability;
  assert.deepEqual(validateAdvertisedChannelParityMatrix([{ ...signalStream, durability }]).slice(0, 1), [
    "signal.daemon-events has inbound without commit-before-ack and must state durability.inboundReplay",
  ]);
});

test("inbound-capable rows require commit-before-ack, dedupe, and final-reply recovery proof", () => {
  for (const row of ADVERTISED_CHANNEL_PARITY_MATRIX) {
    const inboundCapable = row.expected.inboundModes.some((mode) => mode !== "none");
    assert.equal(
      row.durability.inboundCommitBeforeAck,
      inboundCapable && !NO_PROVIDER_ACK_STREAM_ROWS.has(row.id),
      row.id,
    );
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
