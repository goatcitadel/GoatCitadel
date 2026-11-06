import { describe, expect, it } from "vitest";
import * as chat from "./chat.js";
import * as client from "./client.js";
import * as apiIndex from "./index.js";
import * as rootIndex from "../index.js";
import * as workbench from "./chat-workbench-operations.js";
import * as optional from "./chat-optional-actions.js";

const workbenchReads = [
  "fetchChatSessionWorkbench", "fetchChatSessionWorkbenchTree", "fetchChatSessionWorkbenchFile",
  "fetchChatSessionWorkbenchFileDiff", "fetchChatSessionWorkbenchDiff", "fetchChatSessionWorkbenchOutput",
] as const;
const optionalCommands = [
  "runChatDelegation", "runChatResearch", "streamChatDelegation", "suggestChatDelegation", "triggerChatProactive",
] as const;

describe("optional API canonical implementation identity", () => {
  it.each(workbenchReads)("forwards %s unchanged through every public facade", name => {
    for (const facade of [chat, client, apiIndex, rootIndex]) expect(facade[name]).toBe(workbench[name]);
  });
  it.each(optionalCommands)("forwards %s unchanged through every public facade", name => {
    for (const facade of [chat, client, apiIndex, rootIndex]) expect(facade[name]).toBe(optional[name]);
  });
});
