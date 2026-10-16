/**
 * A provider failure that is known to have happened before the outbound message
 * could reach the provider, even though the comms mutation boundary was already
 * marked (for transports, like SMTP, whose single send call spans connect, auth,
 * envelope, and data). The comms executor classifies it as a pre-boundary failure
 * instead of an unknown external outcome.
 */
export class CommsPreBoundaryProviderError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CommsPreBoundaryProviderError";
  }
}
