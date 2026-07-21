import type { AppState } from "../state.js";
import { loadSeries, saveSeries, type Series } from "../series.js";
import { generateContent } from "../claude-api.js";
import { initSession, listProjects, getConversationHistory, searchContext } from "../devrelay-mcp.js";
import type { McpMessage } from "../devrelay-mcp.js";
import { selectWriter } from "../writers.js";
import { sanitize } from "../sanitize.js";
import { log } from "../logger.js";
import type { ActionResult } from "./index.js";

function formatMessages(msgs: McpMessage[]): string {
  return msgs
    .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.role}: ${sanitize(m.content.slice(0, 200))}`)
    .join("\n");
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.max(0, Math.round(Math.abs(db - da) / (24 * 60 * 60 * 1000)));
}

export async function executeSeriesPlan(
  state: AppState,
  _input: Record<string, unknown>
): Promise<ActionResult> {
  const seriesList = loadSeries();
  const existingProjectIds = new Set(seriesList.map((s) => s.projectId));

  // 1. Find a project with conversation history
  const session = await initSession();
  const allProjects = await listProjects(session);
  const onlineProjects = allProjects.filter((p) => p.online && !existingProjectIds.has(p.id));

  // Deduplicate by name
  const seen = new Set<string>();
  const uniqueProjects = onlineProjects.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let selectedProject = null;
  for (const project of uniqueProjects.slice(0, 10)) {
    try {
      const result = await getConversationHistory(session, project.id, { limit: 1, order: "desc" });
      if (result.messages.length > 0 && result.hasMore) {
        selectedProject = project;
        log("INFO", `Series plan: selected project "${project.name}" (has conversation history)`);
        break;
      }
    } catch (err) {
      log("WARN", `Failed to check conversation for ${project.name}: ${err}`);
    }
  }

  if (!selectedProject) {
    return {
      success: true,
      summary: "連載に適したプロジェクト（十分な会話履歴あり）が見つかりませんでした。",
    };
  }

  // 2. Full-range sampling: first + last + middle + build summary
  const firstBatch = await getConversationHistory(session, selectedProject.id, { limit: 50, order: "asc" });
  const lastBatch = await getConversationHistory(session, selectedProject.id, { limit: 50, order: "desc" });

  const firstDate = firstBatch.messages[0]?.timestamp ?? "";
  const lastDate = lastBatch.messages[0]?.timestamp ?? "";
  const firstMsgCount = firstBatch.messages.length;
  const lastHasMore = lastBatch.hasMore;

  // Estimate total message count
  const totalEstimate = (firstBatch.hasMore || lastHasMore)
    ? Math.max(firstMsgCount * 3, 100) // rough estimate
    : firstMsgCount;

  // Calculate development period in days
  const devDays = firstDate && lastDate ? daysBetween(firstDate, lastDate) : 0;

  // Middle sample if period spans 2+ days
  let middleSummary = "";
  if (devDays >= 2 && firstDate && lastDate) {
    const midDate = new Date((new Date(firstDate).getTime() + new Date(lastDate).getTime()) / 2).toISOString();
    try {
      const midBatch = await getConversationHistory(session, selectedProject.id, {
        limit: 50,
        after: midDate.slice(0, 10),
        order: "asc",
      });
      if (midBatch.messages.length > 0) {
        middleSummary = formatMessages(midBatch.messages);
      }
    } catch (err) {
      log("WARN", `Failed to fetch middle sample: ${err}`);
    }
  }

  // Build summary from search
  let buildSummary = "";
  try {
    buildSummary = sanitize(await searchContext(session, selectedProject.id, "主な機能追加 バグ修正 リリース"));
    buildSummary = buildSummary.slice(0, 2000);
  } catch (err) {
    log("WARN", `Failed to fetch build summary: ${err}`);
  }

  const firstSummary = formatMessages(firstBatch.messages);
  const lastSummary = formatMessages(lastBatch.messages.reverse());

  // Determine episode count guideline
  let episodeGuideline: string;
  if (devDays <= 1 && totalEstimate < 50) {
    episodeGuideline = "1〜2話（素材が少ないため短い連載に）";
  } else if (devDays <= 1) {
    episodeGuideline = "2〜4話（1日の開発だが会話量が多い。同一日内を時間帯で区切ること）";
  } else if (devDays <= 7) {
    episodeGuideline = "2〜5話";
  } else {
    episodeGuideline = "5〜10話";
  }

  // Check existing article titles to avoid overlap
  const existingTitles = state.articles
    .filter((a) => a.phase !== "removed")
    .map((a) => a.title)
    .join("\n");

  // 3. Generate series plan
  const prompt = `以下のプロジェクトの開発会話履歴を基に、ブログ連載の企画書を作成してください。

プロジェクト名: ${selectedProject.name}
開発期間: ${firstDate.slice(0, 10)} 〜 ${lastDate.slice(0, 10)} (${devDays}日間)
推定メッセージ数: ${totalEstimate}以上 (hasMore=${lastHasMore})

=== 初期の会話 ===
${firstSummary}
${middleSummary ? `\n=== 中盤の会話 ===\n${middleSummary}` : ""}

=== 最近の会話 ===
${lastSummary}
${buildSummary ? `\n=== ビルド・リリース情報 ===\n${buildSummary}` : ""}

既に単発記事として公開済みのトピック（連載で重複させないこと）:
${existingTitles || "(なし)"}

以下のJSON形式で連載企画を返してください（他の文章は不要）:
{
  "title": "連載タイトル（例: 〇〇開発記）",
  "episodes": [
    {
      "n": 1,
      "theme": "このエピソードのテーマ（具体的に）",
      "periodFrom": "YYYY-MM-DDTHH:MM",
      "periodTo": "YYYY-MM-DDTHH:MM"
    }
  ]
}

重要な要件:
- 話数: ${episodeGuideline}
- 各話のperiodFrom/periodToは実際の会話タイムスタンプに基づくこと
- 全話が同一のperiodFrom/periodToになるのは不可。日が同じでも時間帯で区切ること
- 既に単発記事化済みのトピックは連載で重複させない
- 1日の出来事を3話以上に分割しないこと
- 読者が興味を持つストーリー性を意識する`;

  const result = await generateContent(
    "あなたはブログ連載の企画者です。素材の実際の厚みに合わせた適切な話数で、開発プロジェクトの歴史を面白い連載に構成してください。",
    prompt,
    2048
  );

  // Parse plan
  let plan: { title: string; episodes: Array<{ n: number; theme: string; periodFrom: string; periodTo: string }> } | null = null;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      plan = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    log("WARN", `Failed to parse series plan: ${err}`);
    return { success: false, summary: "連載企画のパースに失敗。" };
  }

  if (!plan || !plan.episodes || plan.episodes.length === 0) {
    return { success: false, summary: "連載企画の生成に失敗（エピソードなし）。" };
  }

  // Validate: if all episodes have identical period, fix by splitting time ranges
  const allSamePeriod = plan.episodes.every(
    (ep) => ep.periodFrom === plan!.episodes[0].periodFrom && ep.periodTo === plan!.episodes[0].periodTo
  );
  if (allSamePeriod && plan.episodes.length > 1 && firstDate) {
    log("WARN", "All episodes have identical period. Auto-splitting by time ranges.");
    const baseDate = firstDate.slice(0, 10);
    const hoursPerEp = Math.floor(24 / plan.episodes.length);
    for (let i = 0; i < plan.episodes.length; i++) {
      const fromHour = i * hoursPerEp;
      const toHour = (i + 1) * hoursPerEp;
      plan.episodes[i].periodFrom = `${baseDate}T${String(fromHour).padStart(2, "0")}:00`;
      plan.episodes[i].periodTo = `${baseDate}T${String(toHour).padStart(2, "0")}:00`;
    }
  }

  // 4. Select and fix a writer
  const writer = selectWriter(state, "heavy");

  // 5. Save
  const seriesId = `series-${selectedProject.name}-${Date.now()}`;
  const newSeries: Series = {
    seriesId,
    projectId: selectedProject.id,
    projectName: selectedProject.name,
    title: plan.title,
    writer: writer.id,
    episodes: plan.episodes.map((ep) => ({
      n: ep.n,
      theme: ep.theme,
      periodFrom: ep.periodFrom,
      periodTo: ep.periodTo,
      status: "planned" as const,
    })),
    createdAt: new Date().toISOString(),
  };

  seriesList.push(newSeries);
  saveSeries(seriesList);

  const periodInfo = plan.episodes.map((ep) => `#${ep.n}: ${ep.periodFrom}~${ep.periodTo}`).join(", ");
  log("INFO", `Series plan created: "${plan.title}" (${plan.episodes.length} episodes) for ${selectedProject.name}, writer=${writer.id}, periods=[${periodInfo}]`);

  return {
    success: true,
    summary: `連載「${plan.title}」(${plan.episodes.length}話)を企画しました (project=${selectedProject.name}, writer=${writer.id}, ${devDays}日間/${totalEstimate}msg+)。`,
  };
}
