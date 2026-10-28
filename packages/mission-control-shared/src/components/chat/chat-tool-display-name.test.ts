import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { chatToolDisplayName } from "./chat-tool-display-name";

const run = (toolName: unknown) => ({ toolName }) as unknown as ChatToolRunRecord;

describe("chatToolDisplayName", () => {
  it("uses the tool's own name where it has one", () => {
    expect(chatToolDisplayName(run("fs.patch"))).toBe("Edit file");
    expect(chatToolDisplayName(run("code.search_files"))).toBe("Search code files");
  });

  it("reads any other tool as words, never as a raw registry id", () => {
    expect(chatToolDisplayName(run("calendar.create_event"))).toBe("Calendar create event");
    expect(chatToolDisplayName(run("mcp.invoke"))).toBe("Mcp invoke");
  });

  it("names a malformed record without breaking", () => {
    expect(chatToolDisplayName(run(undefined))).toBe("Tool");
  });
});
