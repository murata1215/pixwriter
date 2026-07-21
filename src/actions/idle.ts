import type { ActionResult } from "./index.js";

export async function executeIdle(
  input: Record<string, unknown>
): Promise<ActionResult> {
  const reason = (input.reason as string) || "特になし";

  return {
    success: true,
    summary: `idle: ${reason}`,
  };
}
