export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
