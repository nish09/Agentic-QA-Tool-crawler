import type { CapturedAPICall } from '@qalens/shared/types';

/**
 * Groups calls by METHOD + pathname (query string ignored). Exported so
 * callers (e.g. the server's per-call inference broadcast) can attribute a
 * result computed for one occurrence of an endpoint to every other captured
 * call that hit the same endpoint.
 */
export function endpointKey(call: CapturedAPICall): string {
  let pathname = call.url;
  try {
    pathname = new URL(call.url).pathname;
  } catch {
    // keep full URL if parse fails
  }
  return `${call.method}:${pathname}`;
}

/**
 * Removes duplicate API calls, keeping the first occurrence of each
 * METHOD + pathname combination.
 */
export function deduplicateCalls(calls: CapturedAPICall[]): CapturedAPICall[] {
  const seen = new Map<string, CapturedAPICall>();
  for (const call of calls) {
    const key = endpointKey(call);
    if (!seen.has(key)) seen.set(key, call);
  }
  return Array.from(seen.values());
}

/**
 * Groups calls by "METHOD /pathname" for summary reporting.
 */
export function groupByEndpoint(calls: CapturedAPICall[]): Map<string, CapturedAPICall[]> {
  const groups = new Map<string, CapturedAPICall[]>();
  for (const call of calls) {
    let pathname = call.url;
    try {
      pathname = new URL(call.url).pathname;
    } catch {
      // keep full URL
    }
    const key = `${call.method} ${pathname}`;
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  return groups;
}
