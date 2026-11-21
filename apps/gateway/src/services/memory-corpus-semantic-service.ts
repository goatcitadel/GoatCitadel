import {setImmediate as yieldToForeground} from "node:timers/promises";
import type { MemoryCorpusSearchRequest, MemoryCorpusSearchResult, RecallHit } from "@goatcitadel/contracts";
import {MemoryRecallVectorIndex,type AsyncStorage} from "@goatcitadel/storage";

export class MemoryCorpusSemanticService {
  private readonly index = new MemoryRecallVectorIndex();
  private warming?:Promise<void>;
  private overCapacityKey?:string;
  private closed = false;
  public constructor(private readonly deps:{repository:Pick<AsyncStorage["memoryRecall"],"listVectorPage"|"getEligibleSources"|"readGeneration">;
    registerBackgroundTask?:(task:Promise<void>)=>void;onFailure?:()=>void}) {}

  public async prepare(input:MemoryCorpusSearchRequest,generation:number):Promise<void> {
    const profile = input.queryEmbedding?.profile;
    if (!profile || this.closed) return;
    const scope = {workspaceId:input.workspaceId,sessionId:input.sessionId,generation,profile};
    await this.index.begin(scope);
    let after:string|undefined;
    let entries = 0;
    for (let pageNumber=0;pageNumber<51 && !this.closed;pageNumber++) {
      if (await this.deps.repository.readGeneration() !== generation) return;
      const page = await this.deps.repository.listVectorPage({workspaceId:input.workspaceId,sessionId:input.sessionId,after,limit:200});
      entries += page.entries.length;
      if (entries > 10_000) {this.overCapacityKey = scopeKey(input,generation);return;}
      await this.index.append({...scope,entries:page.entries});
      if (!page.hasMore) {
        if (await this.deps.repository.readGeneration() === generation) {
          await this.index.seal(scope);
          this.overCapacityKey = undefined;
        }
        return;
      }
      if (!page.after || page.after === after) throw new Error("Memory vector page did not advance.");
      after = page.after;
      await yieldToForeground();
    }
    if (!this.closed) this.overCapacityKey = scopeKey(input,generation);
  }

  public async augment(input:MemoryCorpusSearchRequest,result:MemoryCorpusSearchResult):Promise<MemoryCorpusSearchResult> {
    const query = input.queryEmbedding;
    if (!query || this.closed || result.coverage.lexicalStatus === "unavailable") return result;
    if (query.profile.status !== "active" || !["remote","llamacpp"].includes(query.profile.provider)) {
      return {...result,coverage:{...result.coverage,semanticStatus:"profile_incompatible",reason:"Lexical retrieval; a compatible real query embedding is unavailable."}};
    }
    if (input.sourceTypes && !input.sourceTypes.some(kind=>kind==="knowledge_chunk" || kind==="memory_item")) return result;
    const generation = await this.deps.repository.readGeneration();
    if (generation !== result.coverage.generation) return {...result,coverage:{...result.coverage,semanticStatus:"building",reason:"The corpus changed during retrieval."}};
    const key = scopeKey(input,generation);
    if (this.overCapacityKey === key) return {...result,coverage:{...result.coverage,semanticStatus:"over_capacity",reason:"Lexical retrieval; semantic corpus exceeds the bounded index capacity."}};
    try {
      const semantic = await this.index.search({workspaceId:input.workspaceId,sessionId:input.sessionId,generation,profile:query.profile,vector:query.values,limit:300});
      const coverage = {...result.coverage,semanticStatus:semantic.status,embeddingProfileId:query.profile.profileId,
        semanticIndexedCount:semantic.indexedCount,semanticUnindexedCount:Math.max(semantic.unindexedCount,result.coverage.indexedCount-semantic.indexedCount),
        reason:semantic.status === "ready" ? "Hybrid retrieval. Semantic coverage includes only stored compatible real embeddings; other sources use lexical retrieval." : "Lexical retrieval while the semantic index is unavailable or rebuilding."};
      if (semantic.status !== "ready") {
        if (semantic.status === "building" && !this.warming) {
          this.warming = this.prepare(input,generation).catch(() => this.deps.onFailure?.()).finally(() => {this.warming=undefined;});
          this.deps.registerBackgroundTask?.(this.warming);
        }
        return {...result,coverage};
      }
      const semanticHits=semantic.hits.filter(hit=>!input.sourceTypes || input.sourceTypes.includes(hit.sourceType));
      const current = await this.deps.repository.getEligibleSources({workspaceId:input.workspaceId,sessionId:input.sessionId,sources:semanticHits});
      if (await this.deps.repository.readGeneration() !== generation) return {...result,coverage:{...coverage,semanticStatus:"building"}};
      const currentByRef = new Map(current.filter(hit => !input.namespace || hit.namespace === input.namespace).map(hit => [`${hit.sourceType}:${hit.sourceRef}`,hit]));
      const merged = new Map<string,{hit:RecallHit;rank:number}>();
      result.hits.forEach((hit,i) => merged.set(`${hit.sourceType}:${hit.sourceRef}`,{hit,rank:1/(60+i+1)}));
      semanticHits.forEach((match,i) => {
        const ref = `${match.sourceType}:${match.sourceRef}`;
        const hit = currentByRef.get(ref);
        if (!hit) return;
        const old = merged.get(ref);
        merged.set(ref,{hit:{...(old?.hit ?? hit),semanticScore:match.score},rank:(old?.rank ?? 0)+1/(60+i+1)});
      });
      return {hits:[...merged.values()].sort((a,b) => b.rank-a.rank || a.hit.sourceRef.localeCompare(b.hit.sourceRef)).slice(0,Math.max(1,Math.min(300,input.limit ?? 40))).map(value => value.hit),coverage};
    } catch {
      this.deps.onFailure?.();
      return {...result,coverage:{...result.coverage,semanticStatus:"unavailable",reason:"Lexical retrieval; the semantic worker is unavailable."}};
    }
  }

  public async close():Promise<void> {
    this.closed = true;
    await this.warming;
    await this.index.close();
  }
}

function scopeKey(input:MemoryCorpusSearchRequest,generation:number):string {
  return JSON.stringify([input.workspaceId,input.sessionId,generation,input.queryEmbedding?.profile]);
}
