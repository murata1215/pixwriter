/**
 * Automated entry point for data-writer.
 * Called by systemd timer (or manually). Processes the next city in the queue.
 *
 * Usage: npx tsx src/data/run.ts
 */
import fs from "node:fs";
import { log } from "../logger.js";
import { nextCity, getRef, markDone } from "./queue.js";
import { generateCityArticle } from "./citygen.js";
import { end as endDb } from "./db.js";

// ---- Paths ----
const STATE_DIR = "/home/pixwriter/state/data-writer";
const LOCK_FILE = `${STATE_DIR}/.lock`;
const BUDGET_FILE = `${STATE_DIR}/budget.json`;
const JOURNAL_FILE = `${STATE_DIR}/journal.md`;
const OUT_DIR = "/home/pixwriter/out";

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes
const MONTHLY_BUDGET_USD = 5;

// ---- Lock (simplified from src/lock.ts) ----

function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ---- Budget ----

interface DwBudget {
  month: string;
  estimatedCostUsd: number;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function loadDwBudget(): DwBudget {
  const month = currentMonth();
  try {
    const raw = fs.readFileSync(BUDGET_FILE, "utf-8");
    const b: DwBudget = JSON.parse(raw);
    if (b.month !== month) return { month, estimatedCostUsd: 0 };
    return b;
  } catch {
    return { month, estimatedCostUsd: 0 };
  }
}

function saveDwBudget(b: DwBudget): void {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2) + "\n");
}

function recordDwCost(cost: number): void {
  const b = loadDwBudget();
  b.estimatedCostUsd += cost;
  saveDwBudget(b);
}

function isDwBudgetExceeded(): boolean {
  return loadDwBudget().estimatedCostUsd >= MONTHLY_BUDGET_USD;
}

// ---- Journal ----

function appendJournal(entry: string): void {
  fs.appendFileSync(JOURNAL_FILE, entry);
}

// ---- Main ----

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  log("INFO", "[data-run] === Data-writer run start ===");

  // 1. Lock
  if (!acquireLock()) {
    log("WARN", "[data-run] Lock held. Skipping.");
    return;
  }

  try {
    // 2. Budget check
    if (isDwBudgetExceeded()) {
      const b = loadDwBudget();
      log("WARN", `[data-run] Monthly budget exceeded ($${b.estimatedCostUsd.toFixed(2)}/$${MONTHLY_BUDGET_USD}). Skipping.`);
      appendJournal(`\n## ${new Date().toISOString()} — budget_exceeded\n予算超過のためスキップ ($${b.estimatedCostUsd.toFixed(2)}/$${MONTHLY_BUDGET_USD})\n`);
      return;
    }

    // 3. Queue
    const cityId = nextCity();
    if (!cityId) {
      log("INFO", "[data-run] Queue is empty. Nothing to do.");
      appendJournal(`\n## ${new Date().toISOString()} — queue_empty\nキュー空。生成なし。\n`);
      return;
    }

    const refCityId = getRef();
    // Derive slug from city table's country + city id
    const slugMap: Record<string, string> = {
      warsaw: "poland-warsaw",
      bratislava: "slovakia-bratislava",
      sofia: "bulgaria-sofia",
      prague: "czechia-prague",
      budapest: "hungary-budapest",
    };
    const slug = slugMap[cityId] ?? cityId;

    log("INFO", `[data-run] Processing: ${cityId} (ref=${refCityId}, slug=${slug})`);

    const budgetBefore = loadDwBudget().estimatedCostUsd;

    // 4. Generate
    const result = await generateCityArticle({
      cityId,
      refCityId,
      outDir: OUT_DIR,
      post: true,
      slug,
    });

    // Estimate cost from the main budget delta (approximate)
    // The actual cost is recorded in the main budget.json by claude-api.ts.
    // We estimate here: ~$0.06 per article (sonnet in=3300 out=3000)
    const estimatedCost = 0.06;
    recordDwCost(estimatedCost);

    // 5. Success → move to done
    markDone(cityId);

    const journalEntry = `\n## ${new Date().toISOString()} — ${cityId} — success
post_id=${result.postId ?? "?"}, html=${result.htmlPath}
estimated_cost=$${estimatedCost}, budget=$${(budgetBefore + estimatedCost).toFixed(2)}/$${MONTHLY_BUDGET_USD}
`;
    appendJournal(journalEntry);
    log("INFO", `[data-run] Success: ${cityId} → post_id=${result.postId}`);

  } catch (err) {
    log("ERROR", `[data-run] Failed: ${err}`);
    const cityId = nextCity(); // re-read to log which city failed
    appendJournal(`\n## ${new Date().toISOString()} — ${cityId ?? "unknown"} — fail
error: ${String(err).slice(0, 500)}
`);
  } finally {
    await endDb();
    releaseLock();
    log("INFO", "[data-run] === Data-writer run end ===");
  }
}

main().catch((err) => {
  log("ERROR", `[data-run] Fatal: ${err}`);
  releaseLock();
  process.exit(1);
});
