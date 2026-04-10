import type { DatabaseClient, DbStatement } from "./db.js";

export class GatewaySqlRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public prepare(sql: string): DbStatement {
    return this.db.prepare(sql);
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public runImmediateTransaction<T>(callback: () => T): T {
    return this.db.transaction("immediate", callback);
  }
}


