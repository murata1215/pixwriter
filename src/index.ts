import fs from "node:fs";
import {
  HALT_FILE,
  CYCLE_TIMEOUT_MS,
  MAX_CONSECUTIVE_ERRORS,
  STATE_DIR,
} from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { log, cleanOldLogs } from "./logger.js";
import { isBudgetExceeded, loadBudget } from "./budget.js";
import {
  loadState,
  initializeState,
  syncArticles,
  repairIdeasForRemovedArticles,
  getAvailableActions,
  getRecentJournal,
  appendJournal,
  saveArticles,
  saveIdeas,
  setConsecutiveErrors,
  shouldFreeIdle,
} from "./state.js";
import { getPosts } from "./pixblog-api.js";
import { decideAction } from "./claude-api.js";
import { dispatch } from "./actions/index.js";

function getActionOverride(): string | null {
  const idx = process.argv.indexOf("--action");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

async function main(): Promise<void> {
  // Set timeout for the entire cycle
  const timer = setTimeout(() => {
    log("ERROR", "Cycle timeout (10 minutes). Force exiting.");
    releaseLock();
    process.exit(1);
  }, CYCLE_TIMEOUT_MS);
  timer.unref(); // Don't keep process alive just for this timer

  try {
    // Initialize state files if needed
    initializeState();

    // Clean old logs
    cleanOldLogs();

    log("INFO", "=== PixWriter cycle start ===");

    // 1. HALT check
    if (fs.existsSync(HALT_FILE)) {
      log("WARN", "HALT file exists. Skipping cycle. Remove HALT to resume.");
      return;
    }

    // 2. Budget check
    if (isBudgetExceeded()) {
      const budget = loadBudget();
      log(
        "WARN",
        `Monthly budget exceeded ($${budget.estimatedCostUsd.toFixed(2)}). Skipping cycle.`
      );
      appendJournal("budget_exceeded", `月間予算超過 ($${budget.estimatedCostUsd.toFixed(2)})。サイクルスキップ。`);
      return;
    }

    // 3. Acquire lock
    if (!acquireLock()) {
      log("WARN", "Lock held by another process. Skipping cycle.");
      return;
    }

    // 4. Load state
    const state = loadState();

    // 5. Sync articles with PixBlog API
    let apiPosts;
    try {
      apiPosts = await getPosts();
      state.articles = syncArticles(state.articles, apiPosts);
      saveArticles(state.articles);
      // Repair ideas linked to removed articles
      if (repairIdeasForRemovedArticles(state.ideas, state.articles)) {
        saveIdeas(state.ideas);
        log("INFO", "Repaired ideas linked to removed articles.");
      }
    } catch (err) {
      log("ERROR", `Failed to fetch posts from PixBlog API: ${err}`);
      state.consecutiveErrors++;
      setConsecutiveErrors(state.consecutiveErrors);

      if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        fs.writeFileSync(HALT_FILE, `HALT: ${MAX_CONSECUTIVE_ERRORS} consecutive API errors at ${new Date().toISOString()}\n`);
        log("ERROR", `${MAX_CONSECUTIVE_ERRORS} consecutive errors. HALT file created.`);
        appendJournal("halt", `${MAX_CONSECUTIVE_ERRORS}回連続エラーによりHALT。`);
      }

      releaseLock();
      return;
    }

    // 5.5. Free idle check (before Claude API call to save budget)
    const actionOverrideEarly = getActionOverride();
    if (!actionOverrideEarly) {
      const freeIdleReason = shouldFreeIdle(state);
      if (freeIdleReason) {
        log("INFO", `skip (free idle): ${freeIdleReason}`);
        releaseLock();
        return; // No Claude API call, no journal entry
      }
    }

    // 6. Determine available actions
    const availableActions = getAvailableActions(state);
    log("INFO", `Available actions: [${availableActions.join(", ")}]`);

    // 7. Build context for Claude
    const recentJournal = getRecentJournal();

    const articlesContext = state.articles
      .map((a) => {
        const latestPv = a.pvHistory[a.pvHistory.length - 1];
        return `  - [${a.phase}] 「${a.title}」(id=${a.postId}, ${latestPv?.count ?? 0}PV)`;
      })
      .join("\n");

    const ideasContext = state.ideas
      .map((idea, i) => `  ${i}: [${idea.phase}] ${idea.title}`)
      .join("\n");

    const budget = loadBudget();

    // Series context
    let seriesContext = "";
    try {
      const fs = await import("node:fs");
      const { SERIES_FILE } = await import("./config.js");
      const seriesRaw = fs.readFileSync(SERIES_FILE, "utf-8");
      const seriesList = JSON.parse(seriesRaw) as Array<{ title: string; projectName: string; writer: string; episodes: Array<{ n: number; theme: string; status: string }> }>;
      if (seriesList.length > 0) {
        seriesContext = seriesList.map((s) => {
          const planned = s.episodes.filter((e) => e.status === "planned").length;
          const written = s.episodes.filter((e) => e.status === "written").length;
          const published = s.episodes.filter((e) => e.status === "published").length;
          return `  - 「${s.title}」(${s.projectName}) writer=${s.writer} planned=${planned} written=${written} published=${published}`;
        }).join("\n");
      }
    } catch {
      // No series yet
    }

    const systemPrompt = `${state.mission}\n\n---\n\n現在の戦略:\n${state.strategy}`;

    const contextMessage = `# 現在の状況

日時: ${new Date().toISOString()}
予算: $${budget.estimatedCostUsd.toFixed(2)} / $20.00 (今月)

## 記事一覧 (${state.articles.length}件)
${articlesContext || "(なし)"}

## アイデア帳 (${state.ideas.length}件)
${ideasContext || "(なし)"}
${seriesContext ? `\n## 連載\n${seriesContext}` : ""}

## 直近の活動記録
${recentJournal || "(初回サイクル)"}

## 利用可能なアクション
${availableActions.join(", ")}

上記の状況を踏まえ、今最も効果的な1つのアクションを選択してください。
記事タイプのバランス: 当面はトラブルシュート型(source: trouble)を公開記事の約半分を目安に主力とする。残りを技術知見・showcase・連載でバランスする。
research_troubleでネタがなければresearchやresearch_devrelayも併用。
初めてのサイクルの場合はresearchから始めることを推奨します。`;

    // 8. Ask Claude to decide action (or use --action override)
    const actionOverride = getActionOverride();
    let action;

    if (actionOverride && availableActions.includes(actionOverride)) {
      log("INFO", `Action override via CLI: ${actionOverride}`);
      // Build default input based on action type
      const defaultInput: Record<string, unknown> = { topic: "最近の実装・開発体験", focus: "全体傾向", reason: "CLI override" };
      // For write/outline, pick first writable idea
      if (actionOverride === "write" || actionOverride === "outline") {
        const idx = state.ideas.findIndex((i) => (i.phase === "idea" || i.phase === "outlined") && !i.postId);
        defaultInput.idea_index = idx >= 0 ? idx : 0;
      }
      // For review, pick first drafted article
      if (actionOverride === "review") {
        const art = state.articles.find((a) => a.phase === "drafted");
        if (art) defaultInput.post_id = art.postId;
      }
      // For publish, pick first reviewed article
      if (actionOverride === "publish") {
        const art = state.articles.find((a) => a.phase === "reviewed");
        if (art) defaultInput.post_id = art.postId;
      }
      action = { name: actionOverride, input: defaultInput };
    } else if (actionOverride) {
      log("WARN", `Action override "${actionOverride}" not in available actions [${availableActions.join(", ")}]. Falling back to Claude decision.`);
    }

    if (!action) {
    try {
      action = await decideAction(systemPrompt, contextMessage, availableActions);
      log("INFO", `Claude decided: ${action.name} (${JSON.stringify(action.input)})`);
    } catch (err) {
      log("ERROR", `Claude API error during action decision: ${err}`);
      state.consecutiveErrors++;
      setConsecutiveErrors(state.consecutiveErrors);

      if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        fs.writeFileSync(HALT_FILE, `HALT: ${MAX_CONSECUTIVE_ERRORS} consecutive Claude API errors at ${new Date().toISOString()}\n`);
        log("ERROR", `${MAX_CONSECUTIVE_ERRORS} consecutive errors. HALT file created.`);
        appendJournal("halt", `Claude API ${MAX_CONSECUTIVE_ERRORS}回連続エラーによりHALT。`);
      }

      releaseLock();
      return;
    }
    } // end if (!action)

    // 9. Execute action
    let result;
    try {
      result = await dispatch(action, state);
      log("INFO", `Action result: success=${result.success} — ${result.summary}`);
    } catch (err) {
      log("ERROR", `Action execution error: ${err}`);
      result = { success: false, summary: `実行エラー: ${err}` };
    }

    // 10. Update state
    if (result.success) {
      setConsecutiveErrors(0);
    } else {
      state.consecutiveErrors++;
      setConsecutiveErrors(state.consecutiveErrors);

      if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        fs.writeFileSync(HALT_FILE, `HALT: ${MAX_CONSECUTIVE_ERRORS} consecutive errors at ${new Date().toISOString()}\n`);
        log("ERROR", `${MAX_CONSECUTIVE_ERRORS} consecutive errors. HALT file created.`);
      }
    }

    // 11. Journal entry
    appendJournal(action.name, result.summary);

    log("INFO", "=== PixWriter cycle end ===");
  } catch (err) {
    log("ERROR", `Unexpected error: ${err}`);
    appendJournal("error", `予期しないエラー: ${err}`);
  } finally {
    clearTimeout(timer);
    releaseLock();
  }
}

main().catch((err) => {
  log("ERROR", `Fatal error: ${err}`);
  releaseLock();
  process.exit(1);
});
