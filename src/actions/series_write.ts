import type { AppState } from "../state.js";
import { saveArticles, jstToday, loadQuality } from "../state.js";
import { loadSeries, saveSeries, getNextPlannedEpisode, getPreviousEpisodePostId } from "../series.js";
import { createPost } from "../pixblog-api.js";
import { generateAndUploadEyecatch, processBodyDiagrams } from "../image-gen.js";
import { uploadImage } from "../pixblog-api.js";
import { generateWithWriter, WRITERS } from "../writers.js";
import { checkImageSafety } from "../claude-api.js";
import { initSession, getConversationHistory, getAttachment } from "../devrelay-mcp.js";
import { sanitize } from "../sanitize.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

export async function executeSeriesWrite(
  state: AppState,
  _input: Record<string, unknown>
): Promise<ActionResult> {
  const seriesList = loadSeries();
  const next = getNextPlannedEpisode(seriesList);

  if (!next) {
    return {
      success: true,
      summary: "連載の未執筆エピソードがありません。series_planで新しい連載を企画してください。",
    };
  }

  const { series, episode } = next;

  // Get fixed writer for this series
  const writer = WRITERS.find((w) => w.id === series.writer) ?? WRITERS[0];

  log("INFO", `Series write: "${series.title}" #${episode.n} "${episode.theme}" (writer=${writer.id})`);

  // 1. Fetch conversation history for the episode period
  const session = await initSession();
  let conversationText = "";
  const safeImageUrls: string[] = [];

  try {
    const result = await getConversationHistory(session, series.projectId, {
      limit: 200,
      after: episode.periodFrom,
      before: episode.periodTo,
      order: "asc",
    });

    // Collect image attachment candidates
    const imageAttachments: Array<{ id: string; filename: string; mimeType: string; msgTimestamp: string }> = [];

    for (const msg of result.messages) {
      for (const att of msg.attachments) {
        if (att.mimeType.startsWith("image/") && imageAttachments.length < 5) {
          imageAttachments.push({
            id: att.id,
            filename: att.filename,
            mimeType: att.mimeType,
            msgTimestamp: msg.timestamp,
          });
        }
      }
    }

    // Build conversation summary (sanitized, truncated)
    conversationText = result.messages
      .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.role}: ${sanitize(m.content.slice(0, 300))}`)
      .join("\n")
      .slice(0, 8000);

    log("INFO", `Fetched ${result.messages.length} messages, ${imageAttachments.length} image candidates`);

    // 2. Vision check images (max 2)

    for (const att of imageAttachments.slice(0, 2)) {
      try {
        const imageBuffer = await getAttachment(session, att.id);
        if (!imageBuffer) {
          log("WARN", `Could not get attachment ${att.id}`);
          continue;
        }

        const base64 = imageBuffer.toString("base64");
        const safetyResult = await checkImageSafety(base64, att.mimeType);

        if (safetyResult.safe) {
          // Upload to PixBlog
          const uploadResult = await uploadImage(imageBuffer, `series-${att.filename}`, att.mimeType);
          safeImageUrls.push(uploadResult.url);
          log("INFO", `Image ${att.filename} passed safety check and uploaded: ${uploadResult.url}`);
        } else {
          log("INFO", `Image ${att.filename} failed safety check: ${safetyResult.reason}`);
        }
      } catch (err) {
        log("WARN", `Failed to process image ${att.id}: ${err}`);
      }
    }

    log("INFO", `${safeImageUrls.length} images passed safety check`);
  } catch (err) {
    log("WARN", `Failed to fetch conversation for series episode: ${err}. Proceeding without conversation.`);
  }

  // 3. Get previous episode link
  const prevPostId = getPreviousEpisodePostId(series, episode.n);
  const prevArticle = prevPostId ? state.articles.find((a) => a.postId === prevPostId) : null;
  const prevLink = prevArticle ? `\n\n前回: [${prevArticle.title}](https://pixblog.net/u/fwjg2507/${prevPostId})` : "";

  // 4. Generate article body
  const prompt = `以下の開発プロジェクトの会話履歴を基に、連載記事の第${episode.n}回を執筆してください。

連載タイトル: ${series.title}
プロジェクト名: ${series.projectName}
エピソード: 第${episode.n}回「${episode.theme}」
期間: ${episode.periodFrom} 〜 ${episode.periodTo}

会話履歴（サニタイズ済み・要約）:
${conversationText || "(会話データなし。テーマに基づいて一般的な開発記を書いてください)"}

執筆ルール:
- 一人称（「私が〜」「このプロジェクトでは〜」）で開発記として書く
- 会話の生ログは引用せず、出来事と学びを地の文で再構成する
- Markdown形式（H2, H3見出し、コードブロック、リスト等）
- 最初の行にH1タイトルは不要（PixBlogが自動付与）
- 1500-3000文字程度
- 連載の流れを意識し、前回の内容を軽く振り返ってから本題に入る
- 認証情報・サーバーIP・内部ホスト名・具体的なID類は記事に書かない
- 本文中に図解が効果的な箇所があればSVGを <svg>...</svg> で埋め込む（最大1点）
- 最後にまとめと次回予告を入れる`;

  const quality = loadQuality();
  const body = await generateWithWriter(
    writer,
    `開発プロジェクトの連載記事を書いてください。\n\n以下は「読ませる記事」の品質基準です。必ず守ってください（会話履歴にある実際のコード・エラー・数値・具体的な出来事を一次情報として最低3つ盛り込む）。\n\n${quality}`,
    prompt
  );

  // 5. Process diagrams
  let finalBody = await processBodyDiagrams(body);

  // Insert safe images into body if any
  if (safeImageUrls.length > 0) {
    const imageMarkdown = safeImageUrls
      .map((url, i) => `\n\n![開発当時のスクリーンショット ${i + 1}](${url})\n*開発当時のスクリーンショット*\n`)
      .join("");
    // Insert after first H2
    const h2Match = finalBody.match(/\n## /);
    if (h2Match && h2Match.index !== undefined) {
      const nextH2 = finalBody.indexOf("\n## ", h2Match.index + 1);
      const insertPos = nextH2 > 0 ? nextH2 : finalBody.length;
      finalBody = finalBody.slice(0, insertPos) + imageMarkdown + finalBody.slice(insertPos);
    } else {
      finalBody += imageMarkdown;
    }
  }

  // Add previous episode link
  if (prevLink) {
    finalBody = prevLink + "\n\n---\n\n" + finalBody;
  }

  // 6. Eyecatch
  const title = `${series.title} 第${episode.n}回――${episode.theme}`;
  const eyecatchUrl = await generateAndUploadEyecatch(title, `${series.projectName} development`);
  if (eyecatchUrl) {
    finalBody = `![${title}](${eyecatchUrl})\n\n${finalBody}`;
  }

  // 7. Post to PixBlog
  const tags = ["連載", series.projectName, "個人開発"];
  const memo = `writer: ${writer.id} / model: ${writer.model} / style: ${writer.style} / source: series / series: ${series.title} #${episode.n}`;

  const post = await createPost({
    title,
    body: finalBody,
    content_format: "markdown",
    tags,
    status: "draft",
    memo,
  });

  log("INFO", `Series episode posted: id=${post.id} series="${series.title}" #${episode.n}`);

  // 8. Update series.json
  episode.status = "written";
  episode.postId = post.id;
  saveSeries(seriesList);

  // 9. Update articles.json
  const today = jstToday();
  state.articles.push({
    postId: post.id,
    title,
    status: "draft",
    phase: "drafted",
    source: "write",
    writer: writer.id,
    writerModel: writer.model,
    writerStyle: writer.style,
    publishedAt: null,
    pvHistory: [{ date: today, count: 0 }],
  });
  saveArticles(state.articles);

  return {
    success: true,
    summary: `連載「${series.title}」第${episode.n}回「${episode.theme}」をdraftとして投稿完了 (post_id=${post.id}, writer=${writer.id})。`,
  };
}
