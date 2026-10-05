import { hlcCompare } from "./hlc.js";
import type { HLC } from "./hlc.js";

export interface Register<T> {
  value: T;
  hlc: HLC;
}

export function registerFor<T>(
  current: Register<T> | undefined,
  value: T,
  hlc: HLC,
): Register<T> {
  if (current === undefined || hlcCompare(hlc, current.hlc) > 0) {
    return { value, hlc };
  }
  return current;
}
