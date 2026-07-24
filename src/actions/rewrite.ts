import type { AppState } from "../state.js";
import { saveArticles, saveIdeas, repairIdeasForRemovedArticles } from "../state.js";
import { generateContent } from "../claude-api.js";
import { getPost, updatePost, getPosts } from "../pixblog-api.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executeRewrite(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const postId = input.post_id as number;
  const focus = (input.improvement_focus as string) || "全体的な改善";

  const article = state.articles.find((a) => a.postId === postId);
  if (!article) {
    return { success: false, summary: `記事 post_id=${postId} が見つかりません。` };
  }
  if (article.phase !== "published") {
    return {
      success: false,
      summary: `記事「${article.title}」はphase=${article.phase}。rewriteはpublishedフェーズのみ可。`,
    };
  }

  // Fetch full post with body content
  let postDetail;
  try {
    postDetail = await getPost(postId);
  } catch (err) {
    log("WARN", `Failed to get post detail for post_id=${postId}: ${err}`);
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

  // PV analysis for this article
  const pvInfo = article.pvHistory
    .map((p) => `${p.date}: ${p.count}PV`)
    .join(", ");

  const prompt = `以下の公開記事を改善してください。

タイトル: ${postDetail.title}
タグ: ${tags}
PV推移: ${pvInfo}
改善の焦点: ${focus}

現在の本文（HTML）:
${htmlContent}

改善の指示:
1. SEOを意識し、クリックされやすいタイトルに改善
2. 本文の内容・構成・読みやすさを改善
3. タグを見直し
4. 改善した本文全文をMarkdown形式で出力
5. 検索スニペット用の excerpt（meta description、100〜160字、記事の具体的な価値を書く。定型句・「〜について解説します」型は禁止）を出力

以下のJSON形式で返してください（他の文章は不要）:
{
  "title": "改善後のタイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "excerpt": "検索スニペット向けの説明文（100〜160字）",
  "body": "改善後のMarkdown本文全文"
}`;

  const result = await generateContent(
    "あなたはSEOとコンテンツマーケティングの専門家です。記事を改善してください。",
    prompt,
    8192
  );

  let improvements: { title: string; tags: string[]; excerpt?: string; body?: string } | null = null;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      improvements = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse rewrite result: ${err}`);
    return { success: false, summary: "改善結果のパースに失敗。" };
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
    if (improvements.excerpt && improvements.excerpt.trim().length > 0) {
      patchData.excerpt = improvements.excerpt.trim();
    }

    try {
      await updatePost(postId, patchData as { title: string; tags: string[]; body?: string; content_format?: "markdown"; excerpt?: string });
      article.title = improvements.title;
      saveArticles(state.articles);
      log("INFO", `Rewritten post_id=${postId}: ${improvements.title}`);
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("400")) {
        try {
          await getPost(postId);
          log("ERROR", `PATCH failed for existing post post_id=${postId}: ${errMsg}`);
          return { success: false, summary: `記事 post_id=${postId} のPATCH更新に失敗: ${errMsg}` };
        } catch {
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

  return {
    success: true,
    summary: `記事「${article.title}」を改善しました (post_id=${postId})。焦点: ${focus}`,
  };
}
