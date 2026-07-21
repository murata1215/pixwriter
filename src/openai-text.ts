import OpenAI from "openai";
import { OPENAI_API_KEY } from "./config.js";
import { log } from "./logger.js";

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Pricing per million tokens
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export interface OpenAIUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function generateContentOpenAI(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096
): Promise<{ text: string; usage: OpenAIUsage }> {
  if (!client) {
    throw new Error("OpenAI API key not configured");
  }

  log("INFO", `OpenAI API: generating content with ${model}`);

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  const pricing = MODEL_PRICING[model] ?? { input: 0.4, output: 1.6 };
  const costUsd =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  log("INFO", `OpenAI usage: in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(4)}`);

  return { text, usage: { inputTokens, outputTokens, costUsd } };
}
