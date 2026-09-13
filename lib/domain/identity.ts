export interface AccountIdentity { id: string; email: string; name: string }

// Only the Sites dispatcher (and its development plugin) supplies these headers.
export function identityFromHeaders(headers: Headers): AccountIdentity | null {
  const id = headers.get('oai-authenticated-user-id')?.trim();
  const email = headers.get('oai-authenticated-user-email')?.trim();
  if (!id || !email) return null;
  let name = headers.get('oai-authenticated-user-full-name')?.trim() || '';
  if (headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { name = decodeURIComponent(name); } catch { name = ''; }
  }
  return { id, email, name: name || email };
}

export function resourceReferences(url: string, body: unknown): Array<{ kind: string; id: string }> {
  const refs = new Map<string, { kind: string; id: string }>();
  const add = (kind: string, id: string) => refs.set(`${kind}:${id}`, { kind, id });
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/api\/(tasks|conversations)\/([^/]+)/);
  if (match) add(match[1] === 'tasks' ? 'task' : 'conversation', decodeURIComponent(match[2]));
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'taskId' || key === 'conversationId') && typeof child === 'string' && child) {
        add(key === 'taskId' ? 'task' : 'conversation', child);
      } else if (typeof child === 'object') visit(child);
    }
  };
  visit(body);
  for (const key of ['taskId', 'conversationId']) {
    const id = parsed.searchParams.get(key);
    if (id) add(key === 'taskId' ? 'task' : 'conversation', id);
  }
  return [...refs.values()];
}
