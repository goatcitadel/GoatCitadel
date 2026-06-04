export class A2AJsonRpcServiceError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
