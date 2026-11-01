// Local proof for browser errands. Serves a fixture store on 127.0.0.1 and, unless --fixtures-only is given,
// asks a running Gateway (browser errands flag ON, Chat Web access ON) to buy something from it in Chat.
//
//   node scripts/dev/errand-local-proof.mjs [--scenario buy|signin] [--port 4799] [--fixtures-only]
//
// Environment (or flags):
//   GOATCITADEL_GATEWAY_URL   default http://127.0.0.1:8787   (--gateway <url>)
//   GOATCITADEL_AUTH_TOKEN    bearer token, if the Gateway uses token auth   (--token <token>)
//
// Expected: search and "Add to Cart" run without asking; "Place your order" asks for approval (approve it in the
// window, or answer "Not now" in Chat to see `declined`); the sign-in scenario hands the window to you.
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
const token = option("--token", process.env.GOATCITADEL_AUTH_TOKEN ?? "");
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

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (flag("--fixtures-only")) {
  console.log("Fixtures only: press Ctrl+C to stop.");
} else {
  await driveErrand();
  shutdown();
}

async function api(path, init = {}) {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
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
    "Watch the errand window. For 'buy', approve \"Place your order\" in the window (or answer Not now in Chat to see `declined`).\n" +
      "For 'signin', the banner should read \"Sign in, then press Hand back\".\n" +
      "Requires: Settings > Tools > Browser errands ON, Chat Web access ON, and a logged-in model provider.\n",
  );

  const session = await api("/api/v1/chat/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Browser errand local proof" }),
  });
  const sessionId = session.sessionId ?? session.id;
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

  const seen = new Set();
  const deadline = Date.now() + 25 * 60 * 1000;
  let sendResult;
  send.then((result) => {
    sendResult = result;
  });
  while (Date.now() < deadline && !sendResult) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const history = await api(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/history`);
      const messages = Array.isArray(history) ? history : (history.items ?? history.messages ?? []);
      for (const message of messages) {
        const id = message.messageId ?? message.id ?? JSON.stringify(message).slice(0, 80);
        if (seen.has(id)) continue;
        seen.add(id);
        const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        console.log(`[${message.role ?? "message"}] ${String(text).slice(0, 400)}`);
      }
    } catch (error) {
      console.log(`(history poll failed: ${error.message})`);
    }
  }
  if (sendResult && !sendResult.ok) {
    console.error(`Send failed: ${sendResult.error.message}`);
    process.exitCode = 1;
  } else {
    console.log(
      "\nTurn finished. Check Chat for the errand result (done / declined / handed back) and the final screenshot.",
    );
  }
}
