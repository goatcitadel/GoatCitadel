import { Worker } from "node:worker_threads";
import type { MemoryEmbeddingProfile, MemoryRecallSourceType } from "@goatcitadel/contracts";

export interface MemoryVectorIndexScope {workspaceId:string;sessionId?:string;generation:number;profile:MemoryEmbeddingProfile}
export interface MemoryVectorEntry {sourceType:MemoryRecallSourceType;sourceRef:string;vectorRef?:string;vector:number[];metadata:Record<string,unknown>}
export interface MemoryVectorResult {
  status:"ready"|"building"|"profile_incompatible"|"over_capacity"|"unavailable";
  hits:Array<{sourceType:MemoryRecallSourceType;sourceRef:string;score:number}>;
  indexedCount:number;
  unindexedCount:number;
}

/** Exact cosine runs in an owned worker. No corpus vectors are scanned on Gateway's event loop. */
export class MemoryRecallVectorIndex {
  private worker?:Worker;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  public constructor(private readonly options:{maxEntries?:number} = {}) {}
  public async begin(input:MemoryVectorIndexScope):Promise<void> {await this.request("begin",input);}
  public async append(input:MemoryVectorIndexScope & {entries:MemoryVectorEntry[]}):Promise<void> {
    if (input.entries.length > 200) throw new RangeError("Vector index pages are limited to 200 entries.");
    await this.request("append",input);
  }
  public async seal(input:MemoryVectorIndexScope):Promise<void> {await this.request("seal",input);}
  public async search(input:MemoryVectorIndexScope & {vector:number[];limit:number}):Promise<MemoryVectorResult> {
    return await this.request("search",input) as MemoryVectorResult;
  }
  public async close():Promise<void> {
    this.closed = true;
    this.fail(new Error("Memory vector index closed."));
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
  private request(command:string,input:unknown):Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Memory vector index closed."));
    if (!this.worker) {
      this.worker = new Worker(WORKER_SOURCE,{eval:true,execArgv:[],workerData:{maxEntries:Math.max(1,Math.min(10_000,Math.floor(this.options.maxEntries ?? 10_000)))}});
      this.worker.on("message",(message:{id:number;result?:unknown;error?:string}) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        if (!this.pending.size) this.worker?.unref();
      });
      this.worker.on("error",() => this.fail(new Error("Memory vector index worker failed.")));
      this.worker.on("exit",code => {if (!this.closed && code !== 0) this.fail(new Error("Memory vector index worker exited."));});
    }
    this.worker.ref();
    const id = ++this.nextId;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Memory vector index request timed out."));
        void this.worker?.terminate();
        this.worker = undefined;
      },10_000);
      this.pending.set(id,{resolve,reject,timer});
      try {this.worker!.postMessage({id,command,input});}
      catch {this.fail(new Error("Memory vector index request could not be transferred."));}
    });
  }
  private fail(error:Error):void {
    for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(error);}
    this.pending.clear();
    this.worker?.unref();
  }
}

// This fixed program accepts data over structured-clone messages; it never evaluates source text.
const WORKER_SOURCE = String.raw`
const {parentPort,workerData} = require('node:worker_threads');
let identity = '', status = 'building';
let rows = new Map(), excluded = new Set();
const key = input => JSON.stringify([input.workspaceId,input.sessionId || null,input.generation,input.profile.profileId,input.profile.provider,input.profile.modelId,input.profile.dimensions,input.profile.version,input.profile.status]);
const supported = profile => profile && profile.status === 'active' && ['remote','llamacpp'].includes(profile.provider) && Number.isInteger(profile.dimensions) && profile.dimensions > 0 && profile.dimensions <= 4096;
const normalize = (values,dimensions) => {
  if (!Array.isArray(values) || values.length !== dimensions || !values.every(Number.isFinite)) return;
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length <= 0) return;
  return Float32Array.from(values,value => value/length);
};
parentPort.on('message',message => {
  try {
    const {command,input} = message;
    let result;
    if (command === 'begin') {
      identity = key(input); rows = new Map(); excluded = new Set();
      status = supported(input.profile) ? 'building' : 'profile_incompatible';
    } else if (command === 'append' && key(input) === identity && status === 'building') {
      for (const entry of input.entries) {
        const rowKey = entry.sourceType + ':' + entry.sourceRef + (entry.vectorRef ? ':' + entry.vectorRef : '');
        const metadata = entry.metadata || {};
        const compatible = metadata.provider === input.profile.provider && metadata.modelId === input.profile.modelId && metadata.version === input.profile.version && metadata.dimensions === input.profile.dimensions;
        const vector = compatible && normalize(entry.vector,input.profile.dimensions);
        if (!vector) {rows.delete(rowKey);excluded.add(rowKey);continue;}
        excluded.delete(rowKey);
        rows.set(rowKey,{sourceType:entry.sourceType,sourceRef:entry.sourceRef,vector});
        if (rows.size > workerData.maxEntries) {rows.clear();status = 'over_capacity';break;}
      }
    } else if (command === 'seal' && key(input) === identity && status === 'building') status = 'ready';
    else if (command === 'search') {
      const actualStatus = !supported(input.profile) ? 'profile_incompatible' : key(input) !== identity ? 'building' : status;
      result = {status:actualStatus,hits:[],indexedCount:new Set([...rows.values()].map(row=>row.sourceType+':'+row.sourceRef)).size,unindexedCount:excluded.size};
      const vector = normalize(input.vector,input.profile.dimensions);
      if (actualStatus === 'ready' && vector) {
        for (const row of rows.values()) {
          let score = 0;
          for (let i=0;i<vector.length;i++) score += vector[i]*row.vector[i];
          if (score > 0) result.hits.push({sourceType:row.sourceType,sourceRef:row.sourceRef,score:Math.max(-1,Math.min(1,score))});
        }
        const best=new Map();for(const hit of result.hits){const ref=hit.sourceType+':'+hit.sourceRef;if(!best.has(ref) || best.get(ref).score<hit.score)best.set(ref,hit);}
        result.hits=[...best.values()];
        result.hits.sort((a,b) => b.score-a.score || a.sourceRef.localeCompare(b.sourceRef));
        result.hits = result.hits.slice(0,Math.max(1,Math.min(300,Math.floor(input.limit || 40))));
      } else if (!vector && actualStatus === 'ready') result.status = 'profile_incompatible';
    }
    parentPort.postMessage({id:message.id,result});
  } catch {parentPort.postMessage({id:message.id,error:'Invalid memory vector index request.'});}
});
`;
