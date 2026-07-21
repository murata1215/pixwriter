import type { AppState } from "../state.js";
import { saveStrategy } from "../state.js";
import { generateContent } from "../claude-api.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executeAnalyze(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const focus = (input.focus as string) || "全体傾向";

  // Build analysis context
  const articlesInfo = state.articles
    .map((a) => {
      const latestPv = a.pvHistory[a.pvHistory.length - 1];
      const writerInfo = a.writer ? ` [writer:${a.writer}]` : "";
      const sourceInfo = a.source ? ` (${a.source})` : "";
      return `- 「${a.title}」(${a.status}, ${latestPv?.count ?? 0}PV${writerInfo}${sourceInfo})`;
    })
    .join("\n");

  const ideasInfo = `アイデア数: ${state.ideas.length} (idea=${state.ideas.filter((i) => i.phase === "idea").length}, outlined=${state.ideas.filter((i) => i.phase === "outlined").length}, drafted=${state.ideas.filter((i) => i.phase === "drafted").length})`;

  const prompt = `以下のブログの現状を分析し、今後の戦略を提案してください。

分析の焦点: ${focus}

現在の記事:
${articlesInfo || "(なし)"}

${ideasInfo}

現在の戦略:
${state.strategy}

直近の活動:
${state.journal.slice(-2000) || "(なし)"}

以下を含む戦略文書（Markdown形式）を作成してください:
1. 現状分析（PV傾向、成功パターン、課題）
2. ライター別・ネタ源別のPV傾向分析（writer/source情報がある記事について）
3. 今後の方針（注力すべきテーマ、投稿頻度、改善施策、ライター配分の調整提案）
4. 具体的な次のアクション提案

Markdownのみを返してください。`;

  const newStrategy = await generateContent(
    "あなたはブログ戦略コンサルタントです。データに基づいた実践的な戦略を提案してください。",
    prompt,
    2048
  );

  saveStrategy(newStrategy);
  log("INFO", "Strategy updated via analysis");

  return {
    success: true,
    summary: `PV分析完了（焦点: ${focus}）。strategy.mdを更新。`,
  };
}
