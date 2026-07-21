import type { AppState } from "../state.js";
import { saveIdeas, saveArticles, jstToday } from "../state.js";
import { createPost } from "../pixblog-api.js";
import { generateAndUploadEyecatch, processBodyDiagrams } from "../image-gen.js";
import { selectWriter, generateWithWriter } from "../writers.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executeWrite(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const ideaIndex = input.idea_index as number;

  if (ideaIndex < 0 || ideaIndex >= state.ideas.length) {
    return { success: false, summary: `無効なアイデアインデックス: ${ideaIndex}` };
  }

  const idea = state.ideas[ideaIndex];

  // Dedup check 1: idea already has a postId (was already written)
  if (idea.postId) {
    if (idea.phase === "idea" || idea.phase === "outlined") {
      log("WARN", `Idea "${idea.title}" has postId=${idea.postId} but phase=${idea.phase}. Auto-fixing to drafted.`);
      state.ideas[ideaIndex] = { ...idea, phase: "drafted", updatedAt: new Date().toISOString() };
      saveIdeas(state.ideas);
    }
    return {
      success: false,
      summary: `アイデア「${idea.title}」は既に投稿済み (postId=${idea.postId})。重複writeを防止。`,
    };
  }

  if (idea.phase !== "outlined" && idea.phase !== "idea") {
    return {
      success: false,
      summary: `アイデア「${idea.title}」はphase=${idea.phase}。writeはideaまたはoutlinedフェーズのみ可。`,
    };
  }

  // Dedup check 2: article with same title already exists
  const existingArticle = state.articles.find(
    (a) => a.title === idea.title && (a.phase === "drafted" || a.phase === "reviewed")
  );
  if (existingArticle) {
    log("WARN", `Article with same title already exists: postId=${existingArticle.postId}. Auto-fixing idea.`);
    state.ideas[ideaIndex] = {
      ...idea,
      phase: "drafted",
      postId: existingArticle.postId,
      updatedAt: new Date().toISOString(),
    };
    saveIdeas(state.ideas);
    return {
      success: false,
      summary: `アイデア「${idea.title}」と同タイトルの記事が既に存在 (postId=${existingArticle.postId})。重複writeを防止し、ideaを修正。`,
    };
  }

  // Select writer profile based on idea weight and source
  const hasOutline = idea.phase === "outlined" && idea.outline;
  const isTrouble = idea.source === "trouble";
  const ideaWeight = hasOutline ? "heavy" as const : (idea.notes.length > 200 ? "medium" as const : "light" as const);
  const writer = selectWriter(state, ideaWeight, idea.source);

  let prompt: string;
  let writingRules: string;

  if (isTrouble) {
    // Troubleshoot-specific template
    prompt = `以下のトラブルシュートのネタについて、検索流入を意識した記事をMarkdown形式で執筆してください。

タイトル案: ${idea.title}
テーマ: ${idea.topic}
メモ（症状・原因・解決策）:
${idea.notes}
${idea.sourceUrl ? `参考URL: ${idea.sourceUrl}` : ""}`;

    writingRules = `

執筆ルール（トラブルシュート記事専用）:
- Markdown形式で書く
- 最初の行にH1タイトルは不要（PixBlogが自動付与）
- **冒頭に「結論（解決策の要約）」を3行以内で先置きする**（急いでいる読者への配慮）
- 本文構成は以下の順序を厳守:
  1. ## 症状とエラーメッセージ（エラー全文をコードブロックで掲載）
  2. ## 環境（言語/FW/OS等。一般化して記述、内部情報は書かない）
  3. ## 試したこと（失敗した試行も含めて時系列で）
  4. ## 原因
  5. ## 解決策（コード/コマンド/設定を具体的に）
  6. ## まとめ
- エラーメッセージ原文に内部情報が含まれる場合はその部分のみ伏せ字にする
- 図解は「原因の構造」が図で伝わる場合のみSVGで埋め込む（無理に入れない）
- 読みやすい分量（1500-3000文字程度）
- 自分の言葉で書く。認証情報・サーバーIP・内部ホスト名は書かない`;
  } else {
    prompt = hasOutline
      ? `以下のアウトラインに基づいて、ブログ記事の本文をMarkdown形式で執筆してください。

アウトライン:
${idea.outline}

参考メモ: ${idea.notes}
${idea.sourceUrl ? `参考URL: ${idea.sourceUrl}` : ""}`
      : `以下のネタについて、ブログ記事の本文をMarkdown形式で執筆してください。

タイトル案: ${idea.title}
テーマ: ${idea.topic}
メモ: ${idea.notes}
${idea.sourceUrl ? `参考URL: ${idea.sourceUrl}` : ""}

記事の構成は自分で考えて、導入→本題（2-4セクション）→まとめの流れで書いてください。`;

    writingRules = `

執筆ルール:
- Markdown形式で書く（H2, H3見出し、コードブロック、リスト等を適切に使用）
- 最初の行にH1タイトルは不要（PixBlogが自動付与）
- 導入部で読者の課題を明示し、この記事で何が得られるか示す
- 具体的なコード例やコマンド例を含める（技術記事の場合）
- 自分の言葉で書く。他サイトの文章の転載は絶対禁止
- 事実に自信がない内容は断定せず、出典URLを明記する
- 読みやすい分量（1500-3000文字程度）
- 最後にまとめセクションを入れる
- 本文中に図解（比較図・フロー図・構成図など）が1つあると効果的な箇所があれば、その内容を正確に表すSVGコードを <svg>...</svg> タグで本文中の該当位置に埋め込む（最大1点、装飾目的では作らない、不要なら出力しない）`;
  }

  // Generate with selected writer
  const body = await generateWithWriter(writer, "", prompt + writingRules);

  // Extract title
  let title = idea.title;
  if (hasOutline && idea.outline) {
    const titleMatch = idea.outline.match(/タイトル[：:]\s*(.+)/);
    if (titleMatch) title = titleMatch[1].trim();
  }

  // Extract tags from outline if available
  let tags: string[] = [];
  if (hasOutline && idea.outline) {
    const tagsMatch = idea.outline.match(/タグ[：:]\s*(.+)/);
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split(/[,、\s]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter((t) => t.length > 0)
        .slice(0, 5);
    }
  }
  if (tags.length === 0) {
    tags = [idea.topic];
  }

  // Process diagrams (SVG → PNG → upload → replace in body)
  let finalBody = await processBodyDiagrams(body);

  // Generate and prepend eyecatch image
  const eyecatchUrl = await generateAndUploadEyecatch(title, idea.topic);
  if (eyecatchUrl) {
    finalBody = `![${title}](${eyecatchUrl})\n\n${finalBody}`;
    log("INFO", `Eyecatch added to article: ${eyecatchUrl}`);
  }

  // Build memo for PixBlog (non-public metadata)
  const memo = `writer: ${writer.id} / model: ${writer.model} / style: ${writer.style} / source: ${idea.source ?? "rss"}`;

  // Post to PixBlog as draft
  const post = await createPost({
    title,
    body: finalBody,
    content_format: "markdown",
    tags,
    status: "draft",
    memo,
  });

  log("INFO", `Draft posted: id=${post.id} title="${title}" writer=${writer.id}`);

  // Update idea phase and link postId
  state.ideas[ideaIndex] = {
    ...idea,
    phase: "drafted",
    postId: post.id,
    updatedAt: new Date().toISOString(),
  };
  saveIdeas(state.ideas);

  // Add to articles with writer metadata
  const today = jstToday();
  state.articles.push({
    postId: post.id,
    title,
    status: "draft",
    phase: "drafted",
    ideaIndex,
    writer: writer.id,
    writerModel: writer.model,
    writerStyle: writer.style,
    publishedAt: null,
    pvHistory: [{ date: today, count: 0 }],
  });
  saveArticles(state.articles);

  return {
    success: true,
    summary: `記事「${title}」をdraftとして投稿完了 (post_id=${post.id}, writer=${writer.id})。次のサイクルでreview可能。`,
  };
}
