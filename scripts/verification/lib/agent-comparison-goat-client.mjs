import { randomUUID } from "node:crypto";

/** Bounded authenticated HTTP, shared by native Chat and supervised workflows.
 * This client never retries a mutation or treats its response as task success. */
export function createGoatComparisonClient({ baseUrl, token, retain, signal, fetchImpl = fetch }) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("The comparison adapter requires its owned loopback Gateway.");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(token))
    throw new Error("A fresh Gateway credential is required.");
  let requestCount = 0,
    retainedBytes = 0;
  return async (name, route, body) => {
    signal?.throwIfAborted();
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("\\"))
      throw new Error("Use a native Gateway API route.");
    const target = new URL(`/api/v1${route}`, url);
    if (target.origin !== url.origin || !target.pathname.startsWith("/api/v1/"))
      throw new Error("The native API route escaped its Gateway prefix.");
    if (++requestCount > 512) throw new Error("The native comparison API request bound was reached.");
    const response = await fetchImpl(target, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw new Error("The Gateway response exceeds the comparison evidence limit.");
      chunks.push(chunk);
    }
    retainedBytes += bytes;
    if (retainedBytes > 32 * 1024 * 1024) throw new Error("The native comparison evidence bound was reached.");
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8").replaceAll(token, "[Gateway token]"));
    await retain(name, { status: response.status, body: result });
    if (!response.ok) throw new Error(`The comparison Gateway returned HTTP ${response.status} during ${name}.`);
    return result;
  };
}
