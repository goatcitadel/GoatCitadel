// Local proof for browser errands. Serves a fixture store on 127.0.0.1 and, unless --fixtures-only is given,
// asks a running Gateway (browser errands flag ON, Chat Web access ON) to buy something from it in Chat.
//
//   node scripts/dev/errand-local-proof.mjs [--scenario buy|decline|signin] [--port 4799] [--fixtures-only]
//
// Environment (or flags):
//   GOATCITADEL_GATEWAY_URL   default http://127.0.0.1:8787   (--gateway <url>)
//   GOATCITADEL_AUTH_TOKEN    bearer token, if the Gateway uses token auth (preferred over --token, which shows in
//                             your shell history)
//   GOATCITADEL_WORKSPACE_ID  workspace for the Chat session (--workspace <id>); the Gateway's default when unset
//
// The fixture is on loopback, which errands never reach by default: the "*" errands add to the network allowlist
// covers public hosts only. Run this against a THROWAWAY Gateway whose config adds an explicit "127.0.0.1" entry to
// toolPolicy.sandbox.networkAllowlist (scratch config and data dirs); never add it to your everyday config.
//
// Expected: search and "Add to Cart" run without asking; "Place your order" asks for approval. buy: approve it, and
// the errand ends `done`. decline: answer "Not now", and it ends `declined`. signin: the window is handed to you
// (the errand waits on you); sign in, press Hand back, and it ends `done`. The script exits non-zero when the
// browser.errand tool run does not finish that way, or does not finish within 25 minutes.
import { randomUUID } from "node:crypto";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(option("--port", "4799"));
const scenario = option("--scenario", "buy");
const gatewayUrl = option("--gateway", process.env.GOATCITADEL_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(
  /\/+$/u,
  "",
);
const token = process.env.GOATCITADEL_AUTH_TOKEN ?? option("--token", "");
const workspaceOverride = option("--workspace", process.env.GOATCITADEL_WORKSPACE_ID ?? "");
const EXPECTED = {
  buy: { outcome: "done" },
  decline: { outcome: "declined" },
  signin: { outcome: "done", handedOver: true },
};
if (!EXPECTED[scenario]) {
  console.error(`Unknown scenario "${scenario}". Use buy, decline or signin.`);
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:18px sans-serif;margin:40px;max-width:640px}button,input{font-size:18px;padding:8px;margin:4px 0}</style>` +
  `</head><body><h1>${title}</h1>${body}</body></html>`;

const routes = {
  "/": () =>
    page(
      "Fixture Store",
      `<form action="/search"><input name="q" placeholder="Search the store" aria-label="Search"><button type="submit">Search</button></form>`,
    ),
  "/search": () => page("Results", `<p><a href="/product">Fixture Widget - $19.99</a></p>`),
  "/product": () =>
    page(
      "Fixture Widget",
      `<p>Price: $19.99</p><form action="/cart"><button type="submit">Add to Cart</button></form>`,
    ),
  "/cart": () =>
    page(
      "Your cart",
      `<p>1 x Fixture Widget</p><p>Order total: $19.99</p><form action="/thanks"><button type="submit">Place your order</button></form>`,
    ),
  "/signin": () =>
    page(
      "Sign in",
      `<form action="/cart"><label>Email <input name="email" type="email"></label><br>` +
        `<label>Password <input name="password" type="password"></label><br><button type="submit">Sign in</button></form>`,
    ),
  "/thanks": () => page("Thanks", `<p>Thanks! Your order was placed (fixture only, nothing was bought).</p>`),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", base);
  const render = routes[url.pathname];
  if (!render) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(render());
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(`Fixture store listening at ${base}/`);

// process.exit() keeps the exit code a failed proof set.
const shutdown = () => server.close(() => process.exit());
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (flag("--fixtures-only")) {
  console.log("Fixtures only: press Ctrl+C to stop.");
} else {
  await driveErrand();
  shutdown();
}

async function api(path, init = {}) {
  const mutating = init.method !== undefined && init.method !== "GET";
  const headers = {
    "content-type": "application/json",
    ...(mutating ? { "idempotency-key": randomUUID() } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`${gatewayUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function driveErrand() {
  const start = scenario === "signin" ? `${base}/signin` : `${base}/`;
  const task =
    scenario === "signin"
      ? `Use a browser errand to open ${start} and sign in to the store, then tell me what you see.`
      : `Use a browser errand: open ${start}, search for "widget", add the Fixture Widget to the cart, and place the order.`;
  console.log(`\nScenario: ${scenario}\nGateway: ${gatewayUrl}\nTask sent to Chat:\n  ${task}\n`);
  console.log(
    "Watch the errand window. For 'buy', approve \"Place your order\" in the window; for 'decline', answer Not now in Chat.\n" +
      "For 'signin', the banner should read \"Sign in, then press Hand back\".\n" +
      "Requires: Settings > Tools > Browser errands ON, Chat Web access ON, and a logged-in model provider.\n",
  );

  const session = await api("/api/v1/chat/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "Browser errand local proof",
      ...(workspaceOverride ? { workspaceId: workspaceOverride } : {}),
    }),
  });
  const sessionId = session.sessionId;
  if (!sessionId) throw new Error("Gateway did not return a session id.");
  console.log(`Chat session: ${sessionId}`);

  // The send call may stay open for the whole turn; do not block the polling on it.
  const send = api(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`, {
    method: "POST",
    body: JSON.stringify({ content: task }),
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );

  const workspaceId = session.workspaceId ?? (workspaceOverride || "default");
  const seen = new Set();
  const printNew = async () => {
    const history = await api(
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/history?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
    );
    for (const message of history.items ?? []) {
      if (seen.has(message.messageId)) continue;
      seen.add(message.messageId);
      console.log(`[${message.role}] ${String(message.content).slice(0, 400)}`);
    }
  };
  // The canonical record: the turn's browser.errand tool run, and (while it runs) the errand's live state.
  let errandRun;
  let handedOver = false;
  const readErrand = async () => {
    const thread = await api(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
    const runs = (thread.turns ?? []).flatMap((turn) => turn.toolRuns ?? []);
    errandRun = runs.find((run) => run.toolName === "browser.errand") ?? errandRun;
    if (errandRun && !errandRun.finishedAt) {
      const status = await api(`/api/v1/browser-errands/by-tool-run/${encodeURIComponent(errandRun.toolRunId)}`);
      if (status?.state === "waiting_on_you") handedOver = true;
    }
  };
  const deadline = Date.now() + 25 * 60 * 1000;
  let sendResult;
  send.then((result) => {
    sendResult = result;
  });
  while (Date.now() < deadline && !sendResult) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      await printNew();
      await readErrand();
    } catch (error) {
      console.log(`(poll failed: ${error.message})`);
    }
  }
  try {
    await printNew();
    await readErrand();
  } catch (error) {
    console.log(`(final read failed: ${error.message})`);
  }
  const failures = [];
  if (!sendResult) failures.push("the turn did not finish within 25 minutes");
  else if (!sendResult.ok) failures.push(`the send failed: ${sendResult.error.message}`);
  const expected = EXPECTED[scenario];
  const outcome = errandRun?.result?.outcome;
  if (!errandRun) {
    failures.push("the turn ran no browser.errand tool");
  } else if (outcome !== expected.outcome) {
    failures.push(
      `the errand ended ${outcome ?? `with no outcome (tool run ${errandRun.status})`}, not ${expected.outcome}`,
    );
  }
  if (expected.handedOver && !handedOver) failures.push("the errand was never seen waiting on you to sign in");
  if (failures.length > 0) {
    console.error(`\nProof FAILED (${scenario}): ${failures.join("; ")}.`);
    process.exitCode = 1;
  } else {
    console.log(`\nProof passed (${scenario}): the errand ended ${outcome}. Check the final screenshot in Chat.`);
  }
}
