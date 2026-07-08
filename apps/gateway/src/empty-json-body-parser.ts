import type { FastifyInstance } from "fastify";

/**
 * Replace Fastify's default `application/json` parser with one that treats an
 * empty (or whitespace-only) body as "no body" instead of rejecting the
 * request with 400 FST_ERR_CTP_EMPTY_JSON_BODY.
 *
 * Browser clients — Mission Control's shared API client among them — stamp
 * `Content-Type: application/json` on requests even when there is nothing to
 * send, e.g. `POST /api/v1/mason/sessions`. With the default parser those
 * requests die before the route handler runs. Routes already treat a missing
 * body defensively (`request.body ?? {}` / schema parse), so mapping an empty
 * payload to `undefined` matches the behaviour of the same request without a
 * content-type header.
 *
 * Non-empty payloads are delegated to Fastify's own default JSON parser so
 * malformed JSON still fails with 400 FST_ERR_CTP_INVALID_JSON_BODY and
 * secure-json-parse's `__proto__` / `constructor` poisoning rejection is
 * preserved ("error" mirrors the factory defaults).
 */
export function installEmptyBodyTolerantJsonParser(app: FastifyInstance): void {
  const parseJsonBody = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (typeof body !== "string" || body.trim() === "") {
      done(null, undefined);
      return;
    }
    parseJsonBody(request, body, done);
  });
}
