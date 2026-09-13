/** A durable approval handoff is a pause, including after earlier parts sent. */
export class ChannelDeliveryApprovalPendingError extends Error {
  constructor(public readonly partId: string) {
    super("Channel delivery is waiting for its approved provider outcome.");
    this.name = "ChannelDeliveryApprovalPendingError";
  }
}
