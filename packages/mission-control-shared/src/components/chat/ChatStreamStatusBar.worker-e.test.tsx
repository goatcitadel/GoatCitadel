import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";

function renderText(status: ChatStreamStatus, queuedCount: number, mode: "chat" | "cowork" | "code" = "chat") {
  return create(<ChatStreamStatusBar status={status} queuedCount={queuedCount} error={null} mode={mode} />).toJSON();
}

function hasText(node: unknown, text: string): boolean {
  return JSON.stringify(node).includes(text);
}

describe("ChatStreamStatusBar", () => {
  it("stays hidden only for a fully idle stream with no queued work", () => {
    expect(create(<ChatStreamStatusBar status="idle" queuedCount={0} error={null} />).toJSON()).toBeNull();
    expect(hasText(renderText("idle", 1), "Ready")).toBe(true);
  });

  it("labels connection and streaming differently for chat and cowork modes", () => {
    expect(hasText(renderText("connecting", 0, "cowork"), "Connecting run response...")).toBe(true);
    expect(hasText(renderText("connecting", 0, "chat"), "Connecting...")).toBe(true);
    expect(hasText(renderText("streaming", 2, "cowork"), "Run response streaming (2 queued messages)")).toBe(true);
    expect(hasText(renderText("streaming", 0, "cowork"), "Run response streaming...")).toBe(true);
    expect(hasText(renderText("streaming", 2, "chat"), "Streaming (2 queued)")).toBe(true);
    expect(hasText(renderText("streaming", 0, "chat"), "Streaming...")).toBe(true);
  });

  it("pluralizes queued messages and surfaces error copy by mode", () => {
    expect(hasText(renderText("queued", 1, "cowork"), "1 queued message")).toBe(true);
    expect(hasText(renderText("queued", 2, "cowork"), "2 queued messages")).toBe(true);
    expect(hasText(renderText("queued", 1, "chat"), "1 message queued")).toBe(true);
    expect(hasText(renderText("queued", 2, "chat"), "2 messages queued")).toBe(true);

    const coworkError = create(
      <ChatStreamStatusBar status="error" queuedCount={0} error="Gateway stream dropped" mode="cowork" />,
    ).toJSON();
    expect(hasText(coworkError, "Run response error")).toBe(true);
    expect(hasText(coworkError, "Gateway stream dropped")).toBe(true);

    const chatError = create(<ChatStreamStatusBar status="error" queuedCount={0} error="Network lost" />).toJSON();
    expect(hasText(chatError, "Error")).toBe(true);
    expect(hasText(chatError, "Network lost")).toBe(true);
  });
});
