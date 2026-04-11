import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenAiRequest {
  method: string;
  path: string;
  search: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
}

export interface FakeOpenAiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
  sseFrames?: string[];
}

export type FakeOpenAiHandler = (request: FakeOpenAiRequest) => FakeOpenAiResponse | Promise<FakeOpenAiResponse>;

export interface FakeOpenAiServer {
  baseUrl: string;
  requests: FakeOpenAiRequest[];
  close: () => Promise<void>;
}

export async function startFakeOpenAiCompatibleServer(handler?: FakeOpenAiHandler): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiRequest[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const fakeRequest = await buildFakeRequest(request);
      requests.push(fakeRequest);
      const fakeResponse = await (handler ?? defaultFakeOpenAiHandler)(fakeRequest);
      await writeFakeResponse(response, fakeResponse);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "fake provider failed" }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function defaultFakeOpenAiHandler(request: FakeOpenAiRequest): FakeOpenAiResponse {
  if (request.method === "GET" && request.path === "/v1/models") {
    return {
      body: {
        data: [
          { id: "fake-chat", object: "model", owned_by: "goatcitadel-test" },
          { id: "fake-tools", object: "model", owned_by: "goatcitadel-test" },
        ],
      },
    };
  }

  if (request.method === "POST" && request.path === "/v1/chat/completions") {
    const body = asRecord(request.body);
    if (body.stream === true) {
      return {
        sseFrames: [
          JSON.stringify({ id: "fake-stream", choices: [{ index: 0, delta: { content: "hello " } }] }),
          JSON.stringify({
            id: "fake-stream",
            choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          "[DONE]",
        ],
      };
    }

    const tools = Array.isArray(body.tools) ? body.tools : [];
    const firstTool = asRecord(tools[0]);
    const firstFunction = asRecord(firstTool.function);
    if (typeof firstFunction.name === "string" && firstFunction.name.length > 0) {
      return {
        body: {
          id: "fake-tools-response",
          object: "chat.completion",
          model: body.model ?? "fake-tools",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_fake_lookup",
                    type: "function",
                    function: {
                      name: firstFunction.name,
                      arguments: JSON.stringify({ query: "goatcitadel" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      };
    }

    return {
      body: {
        id: "fake-chat-response",
        object: "chat.completion",
        model: body.model ?? "fake-chat",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: body.response_format ? JSON.stringify({ ok: true }) : "fake response",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    };
  }

  return {
    status: 404,
    body: { error: { message: `No fake route for ${request.method} ${request.path}` } },
  };
}

async function buildFakeRequest(request: http.IncomingMessage): Promise<FakeOpenAiRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return {
    method: request.method ?? "GET",
    path: url.pathname,
    search: url.search,
    headers: request.headers,
    body: parseJsonBody(rawBody),
    rawBody,
  };
}

async function writeFakeResponse(response: http.ServerResponse, fakeResponse: FakeOpenAiResponse): Promise<void> {
  if (fakeResponse.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, fakeResponse.delayMs));
  }

  const status = fakeResponse.status ?? 200;
  if (fakeResponse.sseFrames) {
    response.writeHead(status, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      ...fakeResponse.headers,
    });
    for (const frame of fakeResponse.sseFrames) {
      response.write(`data: ${frame}\n\n`);
    }
    response.end();
    return;
  }

  if (typeof fakeResponse.body === "string") {
    response.writeHead(status, fakeResponse.headers);
    response.end(fakeResponse.body);
    return;
  }

  response.writeHead(status, {
    "content-type": "application/json",
    ...fakeResponse.headers,
  });
  response.end(JSON.stringify(fakeResponse.body ?? {}));
}

function parseJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
