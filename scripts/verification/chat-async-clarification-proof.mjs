import { runChatAsyncClarificationProof } from "./lib/scenarios.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext } from "./lib/shared.mjs";

const context = await createRunContext("usability", { commandSelection: "chat-async-clarification" });
try {
  await runChatAsyncClarificationProof(context);
  const manifest = await finalizeRunContext(context);
  console.log(`Async clarification proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally { await releaseRunContext(context); }
