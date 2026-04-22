export function shouldStopBundledPostgresOnClose(supervised = process.env.GOATCITADEL_GATEWAY_SUPERVISED): boolean {
  return supervised?.trim() !== "1";
}
