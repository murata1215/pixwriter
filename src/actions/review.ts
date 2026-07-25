import type { AppState } from "../state.js";
import { saveArticles, saveIdeas, todayPublishCount, repairIdeasForRemovedArticles, isInPublishSlot, getSlotIndex, isSlotConsumed, loadQuality } from "../state.js";
import { generateContent } from "../claude-api.js";
import { getPost, updatePost, getPosts } from "../pixblog-api.js";
import { MAX_PUBLISHES_PER_DAY, QUALITY_SCORE_MIN } from "../config.js";
import { log } from "../logger.js";
import { generateAndUploadEyecatch } from "../image-gen.js";
import { executePublish } from "./publish.js";
import type { ActionResult } from "./index.js";

// NG cliché phrases: overuse signals AI-generated filler. Detected phrases are
// fed back into the rewrite instruction.
const NG_PHRASES = [
  "読み終わる頃には",
  "読み終えた頃には",
  "ぜひ最後まで",
  "いかがでしたか",
  "いかがでしたでしょうか",
  "身につくはずです",
  "身につくでしょう",
];

function detectClichePhrases(text: string): string[] {
  return NG_PHRASES.filter((p) => text.includes(p));
}

export async function executeReview(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const postId = input.post_id as number;

  const article = state.articles.find((a) => a.postId === postId);
  if (!article) {
    return { success: false, summary: `記事 post_id=${postId} が見つかりません。` };
  }
  if (article.phase !== "drafted") {
    return {
      success: false,
      summary: `記事「${article.title}」はphase=${article.phase}。reviewはdraftedフェーズのみ可。`,
    };
  }

  // Fetch full post with body content
  let postDetail;
  try {
    postDetail = await getPost(postId);
  } catch (err) {
    log("WARN", `Failed to get post detail for post_id=${postId}: ${err}`);
    // Fallback: check if post exists in list
    const posts = await getPosts();
    const found = posts.find((p) => p.id === postId);
    if (!found) {
      log("WARN", `Article post_id=${postId} not found on PixBlog API. Marking as removed.`);
      article.phase = "removed";
      saveArticles(state.articles);
      if (repairIdeasForRemovedArticles(state.ideas, state.articles)) {
        saveIdeas(state.ideas);
      }
      return {
        success: true,
        summary: `記事 post_id=${postId}「${article.title}」がPixBlog上に存在しません。removed処理しスキップ。`,
      };
    }
    return { success: false, summary: `記事 post_id=${postId} の本文取得に失敗: ${err}` };
  }

  const htmlContent = postDetail.content || "";
  const tags = postDetail.tags.map((t) => t.name).join(", ");
  const quality = loadQuality();

  // Quality gate: score 4 axes (1-5 each) AND produce an improved draft in one call
  const prompt = `以下のブログ記事（draft）を「読ませる記事」の基準で採点し、推敲・改善してください。

# 「読ませる記事」品質基準
${quality}

# 対象記事
タイトル: ${postDetail.title}
タグ: ${tags}

現在の本文（HTML）:
${htmlContent}

# やること
1. 読者視点で4軸を各1〜5点で採点する:
   - hook: 冒頭が具体的で読み進めたくなるか（一般論フックは低評価）
   - firsthand: 一次情報（実コード/エラー原文/実プロダクト名/実数値）の濃度。最低3つあるか
   - originality: 独自の判断・経験・視点があるか（一般論の寄せ集めは低評価）
   - concise: 水増しがなく簡潔か（定型句の乱用・冗長は低評価）
2. 不足点を deficiencies に列挙する（何を足せば読ませる記事になるか）
3. 基準を満たすよう本文を改善する。定型句（「読み終わる頃には」「ぜひ最後まで」等）は削る。
   一次情報が足りなければ、元記事にある具体を掘り起こして前に出す（事実の捏造は禁止）。
4. SEOを意識したタイトルとタグに改善する。
5. 検索スニペット用の excerpt（meta description）を作る: 100〜160字、記事の具体的な価値・結論を書く。
   定型句や「〜について解説します」型は禁止。検索結果でクリックしたくなる説明にする。

以下のJSON形式で返してください（他の文章は不要）:
{
  "scores": { "hook": 1-5, "firsthand": 1-5, "originality": 1-5, "concise": 1-5 },
  "deficiencies": ["不足点1", "不足点2"],
  "title": "改善後のタイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "excerpt": "検索スニペット向けの説明文（100〜160字）",
  "body": "改善後のMarkdown本文全文"
}`;

  const result = await generateContent(
    "あなたは辛口のブログ編集者です。読者が最後まで読む記事かを厳しく採点し、基準を満たすよう本文を書き直してください。改善したMarkdown全文とJSON採点を返してください。",
    prompt,
    6144
  );

  // Parse improvements + scores
  interface ReviewResult {
    scores?: { hook: number; firsthand: number; originality: number; concise: number };
    deficiencies?: string[];
    title: string;
    tags: string[];
    excerpt?: string;
    body?: string;
  }
  let improvements: ReviewResult | null = null;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      improvements = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse review result: ${err}`);
  }

  // Compute quality score (4..20) and decide whether a rewrite pass is needed
  let qualityScore: number | undefined;
  if (improvements?.scores) {
    const s = improvements.scores;
    qualityScore = (s.hook ?? 0) + (s.firsthand ?? 0) + (s.originality ?? 0) + (s.concise ?? 0);
  }

  if (improvements?.body) {
    const cliches = detectClichePhrases(improvements.body);
    const belowThreshold = qualityScore !== undefined && qualityScore < QUALITY_SCORE_MIN;

    if (belowThreshold || cliches.length > 0) {
      log(
        "INFO",
        `Quality gate: post_id=${postId} score=${qualityScore ?? "?"}/20 cliches=${cliches.length}. Rewriting once.`
      );
      const deficiencies = (improvements.deficiencies ?? []).map((d) => `- ${d}`).join("\n");
      const rewritePrompt = `以下の記事を、指摘された不足点を必ず解消して書き直してください。

# 「読ませる記事」品質基準
${quality}

# 現在のタイトル
${improvements.title}

# 現在の本文
${improvements.body}

# 解消すべき不足点
${deficiencies || "(採点上の不足)"}
${cliches.length > 0 ? `\n# 削除すべき定型句\n${cliches.map((c) => `- ${c}`).join("\n")}` : ""}

# 指示
- 一次情報（実コード/エラー原文/実プロダクト名/実数値）を最低3つ含める。元記事にある具体を掘り起こす（捏造禁止）。
- 一般論だけのフック・段落をなくし、具体から書き始める。
- 上記の定型句を削る。水増しをやめ、内容で勝負する。

改善後のMarkdown本文全文のみを返してください（JSON不要、前後の説明も不要）。`;

      try {
        const rewritten = await generateContent(
          "あなたは辛口のブログ編集者です。指摘された不足点を必ず解消し、読ませる記事に書き直してください。",
          rewritePrompt,
          6144
        );
        // Strip accidental code fences
        const cleaned = rewritten.replace(/^```(?:markdown)?\n?/, "").replace(/\n?```\s*$/, "").trim();
        if (cleaned.length > 200) {
          improvements.body = cleaned;
          log("INFO", `Quality gate: post_id=${postId} rewritten (${cleaned.length} chars).`);
        }
      } catch (err) {
        log("WARN", `Quality gate rewrite failed for post_id=${postId}: ${err}`);
      }
    } else {
      log("INFO", `Quality gate: post_id=${postId} passed (score=${qualityScore ?? "?"}/20).`);
    }
  }

  if (improvements) {
    const patchData: Record<string, unknown> = {
      title: improvements.title,
      tags: improvements.tags,
    };
    if (improvements.body) {
      patchData.body = improvements.body;
      patchData.content_format = "markdown";
    }
    // SEO: set meta description (excerpt) when the reviewer produced one
    if (improvements.excerpt && improvements.excerpt.trim().length > 0) {
      patchData.excerpt = improvements.excerpt.trim();
    }
    // Record quality score in the non-public memo
    if (qualityScore !== undefined && improvements.scores) {
      const s = improvements.scores;
      patchData.memo = `quality: ${qualityScore}/20 (hook:${s.hook} firsthand:${s.firsthand} originality:${s.originality} concise:${s.concise}) [${article.writer ?? "?"}]`;
    }

    try {
      await updatePost(postId, patchData as { title: string; tags: string[]; body?: string; content_format?: "markdown"; memo?: string; excerpt?: string });
      article.title = improvements.title;
      if (qualityScore !== undefined) article.qualityScore = qualityScore;
    } catch (err) {
      const errMsg = String(err);
      // Check if post actually exists before marking as removed
      if (errMsg.includes("400")) {
        try {
          await getPost(postId);
          // Post exists but PATCH failed for another reason
          log("ERROR", `PATCH failed for existing post post_id=${postId}: ${errMsg}`);
          return { success: false, summary: `記事 post_id=${postId} のPATCH更新に失敗: ${errMsg}` };
        } catch {
          // Post truly doesn't exist
          log("WARN", `Article post_id=${postId} not found. Marking as removed.`);
          article.phase = "removed";
          saveArticles(state.articles);
          if (repairIdeasForRemovedArticles(state.ideas, state.articles)) {
            saveIdeas(state.ideas);
          }
          return {
            success: true,
            summary: `記事 post_id=${postId}「${article.title}」が存在しないためremoved処理しスキップ。`,
          };
        }
      }
      throw err;
    }
  }

  // Generate eyecatch if missing — set it as the featured image (auto-rendered
  // on page/OGP/thumbnail). Previously this PATCHed `body` with only the image
  // markdown, which OVERWROTE the whole article body with a single image.
  if (!postDetail.featured_image_url && !postDetail.thumbnail_url) {
    log("INFO", `Article post_id=${postId} has no eyecatch. Generating one.`);
    const eyecatchUrl = await generateAndUploadEyecatch(
      article.title,
      tags || "tech"
    );
    if (eyecatchUrl) {
      try {
        await updatePost(postId, { featured_media_url: eyecatchUrl });
        log("INFO", `Eyecatch set as featured image for post_id=${postId}: ${eyecatchUrl}`);
      } catch (err) {
        log("WARN", `Failed to set featured image: ${err}`);
      }
    }
  }

  // Update phase to reviewed
  article.phase = "reviewed";
  saveArticles(state.articles);

  const scoreLabel = qualityScore !== undefined ? `（品質スコア ${qualityScore}/20）` : "";
  log("INFO", `Review completed for post_id=${postId} score=${qualityScore ?? "?"}/20`);

  // Auto-publish if in a publish slot, slot not consumed, and daily limit allows
  const currentSlot = getSlotIndex();
  if (
    todayPublishCount(state.articles) < MAX_PUBLISHES_PER_DAY &&
    isInPublishSlot() &&
    currentSlot >= 0 &&
    !isSlotConsumed(state.articles, currentSlot)
  ) {
    log("INFO", `In publish slot ${currentSlot}, auto-publishing post_id=${postId}`);
    const publishResult = await executePublish(state, { post_id: postId });
    if (publishResult.success) {
      return {
        success: true,
        summary: `記事「${article.title}」のレビュー完了${scoreLabel}→そのまま公開しました (post_id=${postId})。`,
      };
    }
    log("WARN", `Auto-publish failed: ${publishResult.summary}`);
  }

  return {
    success: true,
    summary: `記事「${article.title}」のレビュー完了${scoreLabel} (post_id=${postId})。次の公開スロットで公開します。`,
  };
}
