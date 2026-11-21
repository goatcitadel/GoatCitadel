import {ConflictError,ValidationError,type LearningDispatchBudget} from "@goatcitadel/contracts";
import type {SystemSettingsRepository} from "./system-settings-repo.js";
import type {CostLedgerRepository} from "./cost-ledger-repo.js";

interface BudgetBook {spentUsd:number;reservations:Record<string,{jobId:string;reservedCostUsd:number}>}
export class LearningBudgetDenied extends Error {}
/** Embedded in the queue repository so reservation and dispatch identity share
 * its transaction. Unknown reservations remain held until canonical settlement. */
export class BackgroundLearningBudgetRepository {
  public constructor(private readonly settings:SystemSettingsRepository,private readonly costs:CostLedgerRepository) {}
  public readSnapshot(now:string):{spentCostUsd:number;reservedCostUsd:number;unsettledOperations:number} {
    const book=this.settings.get<BudgetBook>(`background_learning_budget_v1:${now.slice(0,10)}`)?.value ?? {spentUsd:0,reservations:{}};
    const reservations=Object.values(book.reservations),reservedCostUsd=reservations.reduce((sum,row)=>sum+row.reservedCostUsd,0);
    if(!Number.isFinite(book.spentUsd) || book.spentUsd<0 || !Number.isFinite(reservedCostUsd) || reservedCostUsd<0 || reservations.length>2048) throw new ValidationError({message:"Learning budget needs reconciliation."});
    return {spentCostUsd:book.spentUsd,reservedCostUsd,unsettledOperations:reservations.length};
  }
  public reserve(jobId:string,operationId:string,budget:LearningDispatchBudget,now:string):string {
    validateBudget(budget);
    const day=now.slice(0,10),key=`background_learning_budget_v1:${day}`;
    this.settings.mutate<BudgetBook>(key,{spentUsd:0,reservations:{}},book=>{
      if(book.reservations[operationId]) throw new ConflictError({message:"Learning operation already reserved."});
      if(Object.keys(book.reservations).length>=2048) throw new LearningBudgetDenied("Too many unsettled learning reservations.");
      const from=`${day}T00:00:00.000Z`,availability=this.costs.usageAvailability(from,now);
      if(availability.totalAgentEvents>0 && !availability.metricAvailability.costUsd.complete) throw new LearningBudgetDenied("Usage reconciliation is required.");
      const known=this.costs.summary("day",from,now).reduce((sum,row)=>sum+row.costUsd,0);
      const reserved=Object.values(book.reservations).reduce((sum,row)=>sum+row.reservedCostUsd,0);
      if(Math.max(known,book.spentUsd)+reserved+budget.reservedCostUsd>budget.dailyCostCeilingUsd+1e-10) throw new LearningBudgetDenied("Background learning cost ceiling reached.");
      return {...book,reservations:{...book.reservations,[operationId]:{jobId,reservedCostUsd:budget.reservedCostUsd}}};
    },now);
    return day;
  }
  public settle(jobId:string,operationId:string,day:string,status:"settled"|"not_started"|"unknown",actualCostUsd:number|undefined):void {
    if(status === "unknown") return;
    if(status === "settled" && (actualCostUsd === undefined || !Number.isFinite(actualCostUsd) || actualCostUsd<0)) throw new ConflictError({message:"Learning usage must settle before releasing its reservation."});
    this.settings.mutate<BudgetBook>(`background_learning_budget_v1:${day}`,{spentUsd:0,reservations:{}},book=>{
      const reservation=book.reservations[operationId];
      if(!reservation) return book;
      if(reservation.jobId !== jobId) throw new ConflictError({message:"Learning reservation belongs to another job."});
      const reservations={...book.reservations};delete reservations[operationId];
      return {spentUsd:book.spentUsd+(status === "settled" ? actualCostUsd!:0),reservations};
    });
  }
}
function validateBudget(budget:LearningDispatchBudget):void {
  if(!budget.providerId?.trim() || !budget.model?.trim() || !budget.pricingCatalogVersion || !/^[a-f0-9]{64}$/u.test(budget.pricingCatalogHash) ||
    !Number.isFinite(budget.reservedCostUsd) || budget.reservedCostUsd<0 || !Number.isFinite(budget.dailyCostCeilingUsd) || budget.dailyCostCeilingUsd<=0) throw new ValidationError({message:"Learning dispatch needs a current priced route and cost ceiling."});
}
