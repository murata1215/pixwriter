import type { AppState } from "../state.js";
import { saveArticles, jstToday, loadQuality } from "../state.js";
import { createPost } from "../pixblog-api.js";
import { generateAndUploadEyecatch, processBodyDiagrams } from "../image-gen.js";
import { selectWriter, generateWithWriter } from "../writers.js";
import { generateContent } from "../claude-api.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

const GITHUB_USER = "murata1215";

interface GitHubRepo {
  name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  fork: boolean;
}

async function fetchRepos(): Promise<GitHubRepo[]> {
  const url = `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=updated`;
  log("INFO", `GitHub API: GET ${url}`);
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  const repos = (await res.json()) as GitHubRepo[];
  return repos.filter((r) => !r.fork);
}

async function fetchReadme(repoName: string): Promise<string> {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repoName}/readme`;
  log("INFO", `GitHub API: GET README for ${repoName}`);
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) {
    return "(READMEなし)";
  }
  const text = await res.text();
  return text.slice(0, 5000);
}

export async function executeShowcase(
  state: AppState,
  _input: Record<string, unknown>
): Promise<ActionResult> {
  const repos = await fetchRepos();
  log("INFO", `GitHub: ${repos.length} repos found for ${GITHUB_USER}`);

  if (repos.length === 0) {
    return { success: true, summary: "公開リポジトリが見つかりませんでした。" };
  }

  const showcasedRepos = new Set(
    state.articles
      .filter((a) => a.repoName && a.phase !== "removed")
      .map((a) => a.repoName!)
  );

  const unshowcased = repos.filter((r) => !showcasedRepos.has(r.name));

  if (unshowcased.length === 0) {
    return {
      success: true,
      summary: "全ての公開リポジトリが紹介済みです。",
    };
  }

  const repo = unshowcased[0];
  log("INFO", `Showcase target: ${repo.name} (${repo.language || "unknown"})`);

  const readme = await fetchReadme(repo.name);

  // Select writer for showcase (medium weight)
  const writer = selectWriter(state, "medium");

  const prompt = `以下の公開リポジトリについて、プロダクト紹介記事をMarkdown形式で執筆してください。

リポジトリ名: ${repo.name}
GitHub URL: ${repo.html_url}
説明: ${repo.description || "(なし)"}
言語: ${repo.language || "不明"}
トピック: ${repo.topics.length > 0 ? repo.topics.join(", ") : "(なし)"}

README:
${readme}

執筆ルール:
- 一人称（「私が開発した〜」「作った動機は〜」）で書く
- 以下の要素を必ず含める:
  1. 何を作ったか（プロダクト名を明示）
  2. なぜ作ったか（動機・解決したかった課題）
  3. 主な特徴・機能
  4. 技術スタック
  5. 使い方の概要
  6. GitHubリポジトリへのリンク（必須: ${repo.html_url}）
- Markdown形式（H2, H3見出し、コードブロック、リスト等を適切に使用）
- 最初の行にH1タイトルは不要（PixBlogが自動付与）
- 読みやすい分量（1500-3000文字程度）
- 最後にまとめセクションを入れる
- 本文中に図解が1つあると効果的な箇所があれば、SVGコードを <svg>...</svg> タグで埋め込む（最大1点）`;

  // Generate body with selected writer (quality standard injected)
  const quality = loadQuality();
  const body = await generateWithWriter(
    writer,
    `自作プロダクトを一人称で紹介する記事を書いてください。\n\n以下は「読ませる記事」の品質基準です。必ず守ってください。\n\n${quality}`,
    prompt
  );

  // Generate title (always via Claude for consistency)
  const titlePrompt = `以下のリポジトリの紹介記事タイトルを1つだけ提案してください。タイトルのみを返してください。

リポジトリ名: ${repo.name}
説明: ${repo.description || "(なし)"}
言語: ${repo.language || "不明"}

要件:
- SEOを意識した日本語タイトル
- プロダクト名「${repo.name}」を含める
- 「作った」「開発した」等の一人称表現を含めてよい`;

  const titleResult = await generateContent(
    "ブログ記事のタイトルを提案してください。タイトルのみを返してください。",
    titlePrompt,
    100
  );
  const title = titleResult.trim().replace(/^["「]|["」]$/g, "");

  const tags = [
    repo.language || "プログラミング",
    "個人開発",
    ...(repo.topics.length > 0 ? repo.topics.slice(0, 3) : []),
  ].slice(0, 5);

  let finalBody = await processBodyDiagrams(body);

  const topic = `${repo.name} - ${repo.language || "programming"} project`;
  const eyecatchUrl = await generateAndUploadEyecatch(title, topic);
  if (eyecatchUrl) {
    finalBody = `![${title}](${eyecatchUrl})\n\n${finalBody}`;
    log("INFO", `Eyecatch added to showcase article: ${eyecatchUrl}`);
  }

  const memo = `writer: ${writer.id} / model: ${writer.model} / style: ${writer.style} / source: showcase / repo: ${repo.name}`;

  const post = await createPost({
    title,
    body: finalBody,
    content_format: "markdown",
    tags,
    status: "draft",
    memo,
  });

  log("INFO", `Showcase draft posted: id=${post.id} repo=${repo.name} title="${title}" writer=${writer.id}`);

  const today = jstToday();
  state.articles.push({
    postId: post.id,
    title,
    status: "draft",
    phase: "drafted",
    source: "showcase",
    repoName: repo.name,
    writer: writer.id,
    writerModel: writer.model,
    writerStyle: writer.style,
    publishedAt: null,
    pvHistory: [{ date: today, count: 0 }],
  });
  saveArticles(state.articles);

  return {
    success: true,
    summary: `プロダクト紹介記事「${title}」(${repo.name})をdraftとして投稿完了 (post_id=${post.id}, writer=${writer.id})。`,
  };
}
