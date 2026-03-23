import type { ChatBindingTransport } from "@goatcitadel/contracts";

export class ReplayExecutionSkippedError extends Error {
  readonly transport?: ChatBindingTransport;
  readonly sessionId?: string;
  readonly turnId?: string;

  constructor(
    message: string,
    input: {
      transport?: ChatBindingTransport;
      sessionId?: string;
      turnId?: string;
    } = {},
  ) {
    super(message);
    this.name = "ReplayExecutionSkippedError";
    this.transport = input.transport;
    this.sessionId = input.sessionId;
    this.turnId = input.turnId;
  }
}
