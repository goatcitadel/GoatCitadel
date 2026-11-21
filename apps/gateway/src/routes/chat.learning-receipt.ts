import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {withRouteAccess} from "./route-access.js";
import {sendRouteError} from "./_error-handler.js";
export function registerChatLearningReceiptRoutes(app:FastifyInstance){
  app.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/learning-receipt",withRouteAccess(app,"operator"),async(request,reply)=>{
    const params=z.object({sessionId:z.string().trim().min(1).max(256),turnId:z.string().trim().min(1).max(256)}).strict().safeParse(request.params),query=z.object({workspaceId:z.string().trim().min(1).max(256).optional()}).strict().safeParse(request.query);
    if(!params.success || !query.success)return reply.code(400).send({error:"Invalid learning receipt scope."});
    try{return await app.services.chatSupport.getTurnLearningReceipt(params.data.sessionId,params.data.turnId,query.data.workspaceId);}catch(error){return sendRouteError(reply,error,request.log);}
  });
}
