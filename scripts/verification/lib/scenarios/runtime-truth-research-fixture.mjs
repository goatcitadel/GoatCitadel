import { createServer } from "node:http";
import { once } from "node:events";

export const RESEARCH_PROMPT = "Please do some deep research into the best things to include in an agentic harness.";
export const RESEARCH_SOURCE = {
  title: "Harness evaluation checklist",
  url: "https://research-source.test/harness-evaluation",
  snippet: "A checklist for testing agent workflows.",
};
export const RESEARCH_UNUSED_SOURCE = {
  title: "Unrelated search hit",
  url: "https://research-source.test/unused-result",
  snippet: "An unused result that should not appear in the answer sources.",
};
export const RESEARCH_PASSAGE = "Replay deterministic tool results before testing recovery. Record the response from each tool so the replay can be compared with the original run.";
export const RESEARCH_REPLY = [
  "Test recovery with a deterministic replay before introducing faults.",
  "",
  `> ${RESEARCH_PASSAGE} [Evaluation checklist](${RESEARCH_SOURCE.url})`,
].join("\n");

export async function startRuntimeTruthResearchFixture() {
  let searches = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !["/v2/search", "/v2/scrape"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    try {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk;
      const body = JSON.parse(rawBody);
      if (request.url === "/v2/scrape") {
        if (body.url !== RESEARCH_SOURCE.url) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          success: true,
          data: {
            markdown: `# ${RESEARCH_SOURCE.title}\n\n${RESEARCH_PASSAGE}\n\nUse a fresh session for a separate comparison.`,
            metadata: { sourceURL: RESEARCH_SOURCE.url, title: RESEARCH_SOURCE.title, statusCode: 200 },
          },
        }));
        return;
      }
      if (typeof body.query !== "string" || !body.query.trim()) {
        response.writeHead(400).end();
        return;
      }
      searches += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, data: { web: [RESEARCH_SOURCE, RESEARCH_UNUSED_SOURCE] } }));
    } catch {
      response.writeHead(400).end();
    }
  });
  // The Gateway treats this specific loopback endpoint as a local Firecrawl service.
  server.listen(3002, "127.0.0.1");
  await once(server, "listening");
  return {
    gatewayEnv: {
      GOATCITADEL_FIRECRAWL_ENABLED: "true",
      GOATCITADEL_FIRECRAWL_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      GOATCITADEL_FIRECRAWL_DEFAULT_READ_BACKEND: "firecrawl",
      GOATCITADEL_FIRECRAWL_FALLBACK_TO_NATIVE: "false",
      GOATCITADEL_FIRECRAWL_API_KEY_ENV: "GOATCITADEL_VERIFY_STUB_LLM_KEY",
    },
    searchCount: () => searches,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
