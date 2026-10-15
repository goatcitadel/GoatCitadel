/** Shared pure query construction; no request, state or runtime authority. */
export function id(value: string): string {
  return encodeURIComponent(value);
}
