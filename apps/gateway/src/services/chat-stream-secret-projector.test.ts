import { describe, expect, it } from "vitest";
import { redactSecretText, type ChatStreamChunkDraft } from "@goatcitadel/contracts";
import { projectChatStreamChunkForPublic } from "./chat-secret-projection.js";
import { ChatStreamSecretProjector } from "./chat-stream-secret-projector.js";

describe("ChatStreamSecretProjector", () => {
  it("contains every split point for each supported credential family", () => {
    const cases = [
      { content: "Authorization: Token abcdef1234567890", secrets: ["abcdef1234567890"] },
      { content: "Bearer hunter2", secrets: ["hunter2"] },
      {
        content: "prefix Bearer abcdef1234567890 suffix",
        secrets: ["abcdef1234567890"],
      },
      {
        content: "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
        secrets: ["QWxhZGRpbjpvcGVuIHNlc2FtZQ=="],
      },
      { content: "password=hunter2", secrets: ["hunter2"] },
      { content: "password = hunter2", secrets: ["hunter2"] },
      { content: "password =\n  hunter2", secrets: ["hunter2"] },
      { content: "apiKey: tiny-secret", secrets: ["tiny-secret"] },
      { content: "apiKey:\r\ntiny-secret", secrets: ["tiny-secret"] },
      { content: "token = abcdef123456", secrets: ["abcdef123456"] },
      { content: "accessKey=hunter2", secrets: ["hunter2"] },
      { content: "privateKey=tiny-secret", secrets: ["tiny-secret"] },
      { content: "auth=hunter2", secrets: ["hunter2"] },
      { content: "cookie=session-secret", secrets: ["session-secret"] },
      { content: "credential=tiny-secret", secrets: ["tiny-secret"] },
      { content: "clientKey=client-secret", secrets: ["client-secret"] },
      { content: "consumerKey=consumer-secret", secrets: ["consumer-secret"] },
      { content: "signingKey=signing-secret", secrets: ["signing-secret"] },
      { content: "webhookUrl=https://example.test/hook?token=query-secret", secrets: ["query-secret"] },
      { content: "Cookie: safe=abc; session=hunter2; csrf=abcdef123456\nnext", secrets: ["hunter2", "abcdef123456"] },
      { content: "Authorization: Bearer\n hunter2\nnext", secrets: ["hunter2"] },
      {
        content: "Proxy-Authorization: Digest username=alice,\n response=hunter2\nsafe",
        secrets: ["hunter2"],
      },
      { content: "Cookie: sid=abc;\n foo=hunter2\nsafe", secrets: ["hunter2"] },
      { content: "apiKey: |\n  yaml-secret\nnext", secrets: ["yaml-secret"] },
      { content: "password: >\r\n  folded-secret\r\nnext", secrets: ["folded-secret"] },
      {
        content: "password: >-\n  first\n\n  blank-line-secret\nsafe",
        secrets: ["blank-line-secret"],
      },
      { content: "tool --api-key hunter2 END", secrets: ["hunter2"] },
      { content: "tool -password tiny-secret END", secrets: ["tiny-secret"] },
      { content: "const args = ['--password', 'hunter2']; END", secrets: ["hunter2"] },
      { content: "curl --authorization Bearer hunter2 END", secrets: ["hunter2"] },
      { content: '["--authorization", "Bearer", "hunter2"] END', secrets: ["hunter2"] },
      { content: 'credentials: ["hunter2", "other"] END', secrets: ["hunter2"] },
      { content: 'credentials: ["]", "hunter2"] END', secrets: ["hunter2"] },
      { content: 'credentials: {"note":"}", "primary":"hunter2"} END', secrets: ["hunter2"] },
      { content: "credentials:\n  - hunter2\nsafe: yes", secrets: ["hunter2"] },
      { content: "cookies:\n  - name: sid\n    value: hunter2\nsafe: yes", secrets: ["hunter2"] },
      { content: "password: !!str hunter2\nsafe: yes", secrets: ["hunter2"] },
      { content: "apiKey: &primary hunter2\nsafe: yes", secrets: ["hunter2"] },
      { content: '{"pass\\u0077ord":"hunter2"} END', secrets: ["hunter2"] },
      { content: '{\\"pass\\u0077ord\\":\\"hunter2\\"} END', secrets: ["hunter2"] },
      { content: "password\n=hunter2 okay", secrets: ["hunter2"] },
      { content: "apiKey\r\n: hunter2 okay", secrets: ["hunter2"] },
      { content: '"secret"\n: "hunter2" okay', secrets: ["hunter2"] },
      { content: '\\"token\\"\n: \\"hunter2\\" okay', secrets: ["hunter2"] },
      { content: 'const password = getLiteral("hunter2"); END', secrets: ["hunter2"] },
      { content: 'let api_key = Some("hunter2".to_string()); END', secrets: ["hunter2"] },
      { content: 'const apiKey: string = "literal-secret";', secrets: ["literal-secret"] },
      { content: 'password := "go-secret"', secrets: ["go-secret"] },
      { content: "Bearer\nhunter2", secrets: ["hunter2"] },
      {
        content: "Basic\r\nQWxhZGRpbjpvcGVuIHNlc2FtZQ==",
        secrets: ["QWxhZGRpbjpvcGVuIHNlc2FtZQ=="],
      },
      { content: 'password="hello world"', secrets: ["hello", "world"] },
      { content: '{"password": "tiny"} ', secrets: ["tiny"] },
      { content: '{\\"password\\": \\"tiny\\"} ', secrets: ["tiny"] },
      {
        content: '{"authorization": "Custom one two"} ',
        secrets: ["Custom", "one", "two"],
      },
      { content: '{\\"apiKey\\": \\"tiny\\"} ', secrets: ["tiny"] },
      { content: "apiKey='part one two'", secrets: ["part", "one", "two"] },
      { content: '{\\"password\\":\\"escaped multi word\\"}', secrets: ["escaped", "multi"] },
      { content: "sk-abcdefghijklmnop", secrets: ["abcdefghijklmnop"] },
      {
        content: "https://user:p%40ss:w0rd@example.test/path",
        secrets: ["user", "p%40ss:w0rd"],
      },
      {
        content: "https://hooks.slack.com/services/T000/B000/slack-secret",
        secrets: ["T000", "B000", "slack-secret"],
      },
      {
        content: "https://example.test/hook?token=query-secret&ok=1",
        secrets: ["query-secret"],
      },
      {
        content: "QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=",
        secrets: ["QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA="],
      },
    ].map((item) => ({ ...item, content: `${item.content} ` }));

    for (const item of cases) {
      const expectedChunk = projectChatStreamChunkForPublic(deltaChunk(item.content));
      const expected = expectedChunk.type === "delta" ? expectedChunk.delta : redactSecretText(item.content).value;
      for (let split = 1; split < item.content.length; split += 1) {
        const projector = new ChatStreamSecretProjector();
        const deltas = [item.content.slice(0, split), item.content.slice(split)].map((delta) =>
          projector.project(deltaChunk(delta)),
        );
        const done = projector.project({
          type: "message_done",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "message-1",
          content: item.content,
        } satisfies ChatStreamChunkDraft);
        const streamed = deltas.map((chunk) => (chunk.type === "delta" ? chunk.delta : "")).join("");

        expect(
          expected.startsWith(streamed),
          `${item.content} split ${split}: ${JSON.stringify({ expected, streamed })}`,
        ).toBe(true);
        expect(done).toMatchObject({ type: "message_done", content: expected });
        for (const secret of item.secrets) {
          expect(streamed, `${item.content} split ${split}`).not.toContain(secret);
          expect(
            done.type === "message_done" ? done.content : JSON.stringify(done),
            `${item.content} final ${split}`,
          ).not.toContain(secret);
        }
      }
    }
  });

  it("releases completed clean words while retaining an unfinished trailing token", () => {
    const projector = new ChatStreamSecretProjector();

    expect(projector.project(deltaChunk("hello "))).toMatchObject({ delta: "hello " });
    expect(projector.project(deltaChunk("world"))).toMatchObject({ delta: "" });
    expect(
      projector.project({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "hello world",
      } satisfies ChatStreamChunkDraft),
    ).toMatchObject({ content: "hello world" });
  });

  it("suppresses resumed text until terminal content can be projected as a whole", () => {
    const projector = new ChatStreamSecretProjector();
    projector.beginTurn("turn-1", { suppressTextUntilTerminal: true });

    expect(projector.project(deltaChunk("r hunter2 and more text "))).toMatchObject({ delta: "" });
    expect(
      projector.project({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Authorization: Bearer hunter2 and more text",
      } satisfies ChatStreamChunkDraft),
    ).toMatchObject({ content: "Authorization: [REDACTED]" });
  });

  it("flushes the final safe thinking token before the terminal message", () => {
    const projector = new ChatStreamSecretProjector();

    expect(
      projector.project({
        type: "thinking_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        delta: "Considering options.",
      } satisfies ChatStreamChunkDraft),
    ).toMatchObject({ type: "thinking_delta", delta: "Considering " });

    expect(
      projector.projectAll({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Final answer",
      } satisfies ChatStreamChunkDraft),
    ).toEqual([
      expect.objectContaining({ type: "thinking_delta", delta: "options." }),
      expect.objectContaining({ type: "message_done", content: "Final answer" }),
    ]);
  });

  it("fails closed in bounded time for unbroken streamed tokens", () => {
    const projector = new ChatStreamSecretProjector();
    const startedAt = performance.now();

    for (let index = 0; index < 1_000; index += 1) {
      expect(projector.project(deltaChunk("abcdefghijklmnopqrst"))).toMatchObject({ delta: "" });
    }

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(
      projector.project({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "a".repeat(20_000),
      } satisfies ChatStreamChunkDraft),
    ).toMatchObject({ type: "message_done", content: "a".repeat(20_000) });
  });

  it("emits a bounded redaction marker instead of dropping oversized thinking", () => {
    const projector = new ChatStreamSecretProjector();

    for (let index = 0; index < 100; index += 1) {
      projector.project({
        type: "thinking_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        delta: "abcdefghijklmnopqrst",
      } satisfies ChatStreamChunkDraft);
    }

    expect(
      projector.projectAll({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Final answer",
      } satisfies ChatStreamChunkDraft),
    ).toEqual([
      expect.objectContaining({ type: "thinking_delta", delta: "[REDACTED]" }),
      expect.objectContaining({ type: "message_done" }),
    ]);
  });

  it("retains an unsafe credential prefix across non-text stream chunks", () => {
    const projector = new ChatStreamSecretProjector();

    expect(projector.project(deltaChunk("Authorization: Bearer hun"))).toMatchObject({ delta: "" });
    expect(
      projector.projectAll({
        type: "usage",
        sessionId: "session-1",
        turnId: "turn-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      } satisfies ChatStreamChunkDraft),
    ).toEqual([expect.objectContaining({ type: "usage" })]);
    expect(projector.project(deltaChunk("ter2 "))).toMatchObject({ delta: "" });
    expect(
      projector.project({
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Authorization: Bearer hunter2",
      } satisfies ChatStreamChunkDraft),
    ).toMatchObject({ type: "message_done", content: "Authorization: [REDACTED]" });
  });

  it("releases completed credential expressions and code declarations before terminal", () => {
    const cases = [
      "password: string; ",
      "password: hunter2 okay ",
      "Authorization: Bearer hunter2\nsafe ",
      "{ token: token } ",
      "apiKey=hunter2\nsafe ",
      "tool --api-key hunter2 END ",
      "apiKey: |\n  yaml-secret\nnext ",
    ];

    for (const content of cases) {
      const projector = new ChatStreamSecretProjector();
      expect(projector.project(deltaChunk(content))).toMatchObject({ delta: redactSecretText(content).value });
    }
  });
});

function deltaChunk(delta: string): ChatStreamChunkDraft {
  return {
    type: "delta",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "message-1",
    delta,
  };
}
