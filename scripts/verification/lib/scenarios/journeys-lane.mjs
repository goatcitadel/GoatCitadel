// Outcome journeys: end-to-end user verbs proven against the real booted
// stack. Split unit coverage has twice concealed composition defects that only
// running the loop exposes (the hooks feature shipped green yet dead on
// arrival; scenario 12's admission and mesh-join defects). Each journey here
// is phrased as an operator outcome, not an internal invariant.
//
// Journeys covered elsewhere (deliberately not duplicated):
// - approval -> grant -> tool executes / candidate promote+revoke under
//   evolution governance: operator-proof.api.chat-code-mode-lifecycle
// - channel create -> durable delivery: agentic.channels.durable-delivery-runtime
// - turn completes and replays after restart: runtime-truth.approval-restart-durable-truth
// Follow-up queued for this lane: a ward deny -> live tool invoke blocked +
// audited journey (needs the gate's action-string mapping pinned first).

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import https from "node:https";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopVerificationStack,
} from "../runtime.mjs";
import { runScenario, writeJson } from "../shared.mjs";
import { ensureOnboardingComplete } from "../scenarios.mjs";

const execFileAsync = promisify(execFile);

export const JOURNEYS_LANE = "journeys";

// Hook webhook URLs are https-only by policy, so the delivery receiver must
// terminate TLS. The loopback-only pair (SAN IP:127.0.0.1) is minted fresh
// per run with openssl — nothing key-shaped is ever committed, so secret
// scanning stays fully armed. Hosts without openssl report an honest hold.
const OPENSSL_CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
];

async function mintLoopbackTlsMaterial(directory) {
  const keyPath = path.join(directory, "loopback-key.pem");
  const certPath = path.join(directory, "loopback-cert.pem");
  const args = [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "2",
    "-nodes",
    "-subj",
    "/CN=goatcitadel-journeys-loopback",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ];
  let lastError;
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      await execFileAsync(candidate, args);
      return {
        cert: await fs.readFile(certPath, "utf8"),
        key: await fs.readFile(keyPath, "utf8"),
        certPath,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return { unavailable: lastError instanceof Error ? lastError.message : String(lastError ?? "openssl not found") };
}

function assertOk(response, label) {
  if (!response?.ok) {
    throw new Error(`request ${label} failed (${response?.status ?? "no status"}): ${JSON.stringify(response?.body ?? null)}`);
  }
}

/**
 * Allow loopback webhook deliveries in this runtime only. Hooks have their own
 * egress trust decision (`toolPolicy.hooks.networkAllowlist`); the network
 * guard blocks loopback unless it is explicitly allowlisted, so the journey
 * pins exactly the receiver host. Mirrors writeAutonomyGrantRuntimeToolPolicy's
 * unified-config sync, including dropping the stale generation digest.
 */
async function writeJourneysRuntimeToolPolicy(runtimeRoot) {
  const toolPolicyPath = path.join(runtimeRoot, "config", "tool-policy.json");
  let toolPolicy = {};
  try {
    toolPolicy = JSON.parse(await fs.readFile(toolPolicyPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  toolPolicy = { ...toolPolicy, hooks: { ...(toolPolicy.hooks ?? {}), networkAllowlist: ["127.0.0.1"] } };
  await writeJson(toolPolicyPath, toolPolicy);

  const unifiedPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  try {
    const unified = JSON.parse(await fs.readFile(unifiedPath, "utf8"));
    if (unified && typeof unified === "object" && !Array.isArray(unified)) {
      const updated = { ...unified, toolPolicy };
      delete updated.generation;
      await writeJson(unifiedPath, updated);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function startLoopbackHookReceiver(tls) {
  const deliveries = [];
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({
        url: request.url,
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        deliveries,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function verifyHookSignature(delivery, secret) {
  const timestamp = delivery.headers["x-goatcitadel-timestamp"];
  const signature = delivery.headers["x-goatcitadel-signature"];
  if (!timestamp || !signature) {
    throw new Error(`hook delivery is missing signature headers: ${JSON.stringify(Object.keys(delivery.headers))}`);
  }
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${delivery.body}`, "utf8").digest("hex")}`;
  const matches =
    expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!matches) {
    throw new Error("hook delivery signature did not verify against the configured secret");
  }
}

export async function runJourneysLane(context) {
  const runtimeRoot = await prepareVerificationRuntime(context.runId);
  await writeJourneysRuntimeToolPolicy(runtimeRoot);
  const tlsDir = path.join(runtimeRoot, "journeys-tls");
  await fs.mkdir(tlsDir, { recursive: true });
  const tls = await mintLoopbackTlsMaterial(tlsDir);
  if ("unavailable" in tls) {
    await runScenario(
      context,
      {
        id: "journey.hooks.webhook-delivery",
        lane: JOURNEYS_LANE,
        title: "An operator creates a webhook hook, test-fires it, and a signed delivery arrives",
        subsystem: "hooks",
      },
      async () => ({
        status: "skipped",
        notes: [
          `HOLD: openssl is unavailable on this host (${String(tls.unavailable).slice(0, 200)}), so the loopback TLS receiver cannot mint its per-run certificate. Install openssl to activate this journey.`,
        ],
      }),
    );
    return;
  }

  let stack;
  let receiver;
  try {
    stack = await startVerificationStack(context, {
      includeUi: false,
      runtimeRoot,
      // Signed hook custody REQUIRES a real secret store: creating a hook
      // seals its secret into the OS keychain, so the harness default of
      // disabling the store would make every signed-hook outcome unreachable.
      gatewayEnv: { NODE_EXTRA_CA_CERTS: tls.certPath, GOATCITADEL_DISABLE_SECRET_STORE: "false" },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-journeys");
    receiver = await startLoopbackHookReceiver(tls);

    await runScenario(
      context,
      {
        id: "journey.hooks.webhook-delivery",
        lane: JOURNEYS_LANE,
        title: "An operator creates a webhook hook, test-fires it, and a signed delivery arrives",
        subsystem: "hooks",
      },
      async () => {
        const secret = `journey-secret-${randomUUID()}`;
        const receiverUrl = `https://127.0.0.1:${receiver.port}/journey-hook`;

        const created = await requestJson(stack.gatewayUrl, "/api/v1/workspaces/default/hooks", {
          method: "POST",
          body: {
            label: "Journey delivery hook",
            trigger: "tool.call.after",
            mode: "observe",
            enabled: true,
            dataScope: "metadata",
            action: { type: "webhook", webhook: { url: receiverUrl, secret } },
          },
        });
        if (!created.ok && JSON.stringify(created.body ?? "").includes("keychain backend is unavailable")) {
          // Honest hold, not a red: signed hook custody needs an OS keyring,
          // which headless CI hosts do not provide by default.
          return {
            status: "skipped",
            notes: [
              "HOLD: no OS keychain/keyring on this host, so signed hook custody cannot be exercised. Provision a headless keyring (e.g. gnome-keyring over dbus) to activate this journey.",
            ],
          };
        }
        assertOk(created, "create journey webhook hook");
        const hookId = created.body?.hookId;
        if (!hookId) {
          throw new Error(`hook create returned no hookId: ${JSON.stringify(created.body)}`);
        }

        // The SSRF posture is part of the same outcome: a metadata-endpoint
        // destination must be refused at create time even though public https
        // is open by default.
        const ssrfRefused = await requestJson(stack.gatewayUrl, "/api/v1/workspaces/default/hooks", {
          method: "POST",
          body: {
            label: "Journey SSRF probe",
            trigger: "tool.call.after",
            mode: "observe",
            enabled: true,
            dataScope: "metadata",
            action: { type: "webhook", webhook: { url: "https://169.254.169.254/latest/meta-data", secret } },
          },
        });
        if (ssrfRefused.ok) {
          throw new Error("hook create accepted a metadata-endpoint destination; SSRF guard did not hold");
        }

        const fired = await requestJson(
          stack.gatewayUrl,
          `/api/v1/workspaces/default/hooks/${encodeURIComponent(hookId)}/test`,
          { method: "POST", body: {} },
        );
        assertOk(fired, "test-fire journey webhook hook");
        if (fired.body?.status !== "completed") {
          throw new Error(`test delivery did not complete: ${JSON.stringify(fired.body)}`);
        }

        if (receiver.deliveries.length !== 1) {
          throw new Error(`expected exactly one delivery at the receiver, saw ${receiver.deliveries.length}`);
        }
        const delivery = receiver.deliveries[0];
        verifyHookSignature(delivery, secret);
        if (delivery.headers["x-goatcitadel-hook-id"] !== hookId) {
          throw new Error(
            `delivery hook id header mismatch: ${delivery.headers["x-goatcitadel-hook-id"]} !== ${hookId}`,
          );
        }
        const envelope = JSON.parse(delivery.body);
        if (envelope?.payload?.synthetic !== true) {
          throw new Error(`test delivery envelope lost the synthetic marker: ${JSON.stringify(envelope).slice(0, 400)}`);
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "journey-hooks-webhook-delivery.json");
        await writeJson(outPath, {
          hookId,
          run: fired.body,
          delivery: { url: delivery.url, headers: Object.keys(delivery.headers) },
          ssrfRefused: { status: ssrfRefused.status, body: ssrfRefused.body },
        });
        return {
          status: "passed",
          metrics: { deliveries: receiver.deliveries.length, runStatus: fired.body?.status },
        };
      },
    );
  } finally {
    await receiver?.close();
    if (stack) {
      await stopVerificationStack(stack);
    }
  }
}
