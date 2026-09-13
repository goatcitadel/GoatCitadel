import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  verifyRemoteWorkerWindowsPackage,
  WORKER_PACKAGE_NODE_VERSION,
  WORKER_PACKAGE_OPENSSL_VERSION,
} from "./lib/remote-worker-package-files.mjs";

export function probeRemoteWorkerWindowsPackage(input) {
  const inventory = verifyRemoteWorkerWindowsPackage(input);
  if (process.platform !== "win32" || inventory.target !== `windows-${process.arch}`)
    throw new Error("Package execution proof requires the matching Windows architecture.");
  for (const [name, args] of [
    ["GoatCitadelRemoteWorkerCellController.exe", []],
    ["GoatCitadelRemoteWorkerCellProvisioning.exe", ["--controller"]],
  ]) {
    const admission = spawnSync(path.join(input.root, "app/worker/native", name), args, {
      cwd: input.root, windowsHide: true, encoding: "utf8", timeout: 15000,
      maxBuffer: 65536, env: { SystemRoot: process.env.SystemRoot },
    });
    if (admission.error || admission.status !== 5 || admission.stdout.length !== 0)
      throw new Error("Packaged controller must refuse a process without the installed service identity.");
  }
  const source = `import fs from "node:fs"; import path from "node:path"; import {createHash,randomBytes} from "node:crypto"; import {createRequire} from "node:module"; import {createServer} from "node:http"; import {pathToFileURL} from "node:url";
const root=fs.realpathSync.native(process.cwd());
const require=createRequire(pathToFileURL(path.join(root,"app/worker/package.json")));
const modules=["@goatcitadel/contracts","@goatcitadel/contracts/mesh-schema-node","@goatcitadel/remote-worker-provisioner/windows-service-client","zod","@noble/hashes/sha256","ajv","ajv-formats"];
const resolved=modules.map(name=>({name,path:fs.realpathSync.native(require.resolve(name))}));
if(resolved.some(item=>!item.path.toLowerCase().startsWith(root.toLowerCase()+path.sep))) throw new Error("Dependency escaped package root.");
const worker=await import(pathToFileURL(path.join(root,"app/worker/dist/index.js")));
if(typeof worker.parseConnectedWorkerStartup!=="function" || typeof worker.createWindowsProtectedWorkerTransport!=="function") throw new Error("Worker entrypoints are unavailable.");
const provisioning=await import(pathToFileURL(path.join(root,"app/worker/dist/worker-windows-cell-provisioning.js")));
if(typeof provisioning.createWindowsWorkerCellProvisioning!=="function" || typeof provisioning.encodeWindowsWorkerCellProvisioning!=="function") throw new Error("Packaged native provisioning bridge is unavailable.");
const provisioningImage=require(path.join(root,"app/worker/native/GoatCitadelRemoteWorkerImageGuard.node")).pinCellProvisioningExecutor();
if(!provisioningImage.lease || fs.realpathSync.native(provisioningImage.executorPath)!==fs.realpathSync.native(path.join(root,"app/worker/native/GoatCitadelRemoteWorkerCellProvisioning.exe"))) throw new Error("Packaged provisioning image custody differs.");
const schemas=await import(pathToFileURL(require.resolve("@goatcitadel/contracts/mesh-schema-node")));
await schemas.validateMeshCapabilityJson(JSON.stringify({type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:false}),JSON.stringify({count:1}));
let rejected=false;
try { await schemas.validateMeshCapabilityJson(JSON.stringify({type:"integer"}),JSON.stringify("1")); } catch(error) { rejected=error instanceof schemas.MeshSchemaValidationError && error.reason==="invalid"; }
if(!rejected) throw new Error("Packaged schema validation did not enforce types.");
if(typeof worker.loadWorkerMeshToolRegistry!=="function" || typeof worker.createWorkerMeshFileReadDescriptor!=="function" || typeof worker.createWorkerMeshFileWriteDescriptor!=="function") throw new Error("Worker tool registry is unavailable.");
const contracts=await import(pathToFileURL(require.resolve("@goatcitadel/contracts")));
const hash=value=>createHash("sha256").update(contracts.canonicalJsonString(value)).digest("hex");
const descriptor=worker.createWorkerMeshFileReadDescriptor("package");
const unsignedEntry={localId:"file.read",kind:"tool",capabilityId:"mesh:probe:tool:file.read",descriptor,descriptorSha256:hash(descriptor),permissionEnvelopeSha256:hash(descriptor.permissions)};
const entry={...unsignedEntry,entrySha256:hash(unsignedEntry)};
const unsignedManifest={schemaVersion:contracts.MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,workspaceId:"probe",nodeId:"probe",admissionGeneration:1,publisherGeneration:1,publicationKey:"probe",publicationLeaseFencingToken:1,entries:[entry],createdAt:new Date().toISOString()};
const manifest={...unsignedManifest,manifestSha256:hash(unsignedManifest)};
const reader=await import(pathToFileURL(path.join(root,"app/worker/dist/worker-mesh-file-read.js")));
const signal=AbortSignal.timeout(5000);
const binding=await reader.createWorkerMeshFileReadBinding({manifest,localId:entry.localId,rootId:"package",rootPath:path.join(root,"app/worker"),signal,assertConfigurationCurrent:async()=>undefined});
const result=await binding.owner.execute({entry,input:{path:"package.json"},envelope:{workspaceId:"probe",nodeId:"probe",manifestSha256:manifest.manifestSha256},signal});
if(result.disposition!=="succeeded" || result.output.content!==fs.readFileSync(path.join(root,"app/worker/package.json"),"utf8")) throw new Error("Packaged file reader did not return the package bytes.");
const writeRoot=fs.mkdtempSync(path.join(path.dirname(root),"worker-file-probe-"));
const writeDescriptor=worker.createWorkerMeshFileWriteDescriptor("probe");
const writeUnsignedEntry={localId:"file.write",kind:"tool",capabilityId:"mesh:probe:tool:file.write",descriptor:writeDescriptor,descriptorSha256:hash(writeDescriptor),permissionEnvelopeSha256:hash(writeDescriptor.permissions)};
const writeEntry={...writeUnsignedEntry,entrySha256:hash(writeUnsignedEntry)};
const writeUnsignedManifest={...unsignedManifest,entries:[writeEntry]};
const writeManifest={...writeUnsignedManifest,manifestSha256:hash(writeUnsignedManifest)};
const writer=await import(pathToFileURL(path.join(root,"app/worker/dist/worker-mesh-file-write.js")));
const writeSignal=AbortSignal.timeout(5000);
const writeBinding=await writer.createWorkerMeshFileWriteBinding({manifest:writeManifest,localId:writeEntry.localId,rootId:"probe",rootPath:writeRoot,signal:writeSignal,assertConfigurationCurrent:async()=>undefined});
const invokeWrite=input=>writeBinding.owner.execute({entry:writeEntry,input,envelope:{workspaceId:"probe",nodeId:"probe",manifestSha256:writeManifest.manifestSha256},signal:writeSignal});
const created=await invokeWrite({path:"note.txt",content:"initial",expectedContent:null});
const edited=await invokeWrite({path:"note.txt",content:"edited",expectedContent:"initial"});
const stale=await invokeWrite({path:"note.txt",content:"must not overwrite",expectedContent:"initial"});
if(created.disposition!=="succeeded" || created.output.created!==true || edited.disposition!=="succeeded" || edited.output.created!==false || edited.output.sha256!==createHash("sha256").update("edited").digest("hex") || stale.disposition!=="failed" || fs.readFileSync(path.join(writeRoot,"note.txt"),"utf8")!=="edited") throw new Error("Packaged file writer did not enforce exact-content replacement.");
const nativeMcpTools=[{name:"package.read",inputSchema:{type:"object",properties:{path:{type:"string",enum:["note.txt"]}},required:["path"],additionalProperties:false}}];
const bearerToken=randomBytes(32).toString("base64url");
const authorization={type:"bearer_file",file:writeRoot+".token",sha256:createHash("sha256").update(bearerToken).digest("hex")};
fs.writeFileSync(authorization.file,bearerToken,{flag:"wx"});
let mcpCalls=0,authenticatedRequests=0;
const server=createServer(async(req,res)=>{try{
  if(req.headers.authorization!=="Bearer "+bearerToken){res.writeHead(401).end();return;}
  authenticatedRequests++;
  if(req.method==="DELETE"){res.writeHead(204).end();return;}
  const chunks=[];for await(const chunk of req) chunks.push(chunk);
  const rpc=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(rpc.method==="notifications/initialized"){res.writeHead(202).end();return;}
  let result;
  if(rpc.method==="initialize") result={protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"package-probe",version:"1.0.0"}};
  else if(rpc.method==="tools/list") result={tools:nativeMcpTools};
  else if(rpc.method==="tools/call" && rpc.params.name==="package.read" && rpc.params.arguments.path==="note.txt") {mcpCalls++;result={content:[{type:"text",text:fs.readFileSync(path.join(writeRoot,"note.txt"),"utf8")}]};}
  else {res.writeHead(400).end();return;}
  res.writeHead(200,{"Content-Type":"application/json",...(rpc.method==="initialize"?{"Mcp-Session-Id":"package-probe"}:{})}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
}catch{res.destroy();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
  const endpoint="http://127.0.0.1:"+server.address().port+"/mcp";
  const mcpDescriptor=worker.createWorkerMeshMcpHttpDescriptor(endpoint,nativeMcpTools,authorization);
  const mcpUnsignedEntry={localId:"mcp.probe",kind:"mcp_server",capabilityId:"mesh:probe:mcp_server:mcp.probe",descriptor:mcpDescriptor,descriptorSha256:hash(mcpDescriptor),permissionEnvelopeSha256:hash(mcpDescriptor.permissions)};
  const mcpEntry={...mcpUnsignedEntry,entrySha256:hash(mcpUnsignedEntry)};
  const mcpUnsignedManifest={...unsignedManifest,entries:[mcpEntry]};
  const mcpManifest={...mcpUnsignedManifest,manifestSha256:hash(mcpUnsignedManifest)};
  const mcpOwner=await import(pathToFileURL(path.join(root,"app/worker/dist/worker-mesh-mcp-http.js")));
  const mcpSignal=AbortSignal.timeout(5000);
  const mcpConfiguration={manifest:mcpManifest,localId:mcpEntry.localId,endpoint,tools:nativeMcpTools,authorization};
  for(const rootPath of [writeRoot,path.dirname(writeRoot)]){
    const bytes=JSON.stringify({schemaVersion:worker.WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION,workspaceId:"probe",nodeId:"probe",bindings:[{toolName:"mcp.http",...mcpConfiguration},{toolName:"fs.write",manifest:writeManifest,localId:writeEntry.localId,rootId:"probe",rootPath}]});
    const file=path.join(writeRoot,"registry.json");fs.writeFileSync(file,bytes);
    let refused=false;
    try{await worker.loadWorkerMeshToolRegistry({file,sha256:createHash("sha256").update(bytes).digest("hex")},{workspaceId:"probe",nodeId:"probe"},mcpSignal);}catch{refused=true;}
    if(refused!==(rootPath!==writeRoot)) throw new Error("Packaged registry did not isolate the bearer credential from the native file writer.");
  }
  const mcpBinding=await mcpOwner.createWorkerMeshMcpHttpBinding({...mcpConfiguration,signal:mcpSignal,assertConfigurationCurrent:async()=>undefined});
  const mcpResult=await mcpBinding.owner.execute({entry:mcpEntry,input:{toolName:"package.read",arguments:{path:"note.txt"}},envelope:{workspaceId:"probe",nodeId:"probe",manifestSha256:mcpManifest.manifestSha256},signal:mcpSignal,assertRemoteCurrent:async()=>undefined});
  if(mcpResult.disposition!=="succeeded" || mcpResult.output.content[0].text!=="edited" || mcpCalls!==1 || authenticatedRequests!==5 || JSON.stringify({mcpResult,mcpManifest}).includes(bearerToken)) throw new Error("Packaged destination MCP authentication or single execution proof failed.");
  fs.writeFileSync(authorization.file,randomBytes(32).toString("base64url"));
  const refused=await mcpBinding.owner.execute({entry:mcpEntry,input:{toolName:"package.read",arguments:{path:"note.txt"}},envelope:{workspaceId:"probe",nodeId:"probe",manifestSha256:mcpManifest.manifestSha256},signal:mcpSignal,assertRemoteCurrent:async()=>undefined});
  if(refused.disposition!=="failed" || mcpCalls!==1 || authenticatedRequests!==5) throw new Error("Packaged destination MCP reused a changed credential.");
}finally{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
console.log(JSON.stringify({node:process.versions.node,openssl:process.versions.openssl,platform:process.platform,architecture:process.arch,nativeProvisioningImagePinned:true,filesystemRead:true,filesystemWrite:true,destinationMcp:true,destinationMcpBearer:true,credentialRootSeparation:true,credentialChangeRefused:true,authenticatedRequests,mcpCalls,fileWriteProbeDirectory:writeRoot,modules:resolved.map(item=>item.name)}));`;
  const child = spawnSync(path.join(input.root, "app/runtime/node.exe"), ["--input-type=module", "-e", source], {
    cwd: input.root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
    env: { SystemRoot: process.env.SystemRoot },
  });
  if (child.error || child.status !== 0)
    throw new Error(`Packaged worker import failed: ${child.error?.code ?? child.status}; ${child.stderr ?? ""}`);
  const runtime = JSON.parse(child.stdout);
  if (runtime.node !== WORKER_PACKAGE_NODE_VERSION || runtime.openssl !== WORKER_PACKAGE_OPENSSL_VERSION)
    throw new Error("Packaged Node/OpenSSL runtime differs from its declared pin.");
  verifyRemoteWorkerWindowsPackage(input);
  return Object.freeze({
    inventory,
    runtime,
    controllerAdmissionRefused: true,
    boundary: "Portable foreground package; installed service and custody remain unproven.",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {};
    let probe = false;
    for (let index = 2; index < process.argv.length; index++) {
      const argument = process.argv[index];
      if (argument === "--probe" && !probe) {
        probe = true;
        continue;
      }
      if (
        !["--root", "--manifest-sha256"].includes(argument) ||
        Object.hasOwn(values, argument) ||
        !process.argv[index + 1]
      )
        throw new Error("Usage: --root <package> --manifest-sha256 <expected hash> [--probe]");
      values[argument] = process.argv[++index];
    }
    const input = { root: values["--root"], expectedManifestSha256: values["--manifest-sha256"] };
    const result = probe ? probeRemoteWorkerWindowsPackage(input) : verifyRemoteWorkerWindowsPackage(input);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
