import type { AppState, Idea } from "../state.js";
import { saveIdeas } from "../state.js";
import { generateContent } from "../claude-api.js";
import { initSession, listProjects, searchContext, getConversationHistory } from "../devrelay-mcp.js";
import { sanitize, sanitizeObject } from "../sanitize.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

const PRIORITY_PROJECT_NAMES = [
  "ClockWise", "Fukeisan", "PastScene", "Running",
  "mimamori-flutter", "pixblog", "pixdraft", "pixshelf",
  "pixnews", "pixmanual", "devrelay", "collector",
  "freeaddress", "arcutil", "mailsync", "devrelay_flutter",
  "pixterm", "freeterm", "SendToExtract", "TruckBoard",
];

const TROUBLE_QUERIES = [
  "エラー 原因 解決 修正",
  "error failed fix bug",
];

export async function executeResearchTrouble(
  state: AppState,
  _input: Record<string, unknown>
): Promise<ActionResult> {
  const session = await initSession();
  const allProjects = await listProjects(session);
  const onlineProjects = allProjects.filter((p) => p.online);

  // Deduplicate and filter priority projects
  const seen = new Set<string>();
  const candidates = onlineProjects
    .filter((p) => {
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return PRIORITY_PROJECT_NAMES.some((n) => n.toLowerCase() === key);
    })
    .slice(0, 5);

  if (candidates.length === 0) {
    return { success: true, summary: "オンラインの対象プロジェクトが見つかりませんでした。" };
  }

  log("INFO", `research_trouble: searching ${candidates.length} projects`);

  // Collect trouble candidates from search results
  const troubleCandidates: Array<{
    projectName: string;
    projectId: string;
    summary: string;
    date: string;
  }> = [];

  let mcpCalls = 3; // init + list + first search

  for (const project of candidates) {
    for (const query of TROUBLE_QUERIES) {
      if (mcpCalls >= 18) break; // Reserve calls for conversation fetch
      try {
        const resultText = await searchContext(session, project.id, query);
        mcpCalls++;

        const data = JSON.parse(resultText);
        const results = data.results ?? [];

        for (const r of results) {
          const s = (r.summary ?? "").toLowerCase();
          if (s.includes("エラー") || s.includes("修正") || s.includes("解決") ||
              s.includes("fix") || s.includes("error") || s.includes("bug") ||
              s.includes("バグ") || s.includes("失敗")) {
            troubleCandidates.push({
              projectName: project.name,
              projectId: project.id,
              summary: sanitize(r.summary ?? ""),
              date: r.date ?? "",
            });
          }
        }
      } catch (err) {
        log("WARN", `Failed to search ${project.name}: ${err}`);
      }
    }
  }

  log("INFO", `Found ${troubleCandidates.length} trouble candidates`);

  if (troubleCandidates.length === 0) {
    return {
      success: true,
      summary: "トラブルシュート記事のネタとなるエピソードが見つかりませんでした。",
    };
  }

  // Get conversation context for top 3 candidates
  const detailedCandidates: string[] = [];

  for (const candidate of troubleCandidates.slice(0, 3)) {
    if (mcpCalls >= 20) break;
    try {
      // Fetch conversation around the date
      const result = await getConversationHistory(session, candidate.projectId, {
        limit: 30,
        after: candidate.date.slice(0, 10) + "T00:00",
        order: "asc",
      });
      mcpCalls++;

      const conversationSnippet = result.messages
        .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.role}: ${sanitize(m.content.slice(0, 200))}`)
        .join("\n")
        .slice(0, 3000);

      detailedCandidates.push(
        `### ${candidate.projectName} (${candidate.date.slice(0, 10)})\nビルドサマリ: ${candidate.summary}\n\n会話コンテキスト:\n${conversationSnippet}`
      );
    } catch (err) {
      log("WARN", `Failed to fetch conversation for ${candidate.projectName}: ${err}`);
      detailedCandidates.push(
        `### ${candidate.projectName} (${candidate.date.slice(0, 10)})\nビルドサマリ: ${candidate.summary}\n(会話取得失敗)`
      );
    }
  }

  // Build existing titles for dedup check
  const existingTitles = [
    ...state.ideas.map((i) => i.title),
    ...state.articles.filter((a) => a.phase !== "removed").map((a) => a.title),
  ].join("\n");

  // Ask Claude to extract trouble episodes
  const prompt = `以下の開発プロジェクトのビルドサマリと会話履歴から、「トラブルシュート記事」のネタを最大3件抽出してください。

条件:
- 「症状→試行錯誤→解決」が一式そろったエピソードのみ（未解決で終わっているものは除外）
- エラーメッセージの原文があれば必ず含める（検索キーワードの本体）
- 既存の記事やアイデアと重複するものは除外

既存のタイトル（重複を避けること）:
${existingTitles || "(なし)"}

素材:
${detailedCandidates.join("\n\n")}

以下のJSON配列形式で返してください（他の文章は不要）:
[
  {
    "title": "エラーメッセージや症状をそのまま含むタイトル案（例: 『XXXが出たときの原因と対処』）",
    "topic": "カテゴリ（例: C#, Android, Flutter, サーバー運用）",
    "notes": "以下を含む要点メモ:\n- エラーメッセージ原文（あれば）\n- 症状\n- 環境（言語/FW/OS等）\n- 試して失敗したこと\n- 原因\n- 解決策",
    "projectId": "素材となったprojectId",
    "period": "YYYY-MM-DD"
  }
]

重要:
- 認証情報・サーバーIP・内部ホスト名・具体的なID類は含めない
- 環境は一般化して記述する（例: 「Ubuntu 24.04のVPS」）`;

  const result = await generateContent(
    "あなたはトラブルシュート記事のネタ出しアシスタントです。「詰まり→解決」のエピソードを抽出してください。JSON配列のみを返してください。",
    prompt,
    2048
  );

  // Parse ideas
  let newIdeas: Array<{
    title: string;
    topic: string;
    notes: string;
    projectId?: string;
    period?: string;
  }> = [];

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      newIdeas = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse trouble ideas: ${err}`);
    return { success: false, summary: "トラブルシュートネタのパースに失敗。" };
  }

  if (newIdeas.length === 0) {
    return {
      success: true,
      summary: "トラブルシュート記事のネタが見つかりませんでした（条件を満たすエピソードなし）。",
    };
  }

  // Sanitize and save
  const now = new Date().toISOString();
  const ideasToAdd: Idea[] = newIdeas.map((i) => {
    const sanitized = sanitizeObject(i);
    return {
      title: sanitized.title,
      topic: sanitized.topic,
      notes: sanitized.notes,
      source: "trouble" as const,
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
    summary: `トラブルシュートネタ${ideasToAdd.length}件を発掘: ${titles}`,
  };
}
