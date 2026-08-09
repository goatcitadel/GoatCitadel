/** Value returned synchronously by direct repositories or asynchronously by AsyncStorage. */
export type Awaitable<T> = T | Promise<T>;

/** Preserve an owner's method arguments while allowing the live async graph. */
export type AwaitableOwnerMethods<Owner, Method extends keyof Owner> = {
  readonly [Key in Method]: Owner[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Awaitable<Result>
    : never;
};
