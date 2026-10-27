/** Letters and digits that cannot be mistaken for one another: no 0 or O, no 1, l or I. 57 in all. */
export const SETUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const SETUP_CODE_LENGTH = 10;
/** A code stops working for the page after ten minutes, so one lost in a chat cannot be used later. */
export const SETUP_CODE_TTL_MS = 600_000;
/** How often the page asks Telegram whether the code has arrived. The discovery route allows 20 a minute. */
export const SAY_HI_POLL_MS = 4_000;

/** Random bytes at or above this would make the first characters of the alphabet likelier than the rest. */
const UNBIASED_BELOW = 256 - (256 % SETUP_CODE_ALPHABET.length);

/**
 * A one-time code for the operator to send their bot. It comes from the browser's secure random source, and bytes
 * that would favour some characters are thrown away rather than folded in, so every character is equally likely.
 */
export function createSetupCode(): string {
  let code = "";
  while (code.length < SETUP_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SETUP_CODE_LENGTH * 2))) {
      if (code.length < SETUP_CODE_LENGTH && byte < UNBIASED_BELOW) {
        code += SETUP_CODE_ALPHABET[byte % SETUP_CODE_ALPHABET.length];
      }
    }
  }
  return code;
}
