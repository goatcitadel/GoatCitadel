import { types } from "node:util";
import {
  McpRequesterResolutionError,
  type McpEphemeralResolvedConnectionCandidate,
} from "./mcp-requester-resolution.js";
import type {
  McpAdmissionDiscoveryAuthority,
  McpAdmissionToolCallAuthority,
} from "./mcp-requester-admission-authority.js";

/** Gateway-owned registration only. Implementations must use a canonical actor-bound connection owner. */
export interface McpRequesterAdmissionResolver {
  readonly resolverId: string;
  readonly resolverVersion: string;
  readonly configGeneration: number;
  resolveForAdmissionDiscovery(input: {
    requester: McpAdmissionDiscoveryAuthority;
    signal: AbortSignal;
  }): Promise<McpEphemeralResolvedConnectionCandidate>;
  resolveForAdmissionToolCall(input: {
    requester: McpAdmissionToolCallAuthority;
    signal: AbortSignal;
  }): Promise<McpEphemeralResolvedConnectionCandidate>;
}

export class McpRequesterAdmissionResolverRegistry {
  private readonly resolvers = new Map<string, Readonly<McpRequesterAdmissionResolver>>();

  public constructor(resolvers: readonly McpRequesterAdmissionResolver[] = []) {
    for (const resolver of resolvers) {
      if (
        !resolver ||
        typeof resolver !== "object" ||
        types.isProxy(resolver) ||
        Object.keys(resolver).sort().join(",") !==
          "configGeneration,resolveForAdmissionDiscovery,resolveForAdmissionToolCall,resolverId,resolverVersion" ||
        Object.values(Object.getOwnPropertyDescriptors(resolver)).some(
          (descriptor) => !Object.hasOwn(descriptor, "value"),
        ) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(resolver.resolverId) ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(resolver.resolverVersion) ||
        !Number.isSafeInteger(resolver.configGeneration) ||
        resolver.configGeneration < 1 ||
        typeof resolver.resolveForAdmissionDiscovery !== "function" ||
        typeof resolver.resolveForAdmissionToolCall !== "function" ||
        types.isProxy(resolver.resolveForAdmissionDiscovery) ||
        types.isProxy(resolver.resolveForAdmissionToolCall) ||
        this.resolvers.has(resolver.resolverId)
      ) {
        throw new McpRequesterResolutionError("resolver_binding_drift");
      }
      this.resolvers.set(
        resolver.resolverId,
        Object.freeze({
          ...resolver,
          resolveForAdmissionDiscovery: resolver.resolveForAdmissionDiscovery.bind(undefined),
          resolveForAdmissionToolCall: resolver.resolveForAdmissionToolCall.bind(undefined),
        }),
      );
    }
  }

  public resolveExact(input: {
    resolverId: string;
    resolverVersion: string;
    resolverConfigGeneration: number;
  }): Readonly<McpRequesterAdmissionResolver> {
    const resolver = this.resolvers.get(input.resolverId);
    if (!resolver) throw new McpRequesterResolutionError("resolver_missing");
    if (
      resolver.resolverVersion !== input.resolverVersion ||
      resolver.configGeneration !== input.resolverConfigGeneration
    ) {
      throw new McpRequesterResolutionError("resolver_binding_drift");
    }
    return resolver;
  }
}
