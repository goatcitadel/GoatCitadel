# Destination tools in the Windows worker

The stock worker entrypoint can execute the shipped `fs.read`, `fs.write`, `fs.list` and
`mcp.http` adapters for exact published entries. The filesystem adapters use an
operator-configured destination directory; MCP connects to an independently
operated HTTP server. Foreground execution has local proof. The installed service
has protected registry configuration, with actual installed startup/custody still
awaiting acceptance. HTTP MCP supports an independently configured bearer file.
Additional tools, OAuth, stdio MCP and protected MCP custody remain unfinished.

The internal Windows job and verified-bundle owners now support interactive
stdio with bounded queues and explicit input completion. Native checks exercise
actual AppContainer exchanges, installed runtime bundles and controller death.
An image-pinned native helper now connects that owner to the Node worker, with
portable Windows x64 package proof for interactive byte exchange, current-authority
revocation, bundle drift and input/output accounting. An internal stdio MCP owner
now performs initialization, exact schema discovery, one tool call and native
shutdown, with actual Node execution proof. It requires trusted local process
composition and a persisted invocation before launch. An explicit protected launch
mode now reopens independently recorded workspace roots, retains their handles
through native cleanup and checks exact security before and after execution.
Portable-package proof includes actual Node MCP execution through that mode and
refusal of substituted roots or protocol downgrade. The worker execution journal
now persists private workspace identities and launch hashes before native entry,
retains them through settlement and refuses replay after restart. It excludes
command lines, environment values, tool arguments and outputs; this metadata
does not authorize provisioning or cleanup. Service-owned provisioning and recovery
reconciliation, credential custody and registry integration remain unfinished;
`mcp.stdio` remains unsupported in this registry. The local proof does not certify
installed service custody. See the [workspace journal evidence and limits](./COMPARISON_IMPLEMENTATION_STATUS.md#durable-native-workspace-records).

Gateway publication, activation approval, current policy, tool grants and the
invocation fence remain prerequisites. Local registry configuration cannot publish
or activate a capability, authorize an invocation, or substitute executable code.

## Local registration

The worker reads these optional startup settings together:

- `GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE`: absolute local file path.
- `GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256`: lowercase SHA-256 of its
  exact bytes, supplied separately from the registry file.

The registry uses `goatcitadel.worker-mesh-tools.v1` and has exactly these fields:

```ts
{
  schemaVersion: "goatcitadel.worker-mesh-tools.v1";
  workspaceId: string; // The ticket's execution workspace.
  nodeId: string;      // The ticket's admitted mesh node.
  bindings: Array<{
    manifest: MeshCapabilityManifest; // Exact authenticated publication result.
    localId: string;                 // The selected published entry.
  } & ({
    toolName: "fs.read" | "fs.write" | "fs.list";
    rootId: string;                  // Lowercase letter, then letters/digits/hyphens.
    rootPath: string;                // Absolute local destination directory.
  } | {
    toolName: "mcp.http";
    endpoint: string;                // Exact normalized HTTP(S) endpoint.
    authorization?: {
      type: "bearer_file";
      file: string;                 // Absolute local credential file, outside tool roots.
      sha256: string;               // SHA-256 of the exact credential file bytes.
    };
    tools: Array<{
      name: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
  })>;
}
```

The registry is limited to 512 KiB and 32 bindings. Duplicate bindings, additional
fields, incorrect digests, foreign identities and unsupported tool names are
rejected. Place it outside the package and outside directories exposed to tools.
The local operator chooses the file, expected hash, directory or MCP endpoint;
a model, publication descriptor or invocation cannot choose a host path or URL.

`createWorkerMeshFileReadDescriptor(rootId)`, exported by the built worker library,
supplies the native schemas and permission envelope for publication through the
existing authenticated mesh owner. The manifest entry must match those schemas,
version, read-only effect posture and intrinsic idempotency. Its only permission
is `filesystemRead: ["workspace://<rootId>"]`. Resource limits may be narrowed.
The worker still requires separate activation and invocation authority after
local registration.

## Installed service configuration

The service reads its original twelve startup settings from `worker.environment`.
Its native host derives the two registry settings from a separate protected
selection file. Parent-process environment variables cannot supply these settings.
The base environment file and initial enrollment flow remain unchanged.

Use the packaged `app/install/configure-worker-mesh-registry.ps1` from an elevated
administrator terminal after reviewing the exact registry and stopping the worker
through the existing operator service controls. The command verifies the installed
package, receipt, configuration permissions, ticket scope, independent registry
hash and cleanly stopped service state. It never activates a capability or changes
the destination directory's permissions. That directory must already grant the
dedicated worker account the access the selected adapter requires.

For initial setup, review with:

```powershell
.\app\install\configure-worker-mesh-registry.ps1 -Target windows-x64 -ManifestSha256 PACKAGE_MANIFEST_SHA256 -RegistryFile C:\reviewed\registry.json -RegistrySha256 REVIEWED_REGISTRY_SHA256 -ExpectedCurrent none -OutputRoot C:\worker-proof\registry-preflight -Preflight
```

Run the reviewed command without `-Preflight` and with a fresh output directory to
publish the selection. For an update, `-ExpectedCurrent` must be the active registry
hash; after disabling it must be `disabled`. To disable fresh destination polling,
use `-Disable` instead of the two registry-input arguments and retain the same
expected-current check. The command does not start or stop services.

Registry bytes are stored as `configuration/mesh-registry-<sha256>.json`. The
selection file `configuration/mesh-registry.sha256` contains exactly the lowercase
64-character hash or `disabled`. A missing selection means no configured registry.
Files have the existing SYSTEM-owned, worker-read-only configuration permissions.
An exclusive configuration lock serializes writers. The new immutable registry
is retained before an atomic selection update, with stopped-state and expected
selection checks repeated before publication. Old generations and unfinished
staging files are preserved for inspection; they are never automatically selected.

The native host pins the selection and selected registry for the child lifetime.
Its handles prevent replacement while in use, including a service-start race.
Malformed, oversized, unprotected or missing selected files prevent startup.
Node checks the exact registry digest, scope, manifest, schemas and permissions
before fresh polling. Disabling preserves runtime journals and reconciliation.
These source and temporary-file checks do not certify an actual installed service.

## Reading files

The tool accepts `{ path: "folder/note.txt" }`, relative to its configured root.
It returns `{ path, bytes, content }`; the path remains relative. Files must be
regular UTF-8 files no larger than 32 KiB, and the serialized response must fit
the published response limit and the worker's 64 KiB ceiling.

The adapter checks literal path components, local ancestry, root identity, opened
file identity, link count and read-time metadata. It refuses traversal, junctions,
symlinks, hard links, device paths, alternate streams, ambiguous Windows names,
directories, oversized content and invalid UTF-8. Configuration is re-read and
hash-checked before and during execution. Changed local configuration or root
replacement prevents disclosure through the adapter.

These checks govern a trusted filesystem reader. The reader does not launch
processes or implement network tools, environment access, devices or MCP servers.

## Writing files

`createWorkerMeshFileWriteDescriptor(rootId)` provides the exact write contract.
It requires both `filesystemRead` and `filesystemWrite` for the selected logical
root, `write_local` effect posture and `none` idempotency. Publication, activation,
current policy and tool approval still use the Gateway's existing owners.

The writer accepts `{ path, content, expectedContent }`. Use `expectedContent: null`
to create a new file only. To edit a file, supply its exact previous UTF-8 content;
changed contents cause refusal. Both new and previous contents are limited to
32 KiB of UTF-8 bytes. Parent directories must already exist. Successful output
is `{ path, bytes, sha256, created }`, with a relative path and content digest.

Windows and local NTFS are required. The fixed packaged image guard pins the
sibling `GoatCitadelRemoteWorkerFiles.exe` against its compiled digest before
launch. Configuration cannot choose a helper or addon. The helper receives only
bounded private stdin and a minimal environment. It pins the root and parent
directories, rejects aliases/reparse points, hard links and alternate streams,
then creates exclusively or checks and writes through one exclusive file handle.
The worker retains the root identity for the lifetime of the registry binding.
The native helper checks that identity again when opening the root for a write.

Replacement is an in-place operation, not an atomic rollback transaction. A
failure after creation or the first mutation, a lost response, or cancellation
after dispatch leaves an uncertain outcome for reconciliation. Partial output
is retained; the worker does not silently delete it or repeat the operation.
On success, it flushes the file and verifies the resulting bytes and SHA-256.
Cancellation terminates and joins the exact helper process. Neither filesystem
adapter provides hostile-code sandboxing or the pending protected-cell quotas.

## Listing directories

`createWorkerMeshDirectoryListDescriptor(rootId)` supplies the native `fs.list`
contract. It grants only `filesystemRead` for that logical root, with `read_only`
effect posture and `intrinsic` idempotency. The installed registry allowlist and
foreground loader accept the exact published entry; neither grants activation
or invocation authority.

Use `{ path: "." }` for the configured root or `{ path: "folder/nested" }` for
one descendant directory. The response is `{ path, entries, truncated }`, where
each entry has a relative `name` and a `type` of `file`, `directory` or
`unavailable`. Reparse points and other unsupported attributes are reported as
unavailable and never followed. File contents and host paths are not returned.
Names are observations; every subsequent read/write still checks its own path,
identity, content and current authority.

The native helper pins the admitted NTFS root and all target ancestors against
replacement, then enumerates that canonical directory without recursion. It
rejects traversal, network/device paths, ambiguous names, file targets, changed
roots and junction traversal. The response retains at most 128 entries and
32 KiB of encoded entry frames, with an explicit truncation flag if either bound
stops enumeration. Returned entries are sorted by name, but a truncated result
is a subset, without pagination or a complete-directory guarantee. Directory
enumeration is not an atomic snapshot; concurrent entry changes can affect it.
These limits account for Windows' [unsorted directory enumeration and mutable
metadata](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfileexw).

The existing fixed-image guard and bounded private pipe carry the new read-only
operation. Its parser rejects malformed UTF-8, duplicate names, unexpected types,
extra bytes and mismatched root identities. Cancellation joins the exact helper;
local configuration and root identity are checked again before names are returned.
A complete native refusal, such as a missing directory, settles as a failed read.
Lost or malformed responses preserve the runtime's existing uncertainty boundary.
The JSON response must also fit the publication's limit and a 64 KiB ceiling.
Windows x64 native checks, AddressSanitizer, worker tests and the portable package
probe cover this adapter. ARM64 compilation remains separate from execution proof.
See [directory listing evidence](COMPARISON_IMPLEMENTATION_STATUS.md#bounded-native-directory-listing).

## Connecting to an MCP server

`createWorkerMeshMcpHttpDescriptor(endpoint, tools, authorization?)` provides the publication
contract for the compiled HTTP owner. It uses MCP protocol `2025-06-18`, an
`unknown` effect posture and exactly one network origin. It grants no worker
filesystem, environment or device access. A separately operated server remains
responsible for its own host permissions. Its annotations cannot downgrade the
published effect posture or authorize another tool.

The pinned registry holds the exact endpoint and selected native schemas.
HTTPS uses normal certificate verification. Plain HTTP is limited to literal
`127.0.0.1` or `[::1]`. URLs must be normalized, with no credentials, query or
fragment. Redirects, proxies, arbitrary headers and executable configuration are
unsupported. This adapter does not launch an MCP process.

For bearer authentication, create a separate local UTF-8 file containing only the
MCP server's token, then supply its path and exact byte hash in `authorization`.
Leading/trailing whitespace is accepted, but the hash covers those bytes too.
Tokens must contain 16-8192 characters from the HTTP bearer-token alphabet; linked,
malformed, oversized or changed files are refused. Use a dedicated, unguessable
token issued for that server. Never use Gateway enrollment or lease credentials.

Keep the credential outside the package, registry/state directories and every
destination filesystem root. The registry rejects a credential that a configured
filesystem binding could reach. The operator owns its OS access control;
the worker does not encrypt this file or provision its permissions. Grant the worker
read access and restrict changes to the trusted operator. The installed registry
command configures registry selection only; it does not install the credential.

An authenticated descriptor uses version `1.1.0` and an opaque
`configurationSha256` binding the endpoint, selected schemas and credential
reference. The manifest contains no raw token or credential path. The anonymous
descriptor remains version `1.0.0`. Pass the same authorization reference to
descriptor creation and local registration. A changed endpoint, token, credential
path or schema requires a new descriptor/publication, activation approval, reviewed
registry hash and worker restart; it cannot reuse the old approval.

The credential and registry are rechecked before every HTTP request and after its
connection opens, before headers are sent. Authorization applies to initialization,
discovery, tool calls and session cleanup. A rejected credential never triggers a
refresh or automatic retry. Successful output containing the raw token is withheld
and retains an uncertain post-dispatch outcome.

The invocation accepts `{ toolName, arguments }` for a locally selected native
tool. The owner validates its input, initializes a fresh session, and discovers
tools before each invocation. Discovery must match the selected input and optional
structured-output schemas exactly. The runtime rechecks current Gateway admission,
activation and the same input hash after discovery and again after the connection
opens, immediately before sending `tools/call`. Local configuration is checked
throughout. Revocation or schema drift prevents the call.

The owner implements the JSON and SSE response forms of
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
It bounds execution to 25 seconds, request arguments to 256 KiB, each protocol
response to 512 KiB and returned tool output to 64 KiB or the narrower published
limit. Native schemas are at most 32 KiB each; selection/discovery is limited to
128 tools and eight discovery pages. Schema validation uses the existing bounded
validator. Server-initiated requests, including sampling, are refused.

Successful output contains `content`, optional `structuredContent`, and
`isError: false`. Optional native output schemas are enforced according to the
[MCP tool contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
Top-level private `_meta` is omitted and returned resource links are never followed.
Session cleanup uses a separate two-second bound. Failure after sending a tool
call, including a lost reply, a tool error or invalid output, requires reconciliation
and never authorizes automatic retry. OAuth/refresh, other authentication methods,
legacy SSE transport, stdio hosting and protected native process/custody composition
remain open.

## Recovery

Disabling local tools does not discard retained execution evidence. Omitting both
registry settings leaves a runtime that reconciles retained settlement and refuses
unresolved outcomes, without polling for new invocations. An explicitly empty or
invalid registry file is refused. No restart automatically repeats an
uncertain effect. Credential-generation reconciliation remains governed by its
separate owner and acceptance requirements.

## Verification

- `worker-mesh-tool-registry.test.ts` exercises real local files and rejected paths.
- `worker-mesh-file-write.test.ts` covers descriptor authority, revocation,
  argument bounds and uncertain native results.
- `worker-mesh-mcp-http.test.ts` covers real HTTP/SSE execution, schema drift,
  certificate refusal, bearer authentication, credential changes/isolation/redaction,
  revocation before send, cancellation and lost replies.
- `pnpm verify:remote-worker:windows-files` exercises real create/edit/refusal
  cases, native protocol bounds, AddressSanitizer and fixed-image validation.
- `pnpm verify:remote-worker:windows-service-install` covers registry selection,
  update/disable, stale/concurrent writers and running-host file pins in both
  PowerShell engines, plus native configuration checks with AddressSanitizer.
- `mesh-capability-destination-e2e.test.ts` includes the built stock worker over
  native mTLS, anonymous/bearer MCP output, restart and changed-credential/registry refusal. Lost MCP
  replies retain an unknown settlement and stop the worker across restart.
- The selected mesh cases in `remote-worker-gateway-restart-e2e.test.ts` use the
  built Gateway and stock worker through Chat activation and tool approval.
- `pnpm verify:remote-worker:windows-package --root <candidate> --manifest-sha256
  <expected> --probe` executes the reader, writer and a bearer-authenticated loopback
  MCP file-read with packaged Node, including credential separation and changed-file
  refusal. Fixtures are retained outside the package in fresh sibling paths.

These local controlled-provider tests do not establish physical two-machine,
live-provider, installed-custody or Telegram acceptance. The current results are
recorded in [the comparison tracker](COMPARISON_IMPLEMENTATION_STATUS.md).
