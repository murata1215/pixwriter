import type { AppState } from "../state.js";
import { saveIdeas } from "../state.js";
import { generateContent } from "../claude-api.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executeOutline(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const ideaIndex = input.idea_index as number;

  if (ideaIndex < 0 || ideaIndex >= state.ideas.length) {
    return { success: false, summary: `無効なアイデアインデックス: ${ideaIndex}` };
  }

  const idea = state.ideas[ideaIndex];
  if (idea.phase !== "idea") {
    return {
      success: false,
      summary: `アイデア「${idea.title}」は既にphase=${idea.phase}。outlineはideaフェーズのみ可。`,
    };
  }

  const prompt = `以下のブログ記事アイデアについて、記事の構成（アウトライン）を作成してください。

タイトル案: ${idea.title}
テーマ: ${idea.topic}
メモ: ${idea.notes}
${idea.sourceUrl ? `参考URL: ${idea.sourceUrl}` : ""}

以下の形式でアウトラインを作成してください:
1. 最終的な記事タイトル
2. 導入部の要点（何を解決する記事か）
3. 各セクションの見出しと要点（3-5セクション）
4. まとめ・結論の方向性
5. 想定するタグ（3-5個）

重要:
- 読者に具体的な価値を提供する構成にする
- SEOを意識したタイトル・見出しにする
- 実体験や具体例を含められる構成にする`;

  const outline = await generateContent(
    "あなたは技術ブログの構成アドバイザーです。読者に価値のある記事構成を作成してください。",
    prompt,
    2048
  );

  // Update idea
  state.ideas[ideaIndex] = {
    ...idea,
    phase: "outlined",
    outline,
    updatedAt: new Date().toISOString(),
  };
  saveIdeas(state.ideas);

  log("INFO", `Outline created for idea: ${idea.title}`);

  return {
    success: true,
    summary: `アイデア「${idea.title}」のアウトラインを作成完了。次のサイクルでwrite可能。`,
  };
}
