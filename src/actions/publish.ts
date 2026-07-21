import type { AppState } from "../state.js";
import { saveArticles, saveIdeas, todayPublishCount, repairIdeasForRemovedArticles } from "../state.js";
import { updatePost, getPost } from "../pixblog-api.js";
import { MAX_PUBLISHES_PER_DAY } from "../config.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executePublish(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const postId = input.post_id as number;

  // Double-check guardrail: no more than MAX_PUBLISHES_PER_DAY per day
  if (todayPublishCount(state.articles) >= MAX_PUBLISHES_PER_DAY) {
    return {
      success: false,
      summary: `本日は既に${MAX_PUBLISHES_PER_DAY}本公開済みです。publishは1日${MAX_PUBLISHES_PER_DAY}本まで。`,
    };
  }

  const article = state.articles.find((a) => a.postId === postId);
  if (!article) {
    return { success: false, summary: `記事 post_id=${postId} が見つかりません。` };
  }
  if (article.phase !== "reviewed") {
    return {
      success: false,
      summary: `記事「${article.title}」はphase=${article.phase}。publishはreviewedフェーズのみ可。`,
    };
  }

  // Publish via API
  try {
    await updatePost(postId, { status: "published" });
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("400")) {
      // Verify if post actually exists before marking as removed
      try {
        await getPost(postId);
        // Post exists — PATCH failed for another reason
        log("ERROR", `Publish PATCH failed for existing post post_id=${postId}: ${errMsg}`);
        return { success: false, summary: `記事 post_id=${postId} の公開に失敗: ${errMsg}` };
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

  // Update article
  const now = new Date().toISOString();
  article.status = "published";
  article.phase = "published";
  article.publishedAt = now;
  saveArticles(state.articles);

  log("INFO", `Published post_id=${postId}: ${article.title}`);

  return {
    success: true,
    summary: `記事「${article.title}」を公開しました (post_id=${postId})。`,
  };
}
