/**
 * REMOTE COMPOSE — the client half of the hub split.
 *
 * What crosses the wire, in full:
 *
 *     out:  { task, capabilities }
 *     in:   { recalls, files: { path: source-with-{{PLACEHOLDERS}} }, guidance }
 *
 * That is the entire protocol. No schema, no entity, no field names, no values, no source code, no
 * environment, no file listing. The hub composes blind and hands back a template; this module resolves
 * it against a schema that never left the machine.
 *
 * Why compose remotely at all: composition logic — fragment ordering, ranks, the verifier generator —
 * stops being versioned on the user's disk. A rank bug fixed on the hub is fixed for everyone on their
 * next call, with no upgrade and no version skew. For an engine that changed six times in one day,
 * that is the difference between a fix landing and a fix sitting in a release nobody installed.
 *
 * Why substitution stays local and stays CODE:
 *   - local, because the schema is the one thing we promised never to send;
 *   - code, because a model asked to fill placeholders paraphrases, renames a field, or misses one,
 *     and the result is a syntax error in the user's server.js with nothing pointing at the cause.
 */

export interface ComposeResponse {
  recalls: string[];
  files: Record<string, string>;
  guidance: string;
}

/** Network failures must never be fatal — a hub outage falls back to local composition. */
export class HubUnavailable extends Error {}

export async function composeOnHub(
  hubUrl: string,
  task: string,
  capabilities: string[],
  timeoutMs = 20_000,
): Promise<ComposeResponse> {
  const url = `${hubUrl.replace(/\/$/, '')}/v1/compose`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Explicitly constructed, never a spread of some larger object. A spread is how project data
      // leaks into a request nobody meant to send it in — the shape of this body IS the privacy claim,
      // so it is written out by hand where a reviewer can see every field.
      body: JSON.stringify({ task, capabilities }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HubUnavailable(`hub unreachable: ${(e as Error).message}`);
  }

  if (res.status === 404) return { recalls: [], files: {}, guidance: '' };   // declined, not an error
  if (!res.ok) throw new HubUnavailable(`hub returned ${res.status}`);

  const body = (await res.json()) as Partial<ComposeResponse>;
  return {
    recalls: Array.isArray(body.recalls) ? body.recalls : [],
    files: body.files && typeof body.files === 'object' ? body.files : {},
    guidance: typeof body.guidance === 'string' ? body.guidance : '',
  };
}

/**
 * Reject any path that would escape the project directory.
 *
 * The hub is our own server today, but this client must not be the reason a compromised or spoofed hub
 * can write to `../../.ssh/authorized_keys`. Path traversal via an archive/response entry is old and
 * still works, and "we control the server" is not a security boundary — it is an assumption that stops
 * holding the moment DNS, TLS, or the host is wrong.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 400) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) return false;  // absolute
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.some(seg => seg === '..' || seg === '')) return false;
  if (parts.some(seg => /[\x00-\x1f]/.test(seg))) return false;
  return true;
}

export function rejectUnsafePaths(files: Record<string, string>): string[] {
  return Object.keys(files).filter(p => !isSafeRelativePath(p));
}
