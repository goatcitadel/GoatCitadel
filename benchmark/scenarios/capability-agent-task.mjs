// CAPABILITY: the agent completes a real provider-backed task.
//
// Hits POST /api/v1/llm/chat-completions (apps/gateway/src/routes/llm.ts:420).
// This needs a provider API KEY (the "provider keys" edge). Until a key is present
// the scenario reports "skipped: needs provider key" — detected by reading
// GET /api/v1/llm/config, whose provider entries carry { hasApiKey, apiKeySource }.
//
// The same shape is the seam for competitors: once openclaw/hermes expose a
// chat/agent endpoint + baseUrl, point targets.json at them and this runs head-to-head.

import { pass, fail, skip, requestJson, authHeaders } from "../lib/harness.mjs";

async function findConfiguredProvider(baseUrl, headers) {
  const res = await requestJson(baseUrl, "/api/v1/llm/config", { headers });
  if (!res.ok) return { error: `GET /api/v1/llm/config → HTTP ${res.status}` };
  const providers = res.body?.providers ?? res.body?.config?.providers ?? [];
  const list = Array.isArray(providers) ? providers : [];
  const withKey = list.find((p) => p?.hasApiKey === true);
  return { provider: withKey ?? null, providerCount: list.length };
}

export default {
  id: "capability.agent-task",
  axis: "CAPABILITY",
  title: "Provider-backed completion returns a usable answer",
  description:
    "Send a deterministic prompt to a configured provider and assert a non-empty assistant reply. " +
    "Measures that the agent can actually drive a model end-to-end (not just that the route exists).",
  requiresEdges: ["provider-api-keys"],
  mode: "http",

  async run(target, ctx) {
    const baseUrl = ctx?.baseUrl ?? target.baseUrl;

    if (target.kind === "competitor") {
      if (!baseUrl) {
        return skip(`${target.id} not configured (no baseUrl/command) — capability comparison pending its build`);
      }
      // Competitor wire-up is intentionally not implemented yet; the seam is documented.
      return skip(`${target.id} chat endpoint adapter not implemented yet (seam is wired in targets.json)`);
    }

    if (!baseUrl || !ctx?.reachable) {
      return skip("gateway not reachable — start it or pass --spin (HTTP scenario)");
    }
    const headers = authHeaders(target);

    const configured = await findConfiguredProvider(baseUrl, headers);
    if (configured.error) {
      return skip(`could not read provider config (${configured.error})`);
    }
    if (!configured.provider) {
      return skip(
        `needs provider key — no provider reports hasApiKey:true among ${configured.providerCount} configured. ` +
          "Add a key (Settings → Providers or ANTHROPIC_API_KEY/OPENAI_API_KEY), then re-run.",
      );
    }

    const providerId = configured.provider.providerId ?? configured.provider.id;
    const res = await requestJson(baseUrl, "/api/v1/llm/chat-completions", {
      method: "POST",
      headers,
      body: {
        providerId,
        messages: [
          { role: "system", content: "Reply with exactly one word." },
          { role: "user", content: "Respond with the single word: pong" },
        ],
        max_tokens: 16,
        temperature: 0,
      },
    });

    if (!res.ok) {
      // A present key can still be invalid/expired. Distinguish "the key edge is not
      // really satisfied" (skip) from a true capability regression (fail). Auth-shaped
      // rejections mean: supply a VALID key, not that the agent can't drive a model.
      const errorText = JSON.stringify(res.body ?? "").toLowerCase();
      const looksLikeKeyProblem =
        res.status === 401 ||
        res.status === 403 ||
        /api key|unauthor|invalid_?key|authentication|incorrect api|quota|billing|insufficient/.test(errorText);
      if (looksLikeKeyProblem) {
        return skip(
          `provider '${providerId}' reports a key is present (apiKeySource=${configured.provider.apiKeySource}) but rejected the call (HTTP ${res.status}). ` +
            "Supply a VALID key for this provider, then re-run.",
          { body: res.body },
        );
      }
      return fail(`chat-completions failed for provider '${providerId}' (HTTP ${res.status})`, { body: res.body });
    }
    const text =
      res.body?.choices?.[0]?.message?.content ??
      res.body?.message?.content ??
      res.body?.content ??
      "";
    const reply = typeof text === "string" ? text.trim() : JSON.stringify(text);
    if (!reply) {
      return fail(`provider '${providerId}' returned an empty completion`, { body: res.body });
    }
    return pass(`provider '${providerId}' returned a non-empty completion (${reply.length} chars)`, {
      providerId,
      preview: reply.slice(0, 80),
    });
  },
};
