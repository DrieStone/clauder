import type { SearchResponse, SearchScope } from '@clauder/shared';

/** Hits /api/search. Callers pass an AbortController's signal so a newer keystroke can cancel
 *  a stale in-flight request — see SearchModal's debounce. */
export async function fetchSearch(q: string, scope: SearchScope, smart: boolean, signal?: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, scope, smart: smart ? '1' : '0' });
  const res = await fetch(`/api/search?${params.toString()}`, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Search failed: HTTP ${res.status}`);
  }
  return res.json();
}
