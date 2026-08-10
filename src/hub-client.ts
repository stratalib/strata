const TIMEOUT_MS = 8000;

export interface HubSearchResult {
  id: string;
  description: string;
  tags: string[];
  source: 'hub';
}

export interface HubRecall {
  id: string;
  description: string;
  tags: string[];
  implementation: string;
  readme?: string;
}

export interface HubListResult {
  total?: number;
  domain?: string;
  domains?: Array<{ name: string; count: number }>;
  recalls?: Array<{ id: string; description: string }>;
}

async function hubFetch<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 429) throw new Error('Daily rate limit reached');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function hubSearch(
  hubUrl: string,
  apiKey: string,
  query: string,
  limit = 10
): Promise<HubSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return hubFetch<HubSearchResult[]>(`${hubUrl}/search?${params}`, apiKey);
}

export async function hubRead(
  hubUrl: string,
  apiKey: string,
  id: string
): Promise<HubRecall> {
  return hubFetch<HubRecall>(`${hubUrl}/recall/${encodeURIComponent(id)}`, apiKey);
}

export async function hubList(
  hubUrl: string,
  apiKey: string,
  domain?: string
): Promise<HubListResult> {
  const params = domain ? `?domain=${encodeURIComponent(domain)}` : '';
  return hubFetch<HubListResult>(`${hubUrl}/list${params}`, apiKey);
}

// Uploads loop records (signals + findings only — never user code candidates,
// those are gated upstream). Fire-and-forget from the caller's perspective;
// throws on transport failure so the caller can keep the outbox intact.
export async function hubUpload(
  hubUrl: string,
  apiKey: string,
  records: unknown[]
): Promise<void> {
  const res = await fetch(`${hubUrl}/contribute`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 429) throw new Error('Daily rate limit reached');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
