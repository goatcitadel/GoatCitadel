import { createChatSession } from "@goatcitadel/mission-control-shared/api/chat";
import { CheckAssertionError } from "../runner/assert";
import type { CheckContext } from "../runner/types";

export type ScratchSession = Awaited<ReturnType<typeof createChatSession>>;

export function requireWorkspace(ctx: CheckContext): string {
  if (!ctx.workspaceId) {
    throw new CheckAssertionError(
      "This check needs the seeded test workspace, which exists only in the verified sandbox.",
    );
  }
  return ctx.workspaceId;
}

/** Each check works in its own session so seeded turns never collide. */
export function createScratchSession(ctx: CheckContext, purpose: string): Promise<ScratchSession> {
  return createChatSession({ workspaceId: requireWorkspace(ctx), title: `Test bench: ${purpose}` });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
