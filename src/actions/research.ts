import RssParser from "rss-parser";
import type { AppState, Idea } from "../state.js";
import { saveIdeas } from "../state.js";
import { generateContent } from "../claude-api.js";
import { RSS_FEEDS } from "../config.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

const parser = new RssParser();

interface FeedItem {
  title: string;
  link: string;
  contentSnippet?: string;
}

async function fetchFeeds(topic: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        items.push({
          title: item.title ?? "",
          link: item.link ?? "",
          contentSnippet: (item.contentSnippet ?? "").slice(0, 200),
        });
      }
    } catch (err) {
      log("WARN", `Failed to fetch RSS: ${feedUrl} - ${err}`);
    }
  }

  return items;
}

export async function executeResearch(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const topic = (input.topic as string) || "プログラミング・AI・個人開発";

  // Fetch RSS feeds
  const feedItems = await fetchFeeds(topic);
  log("INFO", `Fetched ${feedItems.length} RSS items`);

  if (feedItems.length === 0) {
    return {
      success: true,
      summary: `RSSフィードの取得に失敗。次回リトライ。テーマ: ${topic}`,
    };
  }

  // Ask Claude to extract relevant ideas
  const existingTitles = state.ideas.map((i) => i.title).join("\n");

  // Genre distribution for rotation
  const genreCounts = new Map<string, number>();
  for (const idea of state.ideas) {
    const genre = idea.topic.split(/[\/・]/)[0].trim();
    genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
  }
  for (const article of state.articles) {
    if (article.phase !== "removed") {
      const genre = article.title.includes("Flutter") ? "Flutter" :
                    article.title.includes("C#") ? "C#" :
                    article.title.includes("Android") ? "Android" :
                    article.title.includes("GitHub") ? "GitHub" : "その他";
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  const genreDistribution = Array.from(genreCounts.entries())
    .map(([g, c]) => `${g}: ${c}件`)
    .join(", ");

  const prompt = `以下のRSSフィード記事一覧から、「${topic}」に関連する記事ネタ候補を最大3つ抽出してください。

既存のアイデア（重複を避けること）:
${existingTitles || "(なし)"}

現在のジャンル分布（偏りを避けて幅広く巡回すること）:
${genreDistribution || "(なし)"}
得意分野: プログラミング、Flutter、AI活用、個人開発、Linux/サーバー運用

RSSフィード記事:
${feedItems.map((i) => `- ${i.title} (${i.link})\n  ${i.contentSnippet}`).join("\n")}

以下のJSON配列形式で返してください（他の文章は不要）:
[
  {
    "title": "記事タイトル案",
    "topic": "カテゴリ",
    "sourceUrl": "参考URL",
    "notes": "自分の言葉で書くための要点メモ（3行程度）"
  }
]

重要:
- 既存アイデアと重複するものは除外
- 元記事の転載ではなく、自分の視点で書けるテーマにする
- 得意分野（プログラミング、Flutter、AI活用、個人開発、Linux/サーバー運用）に関連するものを優先`;

  const result = await generateContent(
    "あなたはブログのネタ出しアシスタントです。JSON配列のみを返してください。",
    prompt,
    2048
  );

  // Parse ideas from response
  let newIdeas: Array<{
    title: string;
    topic: string;
    sourceUrl?: string;
    notes: string;
  }> = [];

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      newIdeas = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse ideas from Claude response: ${err}`);
    return {
      success: false,
      summary: `アイデア抽出のレスポンスパースに失敗。テーマ: ${topic}`,
    };
  }

  if (newIdeas.length === 0) {
    return {
      success: true,
      summary: `テーマ「${topic}」で関連するネタが見つからなかった。`,
    };
  }

  // Add to ideas
  const now = new Date().toISOString();
  const ideasToAdd: Idea[] = newIdeas.map((i) => ({
    title: i.title,
    topic: i.topic,
    sourceUrl: i.sourceUrl,
    notes: i.notes,
    phase: "idea" as const,
    createdAt: now,
    updatedAt: now,
  }));

  const updatedIdeas = [...state.ideas, ...ideasToAdd];
  saveIdeas(updatedIdeas);

  const titles = ideasToAdd.map((i) => i.title).join(", ");
  return {
    success: true,
    summary: `テーマ「${topic}」でリサーチ完了。${ideasToAdd.length}件のアイデアを追加: ${titles}`,
  };
}
