import type {TurnLearningReceipt} from "@goatcitadel/contracts";
import {request} from "./client-core.js";
export function fetchTurnLearningReceipt(sessionId:string,turnId:string,workspaceId:string){return request<TurnLearningReceipt>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/learning-receipt?${new URLSearchParams({workspaceId})}`);}
