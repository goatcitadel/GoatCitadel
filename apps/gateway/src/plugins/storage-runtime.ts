export function shouldStopBundledPostgresOnClose(supervised = process.env.GOATCITADEL_GATEWAY_SUPERVISED): boolean {
  return supervised?.trim() !== "1";
}

export function shouldStartDeferredInitInBackground(supervised = process.env.GOATCITADEL_GATEWAY_SUPERVISED): boolean {
  return supervised?.trim() === "1";
}
