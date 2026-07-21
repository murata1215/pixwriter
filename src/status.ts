import fs from "node:fs";
import {
  HALT_FILE,
  ARTICLES_FILE,
  IDEAS_FILE,
  JOURNAL_FILE,
  STATE_DIR,
} from "./config.js";
import { loadBudget } from "./budget.js";
import { initializeState, todayPublishCount } from "./state.js";
import { MAX_PUBLISHES_PER_DAY } from "./config.js";
import type { Article } from "./state.js";
import type { Idea } from "./state.js";

function main(): void {
  initializeState();

  console.log("=== PixWriter Status ===\n");

  // HALT check
  const halted = fs.existsSync(HALT_FILE);
  console.log(`HALT: ${halted ? "YES — エージェント停止中 (state/HALTを削除して再開)" : "No"}`);

  // Budget
  const budget = loadBudget();
  console.log(
    `予算: $${budget.estimatedCostUsd.toFixed(2)} / $20.00 (${budget.month})`
  );
  console.log(
    `  トークン: input=${budget.inputTokens.toLocaleString()} output=${budget.outputTokens.toLocaleString()}`
  );

  // Articles
  let articles: Article[] = [];
  try {
    articles = JSON.parse(fs.readFileSync(ARTICLES_FILE, "utf-8"));
  } catch {}

  const published = articles.filter((a) => a.phase === "published");
  const removed = articles.filter((a) => a.phase === "removed");
  const active = articles.filter((a) => a.phase !== "removed");
  const drafts = active.filter((a) => a.phase !== "published");
  console.log(`\n記事: ${active.length}件 (公開=${published.length}, draft=${drafts.length}${removed.length > 0 ? `, removed=${removed.length}` : ""})`);
  const todayCount = todayPublishCount(articles);
  console.log(`本日公開: ${todayCount}/${MAX_PUBLISHES_PER_DAY}本`);

  if (articles.length > 0) {
    console.log("\n記事一覧:");
    for (const a of articles) {
      const latestPv = a.pvHistory[a.pvHistory.length - 1];
      console.log(
        `  [${a.phase}] id=${a.postId} 「${a.title}」 ${latestPv?.count ?? 0}PV`
      );
    }
  }

  // Ideas
  let ideas: Idea[] = [];
  try {
    ideas = JSON.parse(fs.readFileSync(IDEAS_FILE, "utf-8"));
  } catch {}
  console.log(`\nアイデア: ${ideas.length}件`);
  const phases = ["idea", "outlined", "drafted", "reviewed", "published"] as const;
  for (const phase of phases) {
    const count = ideas.filter((i) => i.phase === phase).length;
    if (count > 0) console.log(`  ${phase}: ${count}`);
  }

  // Consecutive errors
  let errCount = 0;
  try {
    errCount = parseInt(
      fs.readFileSync(`${STATE_DIR}/.error_count`, "utf-8").trim(),
      10
    ) || 0;
  } catch {}
  if (errCount > 0) {
    console.log(`\n連続エラー: ${errCount}回`);
  }

  // Recent journal
  try {
    const journal = fs.readFileSync(JOURNAL_FILE, "utf-8");
    const entries = journal.split(/(?=^## \d{4}-)/m).filter((e) => e.trim());
    const recent = entries.slice(-3);
    if (recent.length > 0) {
      console.log("\n直近の活動:");
      for (const entry of recent) {
        console.log(
          "  " + entry.trim().split("\n").slice(0, 2).join(" / ")
        );
      }
    }
  } catch {}

  console.log("");
}

main();
