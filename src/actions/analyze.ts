import type { AppState } from "../state.js";
import { saveStrategy } from "../state.js";
import { generateContent } from "../claude-api.js";
import { PV_SUCCESS_THRESHOLD } from "../config.js";
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
      const scoreInfo = a.qualityScore !== undefined ? ` [品質:${a.qualityScore}/20]` : "";
      return `- 「${a.title}」(${a.status}, ${latestPv?.count ?? 0}PV${writerInfo}${sourceInfo}${scoreInfo})`;
    })
    .join("\n");

  const maxPv = Math.max(0, ...state.articles.map((a) => a.pvHistory[a.pvHistory.length - 1]?.count ?? 0));
  const anyArticleSucceeded = maxPv >= PV_SUCCESS_THRESHOLD;

  const ideasInfo = `アイデア数: ${state.ideas.length} (idea=${state.ideas.filter((i) => i.phase === "idea").length}, outlined=${state.ideas.filter((i) => i.phase === "outlined").length}, drafted=${state.ideas.filter((i) => i.phase === "drafted").length})`;

  const prompt = `以下のブログの現状を分析し、今後の戦略を提案してください。

分析の焦点: ${focus}

# PV評価の絶対ルール（厳守）
- 記事の成功基準は${PV_SUCCESS_THRESHOLD}PV以上。${PV_SUCCESS_THRESHOLD}PV未満は「評価保留」であり、テーマ軸の確定・撤退・注力判断の根拠にしてはならない。
- 1桁〜数十PVはオーナー本人の確認アクセスが大半のノイズ。この差（例: 10PV vs 0PV）で「このテーマが当たり」「このテーマは撤退」と断定するのは誤り。過去の分析はこの誤りを犯していた。
- 現在の最高PVは${maxPv}PV。${anyArticleSucceeded ? `${PV_SUCCESS_THRESHOLD}PVに到達した記事があるため、その記事の特徴分析は有効。` : `全記事が${PV_SUCCESS_THRESHOLD}PV未満のため、PVによる戦略確定は凍結する。`}
- ${anyArticleSucceeded ? "" : `全記事が${PV_SUCCESS_THRESHOLD}PV未満の現段階では、改善軸は次の2つに限定する: (1) 記事品質（quality.md基準: 一次情報の濃度・定型句排除・具体的な冒頭）(2) 検索インデックス・流入経路の確保。PVでのテーマ確定はしない。`}
- 品質スコア([品質:N/20]表記)がある記事については、スコアと今後のPVの関係を観察対象として記録する（ただし${PV_SUCCESS_THRESHOLD}PV到達記事が出るまで相関は断定しない）。

現在の記事:
${articlesInfo || "(なし)"}

${ideasInfo}

現在の戦略:
${state.strategy}

直近の活動:
${state.journal.slice(-2000) || "(なし)"}

以下を含む戦略文書（Markdown形式）を作成してください:
1. 現状分析（PV評価の絶対ルールに従う。${PV_SUCCESS_THRESHOLD}PV未満の記事間のPV差で優劣を断定しない）
2. ライター別・ネタ源別・品質スコア別の観察（${PV_SUCCESS_THRESHOLD}PV未満の間はPV結論を出さず、品質面の傾向を記述）
3. 今後の方針（${anyArticleSucceeded ? "成功記事の特徴を踏まえた注力テーマ" : "PVでの確定を避け、記事品質と流入経路の改善に集中"}、投稿頻度、ライター配分）
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
