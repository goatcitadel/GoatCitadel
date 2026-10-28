/**
 * The host a channel address names. The Gateway records it when a secret address is saved, and Mission Control's
 * hosts check offers it, so both read a host the same way.
 */

/**
 * Labels of letters, digits, hyphens and underscores joined by dots: a DNS name, or the dotted digits of an IPv4
 * address. Underscores appear in Docker and LAN names such as `signal_cli`. A trailing dot is not accepted: the
 * Gateway's network guard matches `example.com.` and `example.com` as different hosts, so the bare name would not let
 * the dotted address through.
 */
const DNS_NAME = "[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*";
/** An IPv6 address as the URL parser gives it back, in brackets. */
const IPV6_LITERAL = "\\[[0-9a-f:.]+\\]";

const HOSTNAME = new RegExp(`^(?:${DNS_NAME}|${IPV6_LITERAL})$`);
const HOST = new RegExp(`^(?:${DNS_NAME}|${IPV6_LITERAL})(?::[0-9]{1,5})?$`);

/**
 * The one host an http or https address names, with its port when the address gives one that is not the scheme's
 * default, so allowing it allows that port and not every port on the host (the Gateway's allowlist matches `host:port`
 * entries as well as bare hosts). Never the credentials, path, query or fragment. A wildcard such as `*` or
 * `*.example.com` is not a host (the URL parser takes one as a hostname, written plainly or percent-encoded, and the
 * allowlist reads `*` as every host), and neither is anything else that is not a DNS name or an IP address, so none of
 * them is ever returned.
 */
export function channelAddressHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME.test(hostname)) return undefined;
  return url.port ? `${hostname}:${url.port}` : hostname;
}

/** Whether a value is a host as `channelAddressHost` gives one back: a DNS name or IP address, with or without a port. */
export function isChannelAddressHost(value: unknown): value is string {
  return typeof value === "string" && HOST.test(value);
}
