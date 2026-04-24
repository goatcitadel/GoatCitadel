/* eslint-disable @typescript-eslint/no-explicit-any */
export type RouteMethod = (...args: any[]) => any;
export type RoutePort<TMethod extends string> = Record<TMethod, RouteMethod>;
export type RouteService<TMethod extends string> = Readonly<RoutePort<TMethod>>;

export function createRouteService<TMethod extends string>(
  port: RoutePort<TMethod>,
  methods: readonly TMethod[],
): RouteService<TMethod> {
  const service = {} as RoutePort<TMethod>;
  for (const method of methods) {
    service[method] = ((...args: any[]) => port[method](...args)) as RoutePort<TMethod>[TMethod];
  }
  return Object.freeze(service);
}
