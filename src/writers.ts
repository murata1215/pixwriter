import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";
import { recordUsage } from "./budget.js";
import { recordOpenAITextUsage } from "./budget.js";
import { generateContentOpenAI } from "./openai-text.js";
import { log } from "./logger.js";
import type { AppState } from "./state.js";

const anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---- Writer Profiles ----

export interface WriterProfile {
  id: string;
  provider: "anthropic" | "openai";
  model: string;
  style: string;
  systemPrompt: string;
  maxTokens: number;
  weight: "light" | "medium" | "heavy"; // suitable idea weight
}

// Shared rules appended to every writer's system prompt. Enforces the
// "readable article" direction: concrete openings, first-hand info, no filler.
const COMMON_RULES =
  "【全ライター共通ルール】" +
  "冒頭は一般論ではなく具体（実際に起きたこと・詰まった場面・実際の画面や数値）から書き出す。" +
  "「〜な瞬間があります」「〜な人は多いのではないでしょうか」型の空フックは禁止。" +
  "「この記事では〜をまとめます」+ 得られることの箇条書き、という定型導入で字数を稼がない。" +
  "定型句（「読み終わる頃には」「ぜひ最後まで」「いかがでしたか」「〜が身につくはずです」）を乱用しない。" +
  "実コード・エラー原文・実プロダクト名・実数値などの一次情報を必ず盛り込む。水増しせず、内容で読ませる。";

function withCommon(base: string): string {
  return `${base}\n\n${COMMON_RULES}`;
}

export const WRITERS: WriterProfile[] = [
  {
    id: "sonnet-kaisetsu",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    style: "丁寧な解説型",
    systemPrompt: withCommon(
      "あなたは技術ブログの執筆者です。です・ます調で丁寧に解説してください。見出しを多めに使い、コード例を中心に据えた構成にしてください。読者に価値のある、わかりやすい記事をMarkdownで書いてください。"
    ),
    maxTokens: 4096,
    weight: "heavy",
  },
  {
    id: "sonnet-kosatsu",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    style: "考察エッセイ型",
    systemPrompt: withCommon(
      "あなたは個人開発者の技術ブロガーです。だ・である調で考察エッセイを書いてください。見出しは少なめにし、自分の意見や経験を前面に出してください。実体験のエピソードから書き出し、読者が共感できる語り口で深い考察を含むMarkdown記事を書いてください。"
    ),
    maxTokens: 4096,
    weight: "heavy",
  },
  {
    id: "gpt-tutorial",
    provider: "openai",
    model: "gpt-4.1-mini",
    style: "チュートリアル型",
    systemPrompt: withCommon(
      "あなたは技術チュートリアルの執筆者です。です・ます調で、手順を番号付きステップで示す構成にしてください。「Step 1: ...」のような形式を使い、読者がそのまま手順を追えるようにしてください。各手順に実際のコード・コマンド・出力例を添えてください。Markdown形式で書いてください。"
    ),
    maxTokens: 4096,
    weight: "medium",
  },
  {
    id: "haiku-quick",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    style: "短めTips型",
    systemPrompt: withCommon(
      "あなたは技術Tipsの執筆者です。です・ます調で短く要点を伝えてください。1つの課題とその解決策にフォーカスし、実際のコードや具体例を必ず入れて、1000〜1500文字程度のコンパクトな記事をMarkdownで書いてください。"
    ),
    maxTokens: 2048,
    weight: "light",
  },
];

// ---- Writer Selection ----

export function selectWriter(state: AppState, ideaWeight: "light" | "medium" | "heavy" = "medium", ideaSource?: string): WriterProfile {
  // Count recent writer usage
  const writerCounts = new Map<string, number>();
  for (const w of WRITERS) {
    writerCounts.set(w.id, 0);
  }
  for (const article of state.articles) {
    if (article.writer && writerCounts.has(article.writer)) {
      writerCounts.set(article.writer, (writerCounts.get(article.writer) ?? 0) + 1);
    }
  }

  // Filter out unsuitable writers for idea weight and source
  let candidates = WRITERS.filter((w) => {
    // Trouble articles: only use kaisetsu or tutorial styles
    if (ideaSource === "trouble" && w.id !== "sonnet-kaisetsu" && w.id !== "gpt-tutorial") return false;
    // Don't use haiku for heavy topics
    if (ideaWeight === "heavy" && w.weight === "light") return false;
    return true;
  });

  if (candidates.length === 0) candidates = WRITERS;

  // Pick the least used writer
  candidates.sort((a, b) => {
    const countA = writerCounts.get(a.id) ?? 0;
    const countB = writerCounts.get(b.id) ?? 0;
    return countA - countB;
  });

  const selected = candidates[0];
  log("INFO", `Writer selected: ${selected.id} (${selected.style}), model=${selected.model}`);
  return selected;
}

// ---- Generate with Writer ----

export async function generateWithWriter(
  writer: WriterProfile,
  additionalSystemPrompt: string,
  userPrompt: string,
  maxTokensOverride?: number
): Promise<string> {
  const systemPrompt = `${writer.systemPrompt}\n\n${additionalSystemPrompt}`;
  const maxTokens = maxTokensOverride ?? writer.maxTokens;

  if (writer.provider === "openai") {
    const { text, usage } = await generateContentOpenAI(
      writer.model,
      systemPrompt,
      userPrompt,
      maxTokens
    );
    recordOpenAITextUsage(usage.inputTokens, usage.outputTokens, usage.costUsd);
    return text;
  }

  // Anthropic
  log("INFO", `Anthropic API: generating with ${writer.model}`);
  const response = await anthropicClient.messages.create({
    model: writer.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.usage) {
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    log("INFO", `Anthropic usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic API did not return text content");
  }
  return textBlock.text;
}
