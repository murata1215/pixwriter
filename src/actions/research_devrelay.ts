import type { AppState, Idea } from "../state.js";
import { saveIdeas } from "../state.js";
import { generateContent } from "../claude-api.js";
import { initSession, listProjects, searchContext } from "../devrelay-mcp.js";
import { sanitize, sanitizeObject } from "../sanitize.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

// Projects likely to have interesting dev content for blog posts
const PRIORITY_PROJECT_NAMES = [
  "ClockWise",
  "Fukeisan",
  "PastScene",
  "Running",
  "mimamori-flutter",
  "pixblog",
  "pixdraft",
  "pixshelf",
  "pixnews",
  "pixmanual",
  "devrelay",
  "collector",
  "freeaddress",
  "arcutil",
  "mailsync",
  "devrelay_flutter",
  "pixterm",
  "freeterm",
];

export async function executeResearchDevrelay(
  state: AppState,
  input: Record<string, unknown>
): Promise<ActionResult> {
  const topic = (input.topic as string) || "最近の実装・バグ修正・設計判断";

  // 1. Initialize MCP session
  const session = await initSession();

  // 2. List projects and filter
  const allProjects = await listProjects(session);
  const onlineProjects = allProjects.filter((p) => p.online);

  // Prioritize known interesting projects, pick up to 5
  const prioritized = onlineProjects.filter((p) =>
    PRIORITY_PROJECT_NAMES.some((name) =>
      p.name.toLowerCase() === name.toLowerCase()
    )
  );

  // Deduplicate by project name (same project can exist on multiple machines)
  const seen = new Set<string>();
  const uniqueProjects = prioritized.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const selectedProjects = uniqueProjects.slice(0, 5);

  if (selectedProjects.length === 0) {
    return {
      success: true,
      summary: "DevRelay: オンラインの対象プロジェクトが見つからなかった。",
    };
  }

  log(
    "INFO",
    `DevRelay: searching ${selectedProjects.length} projects: ${selectedProjects.map((p) => p.name).join(", ")}`
  );

  // 3. Search context for each project
  const contextEntries: string[] = [];

  for (const project of selectedProjects) {
    try {
      const result = await searchContext(session, project.id, topic);
      if (result && result !== "(検索結果なし)") {
        // Sanitize immediately after retrieval
        const sanitizedResult = sanitize(result);
        // Truncate to avoid huge prompts
        const truncated = sanitizedResult.slice(0, 3000);
        contextEntries.push(
          `### プロジェクト: ${project.name}\n${truncated}`
        );
      }
    } catch (err) {
      log("WARN", `DevRelay: failed to search ${project.name}: ${err}`);
    }
  }

  if (contextEntries.length === 0) {
    return {
      success: true,
      summary: `DevRelay: 検索テーマ「${topic}」で活動ログが見つからなかった。`,
    };
  }

  // 4. Ask Claude to extract blog ideas
  const existingTitles = state.ideas.map((i) => i.title).join("\n");

  const prompt = `以下は個人開発プロジェクトの開発活動ログ（会話履歴・ビルドサマリ）です。
この中から「ブログ記事になりそうな出来事・学び・ハマりどころ」を最大3件抽出してください。

検索テーマ: ${topic}

既存のアイデア（重複を避けること）:
${existingTitles || "(なし)"}

開発活動ログ:
${contextEntries.join("\n\n")}

以下のJSON配列形式で返してください（他の文章は不要）:
[
  {
    "title": "記事タイトル案（読者が読みたくなるもの）",
    "topic": "カテゴリ（例: Flutter, AI活用, サーバー運用, 個人開発）",
    "notes": "記事で書く内容の要点メモ（3行程度）。技術的な学びと一般化した知見に焦点を当てる"
  }
]

重要:
- 既存アイデアと重複するものは除外
- 認証情報・サーバーIP・内部ホスト名・具体的なID類・所属組織に関する情報は含めない
- 技術的な学びと一般化した知見のみを扱う
- 開発ログの内容をそのまま転載せず、読者向けに一般化したテーマにする
- 得意分野（プログラミング、Flutter、AI活用、個人開発、Linux/サーバー運用）に関連するものを優先`;

  const result = await generateContent(
    "あなたはブログのネタ出しアシスタントです。開発活動ログから記事ネタを抽出します。JSON配列のみを返してください。",
    prompt,
    2048
  );

  // 5. Parse ideas from response
  let newIdeas: Array<{
    title: string;
    topic: string;
    notes: string;
  }> = [];

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      newIdeas = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `DevRelay: failed to parse ideas from Claude response: ${err}`);
    return {
      success: false,
      summary: `DevRelay: アイデア抽出のレスポンスパースに失敗。テーマ: ${topic}`,
    };
  }

  if (newIdeas.length === 0) {
    return {
      success: true,
      summary: `DevRelay: テーマ「${topic}」で記事ネタが見つからなかった。`,
    };
  }

  // 6. Sanitize and save
  const now = new Date().toISOString();
  const ideasToAdd: Idea[] = newIdeas.map((i) => {
    const sanitized = sanitizeObject(i);
    return {
      title: sanitized.title,
      topic: sanitized.topic,
      notes: sanitized.notes,
      source: "devrelay" as const,
      phase: "idea" as const,
      createdAt: now,
      updatedAt: now,
    };
  });

  const updatedIdeas = [...state.ideas, ...ideasToAdd];
  saveIdeas(updatedIdeas);

  const titles = ideasToAdd.map((i) => i.title).join(", ");
  return {
    success: true,
    summary: `DevRelay: テーマ「${topic}」でリサーチ完了。${ideasToAdd.length}件のアイデアを追加: ${titles}`,
  };
}
