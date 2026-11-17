export const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;

export async function readProviderJson(response: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AI provider response exceeded the 1 MiB size limit.");
  }
  if (!response.body) throw new Error("AI provider returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AI provider response exceeded the 1 MiB size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("AI provider returned malformed JSON.");
  }
}

/** Release an unused upstream error body without exposing its contents. */
export async function discardProviderResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
