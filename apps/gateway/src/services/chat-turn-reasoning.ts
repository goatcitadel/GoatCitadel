/**
 * Saved copy of a chat turn's streamed model reasoning ("thinking"), so a reloaded thread still shows it.
 *
 * The stream service collects each pass's `thinking_delta` text and writes it to the turn trace when the pass
 * commits its answer or parks for an approval or user input. A pass that resumes after such a wait appends to
 * what the earlier pass saved. Runner chunks reach the stream service before the stream's secret projector,
 * so the saved text is redacted here, then capped like the browser's copy.
 */

import { CHAT_TURN_REASONING_MAX_CHARS, capChatTurnReasoning, redactSecretText } from "@goatcitadel/contracts";

/** Raw text kept while streaming: twice the saved cap, so redaction sees whole secrets near the kept tail's start. */
const RAW_REASONING_TAIL_CHARS = CHAT_TURN_REASONING_MAX_CHARS * 2;

export class ChatTurnReasoningRecorder {
  private streamed = "";

  public append(delta: string): void {
    if (!delta) return;
    const next = `${this.streamed}${delta}`;
    this.streamed = next.length > RAW_REASONING_TAIL_CHARS ? next.slice(next.length - RAW_REASONING_TAIL_CHARS) : next;
  }

  /**
   * The trace patch fields for this pass: empty when it streamed no reasoning (the flag is off, or the model gave
   * none), so the stored copy and the trace read are both left alone.
   */
  public async tracePatch(readSaved: () => Promise<string | undefined>): Promise<{ reasoning?: string }> {
    if (!this.streamed.trim()) return {};
    const saved = await readSaved();
    const joined = saved ? `${saved}\n\n${this.streamed}` : this.streamed;
    return { reasoning: capChatTurnReasoning(redactSecretText(joined).value) };
  }
}
