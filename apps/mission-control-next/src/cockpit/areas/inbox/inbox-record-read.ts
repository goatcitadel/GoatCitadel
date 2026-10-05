import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

/** A read by id that answers 404 means the record is gone or out of scope: no record, not an error. */
export async function nullWhenMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (isApiRequestError(error) && error.kind === "http" && error.status === 404) return null;
    throw error;
  }
}
