export const SPEAK_REPLIES_PREF_KEY = "goatcitadel.chat.speak-replies.enabled";

export function readSpeakRepliesPreference(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(SPEAK_REPLIES_PREF_KEY) === "true";
  } catch {
    return false;
  }
}
