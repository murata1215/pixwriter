import type { AppState } from "../state.js";
import { saveArticles, saveIdeas, todayPublishCount, repairIdeasForRemovedArticles, isInPublishSlot, getSlotIndex, isSlotConsumed } from "../state.js";
import { generateContent } from "../claude-api.js";
import { getPost, updatePost, getPosts } from "../pixblog-api.js";
import { MAX_PUBLISHES_PER_DAY } from "../config.js";
import { log } from "../logger.js";
import { generateAndUploadEyecatch } from "../image-gen.js";
import { executePublish } from "./publish.js";
import type { ActionResult } from "./index.js";

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

  // Ask Claude to review with full body content
  const prompt = `以下のブログ記事（draft）を推敲・改善してください。

タイトル: ${postDetail.title}
タグ: ${tags}

現在の本文（HTML）:
${htmlContent}

推敲の指示:
1. 記事全体を読み、内容・構成・文章の質を改善してください
2. SEOを意識したタイトル改善を提案してください
3. タグは適切か確認し、改善してください
4. 改善した本文全文をMarkdown形式で出力してください

以下のJSON形式で返してください（他の文章は不要）:
{
  "title": "改善後のタイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "body": "改善後のMarkdown本文全文"
}`;

  const result = await generateContent(
    "あなたはブログ記事の編集者です。記事の品質を高める推敲を行い、改善したMarkdown全文を返してください。",
    prompt,
    8192
  );

  // Parse improvements
  let improvements: { title: string; tags: string[]; body?: string } | null = null;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      improvements = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse review result: ${err}`);
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

    try {
      await updatePost(postId, patchData as { title: string; tags: string[]; body?: string; content_format?: "markdown" });
      article.title = improvements.title;
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

  // Generate eyecatch if missing
  if (!postDetail.featured_image_url && !postDetail.thumbnail_url) {
    log("INFO", `Article post_id=${postId} has no eyecatch. Generating one.`);
    const eyecatchUrl = await generateAndUploadEyecatch(
      article.title,
      tags || "tech"
    );
    if (eyecatchUrl) {
      try {
        await updatePost(postId, {
          body: `![${article.title}](${eyecatchUrl})\n\n`,
        });
        log("INFO", `Eyecatch added to article post_id=${postId}: ${eyecatchUrl}`);
      } catch (err) {
        log("WARN", `Failed to add eyecatch to article: ${err}`);
      }
    }
  }

  // Update phase to reviewed
  article.phase = "reviewed";
  saveArticles(state.articles);

  log("INFO", `Review completed for post_id=${postId}`);

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
        summary: `記事「${article.title}」のレビュー完了→そのまま公開しました (post_id=${postId})。`,
      };
    }
    log("WARN", `Auto-publish failed: ${publishResult.summary}`);
  }

  return {
    success: true,
    summary: `記事「${article.title}」のレビュー完了 (post_id=${postId})。次の公開スロットで公開します。`,
  };
}
