import { describe, expect, it } from "vitest";
import { detectImageGenerationIntent } from "./chat-image-intent";

describe("detectImageGenerationIntent", () => {
  it.each([
    "can you please create an image of a frog combined with an airplane?",
    "Generate a picture of a neon command center.",
    "Make me a logo for GoatCitadel.",
    "draw a tiny robot reading a book",
    "show me an image of a cyberpunk workstation",
    "an image of a frog pilot",
  ])("detects explicit image creation requests: %s", (draft) => {
    expect(detectImageGenerationIntent(draft)).toBe(true);
  });

  it.each([
    "How do I create an image in GoatCitadel?",
    "Write a prompt for an image of a frog pilot.",
    "Find an image of an airplane online.",
    "Analyze this image and describe it.",
    "Analyze this image and create a concise summary.",
    "Create an image carousel component in React.",
    "Make an image download button easier to find.",
    "Draw conclusions from this image.",
    "/help create image",
    "Can you explain what gpt-image-2 is?",
  ])("does not reroute image-adjacent text requests: %s", (draft) => {
    expect(detectImageGenerationIntent(draft)).toBe(false);
  });
});
