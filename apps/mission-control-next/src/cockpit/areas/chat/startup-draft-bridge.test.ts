// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { connectStartupDraft } from "./startup-draft-bridge";

const origin = "http://127.0.0.1:5173";
const context = "13207be2-e5da-4795-a699-e45ec7b0b6cc";
const offer = "0390770b-fd16-4bee-8d0a-675a8a44f83f";

function fixture(draft = "", newChat = true, commitAutomatic?: (apply: () => void) => void) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const postMessage = vi.fn();
  const bridge = connectStartupDraft({
    postMessage,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  }, origin, context, commitAutomatic);
  const composer = document.createElement("textarea");
  let value = draft;
  composer.value = value;
  const changeDraft = vi.fn((text: string) => { value = text; });
  const update = () => {
    composer.value = value;
    bridge.update({ label: "Conversation", draft: value, composer, changeDraft, newChat });
  };
  const receive = (details: Record<string, unknown> = {}) => {
    const event = new MessageEvent("message", {
      data: { type: "goatcitadel.startup-draft", version: 1, action: "offer",
        origin, context, offer, text: "native draft", append: false, ...details },
    });
    for (const listener of listeners) listener(event);
  };
  update();
  return { composer, postMessage, changeDraft, bridge, receive, update };
}

describe("native startup draft", () => {
  it("prioritizes only the admitted automatic transfer", () => {
    const commit = vi.fn((apply: () => void) => apply());
    const empty = fixture("", true, commit);
    empty.receive();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(empty.changeDraft).toHaveBeenCalledExactlyOnceWith("native draft");

    const saved = fixture("saved", true, commit);
    saved.receive();
    expect(saved.changeDraft).not.toHaveBeenCalled();
    saved.receive({ offer: context, append: true });
    expect(saved.changeDraft).toHaveBeenCalledExactlyOnceWith("saved\n\nnative draft");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("waits for a committed composer update and acknowledges retries without reinserting", () => {
    const { receive, update, composer, changeDraft, postMessage } = fixture();
    receive();
    expect(changeDraft).toHaveBeenCalledExactlyOnceWith("native draft");
    expect(postMessage).toHaveBeenCalledTimes(1);
    update();
    expect(composer.value).toBe("native draft");
    receive();
    expect(changeDraft).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ offer, outcome: "applied" }));
  });

  it("holds an automatic offer and appends only on explicit insert", () => {
    const existing = " web draft\n";
    const { receive, update, composer, changeDraft, postMessage } = fixture(existing, false);
    receive();
    expect(changeDraft).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ offer, outcome: "held" }));
    receive({ offer: "4565d705-636c-44f8-81ba-1f7b95b100d7", append: true });
    update();
    expect(composer.value).toBe(existing + "\n\nnative draft");
  });

  it("does not replace unsynchronized DOM text or accept stale destinations", () => {
    const { receive, composer, changeDraft, bridge } = fixture();
    receive({ origin: "http://127.0.0.1:5174" });
    receive({ context: offer });
    composer.value = "actively typed";
    receive({ append: true });
    expect(changeDraft).not.toHaveBeenCalled();
    bridge.disconnect();
    receive({ offer: context });
    expect(composer.value).toBe("actively typed");
  });
});
