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
  const slackSocket = byId.get("slack.bot-socket");
  assert.deepEqual(slackSocket?.expected.inboundModes, ["stream"]);
  assert.equal(slackSocket?.expected.lifecycle, "persistent");
  assert.equal(slackSocket?.durability.inboundCommitBeforeAck, true);
  assert.match(slackSocket?.proof.inboundAdapter ?? "", /slack-socket-stream-adapter\.test\.ts$/);
  assert.equal(byId.get("discord.gateway")?.expected.lifecycle, "persistent");
  assert.deepEqual(byId.get("discord.gateway")?.expected.inboundModes, ["gateway"]);
  assert.equal(byId.get("discord.bridge")?.expected.lifecycle, "stateless");
  assert.deepEqual(byId.get("discord.bridge")?.expected.inboundModes, ["none"]);
  assert.deepEqual(byId.get("discord.webhook")?.expected.inboundModes, ["none"]);
  assert.match(byId.get("discord.gateway")?.proof.reconnect ?? "", /discord-runtime-service/);
});

test("hard quarantine and provider-callability truths cannot drift green", () => {
  const byId = new Map(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => [row.id, row]));
  const googleChatWebhook = byId.get("google-chat.webhook");
  assert.deepEqual(googleChatWebhook?.expected.inboundModes, ["none"]);
  assert.equal(googleChatWebhook?.expected.outboundTransport, "webhook");
  const googleChatApp = byId.get("google-chat.app-service-account");
  assert.deepEqual(googleChatApp?.expected.inboundModes, ["webhook"]);
  assert.equal(googleChatApp?.expected.outboundTransport, "api");
  assert.equal(googleChatApp?.durability.inboundCommitBeforeAck, true);
  assert.match(googleChatApp?.proof.inboundAdapter ?? "", /integrations\.google-chat-webhook\.test\.ts$/);
});

test("retired channels have no advertised parity row", () => {
  for (const family of ["signal", "imessage", "zalouser"]) {
    assert.equal(REQUIRED_CHANNEL_FAMILIES.includes(family), false, family);
    assert.equal(
      ADVERTISED_CHANNEL_PARITY_MATRIX.some((row) => row.family === family || row.channelKey === family),
      false,
      family,
    );
  }
});

const NO_PROVIDER_ACK_STREAM_ROWS = new Set([
  "ntfy.publish-and-stream",
  "mattermost.bot-websocket",
]);

// Stream inbound that does persist a provider cursor and so states its own restart recovery.
const PERSISTED_CURSOR_STREAM_ROWS = new Set(["matrix.sync-stream"]);

test("stream rows without provider acknowledgement or replay state that honestly", () => {
  const byId = new Map(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => [row.id, row]));
  for (const id of ["mattermost.bot-websocket"]) {
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
    if (row.expected.lifecycle === "persistent" && !NO_PROVIDER_ACK_STREAM_ROWS.has(row.id) && !PERSISTED_CURSOR_STREAM_ROWS.has(row.id)) {
      assert.equal(row.durability.restartRecovery, "persistent_runtime_plus_shared_durable_recovery", row.id);
    }
  }
});

test("the Matrix sync stream states its persisted-cursor replay honestly", () => {
  const row = ADVERTISED_CHANNEL_PARITY_MATRIX.find((candidate) => candidate.id === "matrix.sync-stream");
  assert.equal(row?.durability.inboundCommitBeforeAck, true);
  assert.equal(row?.durability.inboundReplay, "persisted_sync_token");
  assert.equal(row?.durability.restartRecovery, "persistent_runtime_resumes_from_persisted_sync_token");
  assert.equal(row?.expected.lifecycle, "persistent");
});

test("an inbound row that drops commit-before-ack without stating replay fails validation", () => {
  const mattermostStream = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "mattermost.bot-websocket");
  const { inboundReplay: _omitted, ...durability } = mattermostStream.durability;
  assert.deepEqual(validateAdvertisedChannelParityMatrix([{ ...mattermostStream, durability }]).slice(0, 1), [
    "mattermost.bot-websocket has inbound without commit-before-ack and must state durability.inboundReplay",
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
