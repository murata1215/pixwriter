/**
 * Sanitize text to remove sensitive information before storing in ideas.json
 */
export function sanitize(text: string): string {
  return text
    // IP addresses
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED_IP]")
    // DevRelay PAT tokens
    .replace(/devrelay_pat_\S+/g, "[REDACTED_TOKEN]")
    // Bearer tokens
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED_TOKEN]")
    // Anthropic API keys
    .replace(/sk-ant-\S+/g, "[REDACTED_TOKEN]")
    // PixBlog API tokens (hex strings 40+ chars)
    .replace(/\b[0-9a-f]{40,}\b/g, "[REDACTED_TOKEN]")
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]")
    // Generic key/token/secret/password assignments
    .replace(/(?:key|token|secret|password)\s*[:=]\s*["']?\S{20,}/gi, "[REDACTED_SECRET]");
}

/**
 * Recursively sanitize all string values in an object
 */
export function sanitizeObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return sanitize(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeObject(value);
    }
    return result as T;
  }
  return obj;
}
