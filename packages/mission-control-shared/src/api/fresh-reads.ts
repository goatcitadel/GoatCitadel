// While any fresh-read scope is open, GET requests are never coalesced with an in-flight read. An outcome readback must
// observe state after the write it is settling, so it may not join a read that started before that write committed.
// Other GETs issued during the scope also go uncoalesced, which only costs an extra request.
let openScopes = 0;

export function freshReadsActive(): boolean {
  return openScopes > 0;
}

export async function withFreshReads<T>(read: () => Promise<T>): Promise<T> {
  openScopes += 1;
  try {
    return await read();
  } finally {
    openScopes -= 1;
  }
}
