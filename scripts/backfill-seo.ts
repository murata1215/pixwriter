/**
 * One-shot SEO backfill for already-published posts: generate a meta-description
 * (`excerpt`) for posts that don't have one.
 *
 * Why excerpt-only for existing posts:
 *  - The PixBlog API stores the body as rendered HTML and REJECTS body updates
 *    sent with `content_format: "html"` (returns 400). The original Markdown is
 *    not retained, so the leading eyecatch image embedded in old bodies cannot
 *    be stripped via the API.
 *  - Those old posts already embed their eyecatch as the first body image, which
 *    PixBlog uses as the OGP/thumbnail fallback. Setting `featured_media_url` on
 *    them ADDS a second, auto-rendered hero image → duplicate top image. So we
 *    do NOT set featured_media_url on existing HTML-body posts.
 *  - Going forward, new posts are created with NO body image + featured_media_url
 *    (see write.ts/showcase.ts/series_write.ts), which is the clean, non-dup path.
 *
 * `excerpt` is a pure win: it replaces the auto-generated "first 160 chars of
 * body" meta description with a crafted, click-worthy snippet.
 *
 * Usage (env must be sourced first):
 *   set -a && . /home/pixwriter/.pixblog-agent.env && set +a
 *   npx tsx scripts/backfill-seo.ts            # dry-run (default, no writes)
 *   npx tsx scripts/backfill-seo.ts --apply    # apply changes
 *
 * Migration tool, run manually. NOT part of the 15-min cycle.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getPosts, getPost, updatePost } from "../src/pixblog-api.js";
import { ANTHROPIC_API_KEY } from "../src/config.js";

const APPLY = process.argv.includes("--apply");
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function genExcerpt(title: string, text: string): Promise<string> {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system:
      "あなたはSEO編集者です。検索結果に表示されるmeta description(スニペット)を日本語で作ります。",
    messages: [
      {
        role: "user",
        content: `次の記事の検索スニペット(meta description)を100〜160字で1つ作ってください。
- 記事の具体的な価値・結論・対象読者が伝わるようにする
- 「〜について解説します」型、「いかがでしたか」等の定型句は禁止
- 記事を読みたくなる具体的な内容にする
- 出力は説明文の本文のみ(ラベル・カギ括弧・前置き不要)

タイトル: ${title}
本文抜粋: ${text.slice(0, 1800)}`,
      },
    ],
  });
  const b = resp.content.find((x) => x.type === "text");
  const raw = b && b.type === "text" ? b.text : "";
  return raw.trim().replace(/^["「『]/, "").replace(/["」』]$/, "").trim();
}

async function main() {
  console.log(`=== SEO excerpt backfill (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);
  const posts = await getPosts();
  const published = posts.filter((p) => p.status === "published");
  console.log(`published posts: ${published.length}\n`);

  let added = 0;
  let skipped = 0;

  for (const p of published) {
    const detail = await getPost(p.id);
    if (detail.excerpt && detail.excerpt.trim().length > 0) {
      console.log(`- [${p.id}] ${detail.title.slice(0, 30)} : excerpt既存、スキップ`);
      skipped++;
      continue;
    }

    const text = htmlToText(detail.content || "");
    const excerpt = await genExcerpt(detail.title, text);
    if (excerpt.length < 40) {
      console.log(`- [${p.id}] ${detail.title.slice(0, 30)} : 生成失敗(短すぎ)、スキップ`);
      continue;
    }

    console.log(`- [${p.id}] ${detail.title.slice(0, 30)}\n    excerpt(${excerpt.length}字)="${excerpt.slice(0, 50)}…"`);
    if (APPLY) {
      await updatePost(p.id, { excerpt });
      console.log(`    -> PATCHED`);
      added++;
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`excerpt ${APPLY ? "generated" : "planned"}: ${APPLY ? added : published.length - skipped}`);
  console.log(`skipped (既にexcertあり): ${skipped}`);
  if (!APPLY) console.log(`\n(dry-run。適用するには --apply を付けて再実行)`);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
