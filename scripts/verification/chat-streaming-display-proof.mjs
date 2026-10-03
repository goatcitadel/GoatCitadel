import { runChatStreamingDisplayProof } from "./lib/scenarios.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext } from "./lib/shared.mjs";

const context = await createRunContext("usability", { commandSelection: "chat-streaming-display" });
try {
  await runChatStreamingDisplayProof(context);
  const manifest = await finalizeRunContext(context);
  console.log(`SF6 display proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await releaseRunContext(context);
}
