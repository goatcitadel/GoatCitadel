import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";

/**
 * True on touch-first devices (phones, tablets), where there is no Shift key for a newline and hover does not exist.
 * Input behaviour keys off this, not off the viewport width: a narrow desktop window still has a keyboard.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
