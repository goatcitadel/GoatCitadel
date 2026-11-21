import { expect, it } from "vitest";
import { isExplicitMemoryRecallPrompt } from "./memory-context-utils.js";

it.each([
  "What reply length do I prefer?",
  "What is my preferred language?",
  "How do I like my replies?",
  "What are our preferences?",
  "¿Qué longitud de respuestas prefiero?",
  "¿Cuál es mi idioma preferido?",
  "What did we decide?",
  "Recall the earlier decision.",
])("recognizes a natural recall request without a minimum character count: %s", (prompt) => {
  expect(isExplicitMemoryRecallPrompt(prompt)).toBe(true);
});
it.each(["hi", "OK", "What is a reply?", "I prefer concise replies.", "How does a language model work?"])(
  "does not make ordinary short input a recall request: %s",
  (prompt) => {
    expect(isExplicitMemoryRecallPrompt(prompt)).toBe(false);
  },
);
