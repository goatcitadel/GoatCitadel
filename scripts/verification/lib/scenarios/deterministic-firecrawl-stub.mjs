import { createServer } from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3002;
const MAX_BODY_BYTES = 1024 * 1024;

export const DETERMINISTIC_FIRECRAWL_RESULTS = new Map([
  [
    normalizeQuery("official Magic Pokemon Yu-Gi-Oh trading card game products organized play"),
    [
      result(
        "Magic: The Gathering official products and play",
        "https://magic.wizards.com/en/products",
        "Wizards of the Coast documents current Magic products, formats, and play entry points.",
      ),
      result(
        "Pokémon Trading Card Game official hub",
        "https://www.pokemon.com/us/pokemon-tcg/",
        "The Pokémon Company documents Pokémon TCG products, rules, and community play.",
      ),
      result(
        "Yu-Gi-Oh! Trading Card Game official hub",
        "https://www.yugioh-card.com/en/",
        "Konami documents Yu-Gi-Oh! products, rules, events, and organized play.",
      ),
    ],
  ],
  [
    normalizeQuery("official One Piece Disney Lorcana Flesh and Blood trading card game organized play"),
    [
      result(
        "One Piece Card Game official hub",
        "https://en.onepiece-cardgame.com/",
        "Bandai documents One Piece Card Game products, rules, and tournament support.",
      ),
      result(
        "Disney Lorcana official hub",
        "https://www.disneylorcana.com/en-US/",
        "Ravensburger documents Disney Lorcana products, gameplay, and community support.",
      ),
      result(
        "Flesh and Blood official hub",
        "https://fabtcg.com/en/",
        "Legend Story Studios documents Flesh and Blood heroes, products, and organized play.",
      ),
    ],
  ],
  [
    normalizeQuery("official Star Wars Unlimited Riftbound Gundam card game organized play"),
    [
      result(
        "Star Wars: Unlimited official hub",
        "https://starwarsunlimited.com/",
        "Fantasy Flight Games documents Star Wars: Unlimited products, gameplay, and store play.",
      ),
      result(
        "Riftbound official hub",
        "https://riftbound.leagueoflegends.com/en-us/",
        "Riot Games documents Riftbound products, gameplay, and organized-play plans.",
      ),
      result(
        "Gundam Card Game official hub",
        "https://www.gundam-gcg.com/en/",
        "Bandai documents Gundam Card Game products, rules, and organized play.",
      ),
    ],
  ],
  [
    normalizeQuery("North America CCG retailer marketplace financial event evidence 2026"),
    [
      result(
        "Trading and collectible card game marketplace",
        "https://www.tcgplayer.com/categories/trading-and-collectible-card-games",
        "TCGplayer provides a broad North American marketplace view across physical collectible card games.",
      ),
      result(
        "ICv2 collectible game market reporting",
        "https://icv2.com/",
        "ICv2 publishes independent trade reporting about hobby games and collectible card categories.",
      ),
      result(
        "Hasbro investor relations and financial reporting",
        "https://investor.hasbro.com/",
        "Hasbro publishes financial and investor reporting relevant to Wizards of the Coast and Magic.",
      ),
      result(
        "Pokémon Trading Card Game Pocket official site",
        "https://tcgpocket.pokemon.com/en-us/",
        "The Pokémon Company documents the digital Pokémon TCG Pocket product.",
      ),
      result(
        "Hearthstone official site",
        "https://hearthstone.blizzard.com/",
        "Blizzard documents the digital-native Hearthstone collectible card game.",
      ),
      result(
        "Marvel Snap official site",
        "https://www.marvelsnap.com/",
        "Second Dinner documents the digital-native Marvel Snap card game.",
      ),
    ],
  ],
]);

export async function startDeterministicFirecrawlStub(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v2/search") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const query = typeof payload?.query === "string" ? payload.query.trim() : "";
    const limit = Math.max(1, Math.min(25, Number(payload?.limit ?? 5)));
    const matched = DETERMINISTIC_FIRECRAWL_RESULTS.get(normalizeQuery(query));
    requests.push({ query, limit, matched: Boolean(matched) });
    if (!matched) {
      writeJson(response, 200, { success: true, data: [] });
      return;
    }
    writeJson(response, 200, { success: true, data: matched.slice(0, limit) });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) =>
      reject(new Error(`Could not start deterministic Firecrawl stub on ${host}:${port}: ${error.message}`));
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("deterministic Firecrawl stub has no TCP address");
  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    requests: () => requests.map((request) => ({ ...request })),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeIdleConnections?.();
        for (const socket of sockets) socket.destroy();
      }),
  };
}

function result(title, url, description) {
  return { title, url, description };
}

function normalizeQuery(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .sort()
    .join(" ");
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}
