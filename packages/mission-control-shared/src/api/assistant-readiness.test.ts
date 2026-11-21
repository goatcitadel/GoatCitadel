import {expect,it,vi} from "vitest";
const mocked=vi.hoisted(()=>({request:vi.fn(async()=>({}))}));vi.mock("./client-core.js",()=>mocked);
import {fetchAssistantReadiness} from "./assistant-readiness.js";
it("encodes session and workspace scope on a read-only request",async()=>{
  await fetchAssistantReadiness("session/one","workspace A");
  expect(mocked.request).toHaveBeenCalledWith("/api/v1/chat/sessions/session%2Fone/assistant-readiness?workspaceId=workspace+A");
});
