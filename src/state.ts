import fs from "node:fs";
import {
  STATE_DIR,
  MISSION_FILE,
  STRATEGY_FILE,
  IDEAS_FILE,
  ARTICLES_FILE,
  JOURNAL_FILE,
  BUDGET_FILE,
  JOURNAL_PROMPT_ENTRIES,
  DEVRELAY_MCP_TOKEN,
  MAX_PUBLISHES_PER_DAY,
  SERIES_FILE,
  PUBLISH_SLOTS_UTC,
  JST_OFFSET_HOURS,
} from "./config.js";
import type { PixBlogPost } from "./pixblog-api.js";

// ---- JST date helper ----

/** Returns today's date string in JST (YYYY-MM-DD) */
export function jstToday(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** Converts a UTC ISO timestamp to JST date string */
export function toJstDate(utcTimestamp: string): string {
  const d = new Date(utcTimestamp);
  const jst = new Date(d.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ---- Types ----

export interface Idea {
  title: string;
  topic: string;
  sourceUrl?: string;
  notes: string;
  source?: "rss" | "devrelay" | "trouble";
  postId?: number; // Set on successful write, used for dedup
  phase: "idea" | "outlined" | "drafted" | "reviewed" | "published";
  outline?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Article {
  postId: number;
  title: string;
  status: "draft" | "published";
  phase: "drafted" | "reviewed" | "published" | "removed";
  ideaIndex?: number;
  source?: "write" | "showcase";
  repoName?: string; // GitHub repo name for showcase articles
  writer?: string;       // Writer profile id
  writerModel?: string;  // Model used for writing
  writerStyle?: string;  // Writer style description
  publishedAt: string | null;
  pvHistory: { date: string; count: number }[];
}

export interface AppState {
  mission: string;
  strategy: string;
  ideas: Idea[];
  articles: Article[];
  journal: string;
  consecutiveErrors: number;
}

// ---- Initialization ----

const INITIAL_MISSION = `# PixWriter Mission
あなたはPixBlog上で記事を執筆・改善し続ける自律エージェントです。
ゴール: 読者に価値のある記事でPVを伸ばし、ブログとしての収益基盤を作ること。

制約(絶対厳守):
- 公開(publish)は1日3本まで
- 記事は write → review(+publish) の最低2サイクルかける。reviewが通ればそのまま公開される
- 他サイトの文章の転載・翻訳転載は禁止。必ず自分の言葉で書く
- 誇大・虚偽・炎上狙いのコンテンツは禁止
- 事実に自信がない内容は断定せず、出典URLを記事内に明記する
- 得意分野: プログラミング、Flutter、AI活用、個人開発、Linux/サーバー運用のHowTo
`;

const INITIAL_STRATEGY = `# PixWriter Strategy
初回サイクル。まずresearchでネタを収集し、得意分野のテーマを見つけることから始める。
PVデータが溜まったら分析して方針を修正していく。
`;

function ensureFile(path: string, defaultContent: string): void {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, defaultContent);
  }
}

export function initializeState(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  ensureFile(MISSION_FILE, INITIAL_MISSION);
  ensureFile(STRATEGY_FILE, INITIAL_STRATEGY);
  ensureFile(IDEAS_FILE, "[]\n");
  ensureFile(ARTICLES_FILE, "[]\n");
  ensureFile(JOURNAL_FILE, "");
  ensureFile(
    BUDGET_FILE,
    JSON.stringify(
      {
        month: new Date().toISOString().slice(0, 7),
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      null,
      2
    ) + "\n"
  );
}

// ---- Load / Save ----

export function loadState(): AppState {
  initializeState();

  const mission = fs.readFileSync(MISSION_FILE, "utf-8");
  const strategy = fs.readFileSync(STRATEGY_FILE, "utf-8");
  const ideas: Idea[] = JSON.parse(fs.readFileSync(IDEAS_FILE, "utf-8"));
  const articles: Article[] = JSON.parse(fs.readFileSync(ARTICLES_FILE, "utf-8"));
  const journal = fs.readFileSync(JOURNAL_FILE, "utf-8");

  // Read consecutive error count from a simple counter file
  let consecutiveErrors = 0;
  const errFile = `${STATE_DIR}/.error_count`;
  try {
    consecutiveErrors = parseInt(fs.readFileSync(errFile, "utf-8").trim(), 10) || 0;
  } catch {
    // File doesn't exist yet
  }

  return { mission, strategy, ideas, articles, journal, consecutiveErrors };
}

// Atomic write: write to tmp file then rename to prevent partial writes
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function saveIdeas(ideas: Idea[]): void {
  atomicWrite(IDEAS_FILE, JSON.stringify(ideas, null, 2) + "\n");
}

export function saveArticles(articles: Article[]): void {
  atomicWrite(ARTICLES_FILE, JSON.stringify(articles, null, 2) + "\n");
}

export function saveStrategy(strategy: string): void {
  atomicWrite(STRATEGY_FILE, strategy);
}

export function setConsecutiveErrors(count: number): void {
  fs.writeFileSync(`${STATE_DIR}/.error_count`, String(count));
}

// ---- Journal ----

export function appendJournal(action: string, summary: string): void {
  const ts = new Date().toISOString();

  // Journal aggregation: if the last entry has the same action and similar summary, aggregate
  try {
    const journal = fs.readFileSync(JOURNAL_FILE, "utf-8");
    const entries = journal.split(/(?=^## \d{4}-)/m);
    if (entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      const lastActionMatch = lastEntry.match(/^## .+ — (\S+)\n/);
      if (lastActionMatch && lastActionMatch[1] === action) {
        // Check if summary prefix matches (first 50 chars)
        const lastSummaryStart = lastEntry.indexOf("\n") + 1;
        const lastSummary = lastEntry.slice(lastSummaryStart).trim();
        const lastSummaryPrefix = lastSummary.replace(/\s*\(×\d+回、最終\d{2}:\d{2}\)\s*$/, "").slice(0, 50);
        const newPrefix = summary.slice(0, 50);

        if (lastSummaryPrefix === newPrefix) {
          // Aggregate: update the count
          const countMatch = lastSummary.match(/\(×(\d+)回、最終\d{2}:\d{2}\)/);
          const count = countMatch ? parseInt(countMatch[1], 10) + 1 : 2;
          const timeStr = ts.slice(11, 16);
          const baseSummary = lastSummary.replace(/\s*\(×\d+回、最終\d{2}:\d{2}\)\s*$/, "").trim();
          const updatedEntry = `${lastEntry.split("\n")[0]}\n${baseSummary} (×${count}回、最終${timeStr})\n\n`;
          const updatedJournal = entries.slice(0, -1).join("") + updatedEntry;
          fs.writeFileSync(JOURNAL_FILE, updatedJournal);
          return;
        }
      }
    }
  } catch {
    // If anything goes wrong with aggregation, fall through to normal append
  }

  const entry = `## ${ts} — ${action}\n${summary}\n\n`;
  fs.appendFileSync(JOURNAL_FILE, entry);
}

export function getRecentJournal(): string {
  const journal = fs.readFileSync(JOURNAL_FILE, "utf-8");
  // Split by entries (## timestamp lines)
  const entries = journal.split(/(?=^## \d{4}-)/m);
  const recent = entries.slice(-JOURNAL_PROMPT_ENTRIES);
  return recent.join("");
}

// ---- Sync articles with PixBlog API data ----

export function syncArticles(
  currentArticles: Article[],
  apiPosts: PixBlogPost[]
): Article[] {
  const today = jstToday();
  const articleMap = new Map(currentArticles.map((a) => [a.postId, a]));

  for (const post of apiPosts) {
    const existing = articleMap.get(post.id);
    if (existing) {
      // Update PV
      existing.status = post.status;
      existing.title = post.title;
      const lastPv = existing.pvHistory[existing.pvHistory.length - 1];
      if (!lastPv || lastPv.date !== today) {
        existing.pvHistory.push({ date: today, count: post.view_count });
      } else {
        lastPv.count = post.view_count;
      }
      if (post.status === "published" && existing.phase !== "published") {
        existing.phase = "published";
        existing.publishedAt = post.published_at;
      }
    } else {
      // New post found on API (e.g. pre-existing posts)
      articleMap.set(post.id, {
        postId: post.id,
        title: post.title,
        status: post.status,
        phase: post.status === "published" ? "published" : "drafted",
        publishedAt: post.published_at,
        pvHistory: [{ date: today, count: post.view_count }],
      });
    }
  }

  // Detect articles that are in state but no longer on API (deleted/trashed by owner)
  const apiPostIds = new Set(apiPosts.map((p) => p.id));
  for (const article of articleMap.values()) {
    if (!apiPostIds.has(article.postId) && article.phase !== "removed") {
      article.phase = "removed";
      article.status = "draft"; // reset status
    }
  }

  return Array.from(articleMap.values());
}

/**
 * Repair ideas linked to removed articles: clear postId and reset phase to "idea"
 * so the idea can be re-written if desired.
 */
export function repairIdeasForRemovedArticles(
  ideas: Idea[],
  articles: Article[]
): boolean {
  let changed = false;
  for (const idea of ideas) {
    if (!idea.postId) continue;
    const linkedArticle = articles.find((a) => a.postId === idea.postId);
    if (linkedArticle && linkedArticle.phase === "removed") {
      idea.postId = undefined;
      idea.phase = "idea";
      idea.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

// ---- Guardrail helpers ----

export function todayPublishCount(articles: Article[]): number {
  const today = jstToday();
  return articles.filter(
    (a) =>
      a.phase === "published" &&
      a.publishedAt &&
      toJstDate(a.publishedAt) === today
  ).length;
}

// ---- Publish slot helpers ----

function isHourInSlot(hour: number, slot: { from: number; to: number }): boolean {
  if (slot.from > slot.to) {
    // Wraps midnight (e.g. 23-01)
    return hour >= slot.from || hour < slot.to;
  }
  return hour >= slot.from && hour < slot.to;
}

export function getSlotIndex(): number {
  const hour = new Date().getUTCHours();
  for (let i = 0; i < PUBLISH_SLOTS_UTC.length; i++) {
    if (isHourInSlot(hour, PUBLISH_SLOTS_UTC[i])) return i;
  }
  return -1; // Not in any slot
}

export function isInPublishSlot(): boolean {
  return getSlotIndex() >= 0;
}

export function isSlotConsumed(articles: Article[], slotIndex: number): boolean {
  if (slotIndex < 0) return false;
  const today = jstToday();
  const slot = PUBLISH_SLOTS_UTC[slotIndex];
  return articles.some((a) => {
    if (a.phase !== "published" || !a.publishedAt || toJstDate(a.publishedAt) !== today) return false;
    const pubHour = new Date(a.publishedAt).getUTCHours();
    return isHourInSlot(pubHour, slot);
  });
}

export function minutesToNextSlot(): number {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  let minDist = Infinity;
  for (const slot of PUBLISH_SLOTS_UTC) {
    let slotStart = slot.from * 60;
    let dist = slotStart - currentMinutes;
    if (dist < 0) dist += 24 * 60; // wrap to next day
    if (dist > 0 && dist < minDist) minDist = dist;
  }
  return minDist === Infinity ? 0 : minDist;
}

export function allSlotsConsumed(articles: Article[]): boolean {
  for (let i = 0; i < PUBLISH_SLOTS_UTC.length; i++) {
    if (!isSlotConsumed(articles, i)) return false;
  }
  return true;
}

// ---- Free idle check ----

export function shouldFreeIdle(state: AppState): string | null {
  // Condition 1: Next slot is 30+ minutes away OR all slots consumed
  const inSlot = isInPublishSlot();
  const currentSlot = getSlotIndex();
  const slotConsumed = currentSlot >= 0 ? isSlotConsumed(state.articles, currentSlot) : false;
  const allConsumed = allSlotsConsumed(state.articles);

  const dailyFull = todayPublishCount(state.articles) >= MAX_PUBLISHES_PER_DAY;
  if (!dailyFull && inSlot && !slotConsumed) return null; // In an unconsumed slot — might need to publish
  if (!dailyFull && !allConsumed && minutesToNextSlot() < 30) return null; // Near a slot

  // Condition 2: reviewed (publish-ready stock) >= 1
  const reviewedCount = state.articles.filter((a) => a.phase === "reviewed").length;
  if (reviewedCount < 1) return null; // No publish stock — need to work

  // Condition 3: drafted (review-pending) = 0
  const draftedCount = state.articles.filter((a) => a.phase === "drafted").length;
  if (draftedCount > 0) return null; // Has drafts to review

  // Condition 4: ideas stock >= 5
  const ideaCount = state.ideas.filter((i) => (i.phase === "idea" || i.phase === "outlined") && !i.postId).length;
  if (ideaCount < 5) return null; // Need more ideas

  // Condition 5: analyze done today
  const today = jstToday();
  const hasAnalyzeToday = state.journal.includes(`${today}`) && state.journal.includes("— analyze");
  if (!hasAnalyzeToday) return null; // Need analyze

  const reason = allConsumed
    ? `全スロット消化済み, reviewed=${reviewedCount}, drafted=0, ideas=${ideaCount}, analyze済み`
    : `次スロットまで${minutesToNextSlot()}分, reviewed=${reviewedCount}, drafted=0, ideas=${ideaCount}, analyze済み`;
  return reason;
}

export function getAvailableActions(state: AppState): string[] {
  const actions: string[] = ["research", "analyze", "idle"];

  // Draft inventory gate: if drafted + reviewed >= 3, suppress new writing
  const unpublishedCount = state.articles.filter(
    (a) => a.phase === "drafted" || a.phase === "reviewed"
  ).length;
  const inventoryFull = unpublishedCount >= 3;

  // Showcase (gated by inventory)
  if (!inventoryFull) {
    actions.push("showcase");
  }

  // Series plan: always available if MCP is configured (inventory gate not applied — plan only, no article)
  if (DEVRELAY_MCP_TOKEN) {
    actions.push("series_plan");
  }

  // Series write: available if there are planned episodes (gated by inventory like write)
  if (!inventoryFull && DEVRELAY_MCP_TOKEN) {
    try {
      const seriesRaw = fs.readFileSync(SERIES_FILE, "utf-8");
      const seriesList = JSON.parse(seriesRaw) as Array<{ episodes: Array<{ status: string }> }>;
      const hasPlanned = seriesList.some((s) => s.episodes.some((e) => e.status === "planned"));
      if (hasPlanned) {
        actions.push("series_write");
      }
    } catch {
      // series.json doesn't exist yet — no series available
    }
  }

  // DevRelay research is available when MCP token is configured
  if (DEVRELAY_MCP_TOKEN) {
    actions.push("research_devrelay");
    actions.push("research_trouble");
  }

  // Can outline if there are ideas in "idea" phase
  if (state.ideas.some((i) => i.phase === "idea")) {
    actions.push("outline");
  }

  // Can write if there are writable ideas (gated by inventory)
  if (
    !inventoryFull &&
    state.ideas.some((i) => (i.phase === "outlined" || i.phase === "idea") && !i.postId)
  ) {
    actions.push("write");
  }

  // Can review if there are drafted articles
  if (state.articles.some((a) => a.phase === "drafted")) {
    actions.push("review");
  }

  // Can publish if: reviewed articles exist AND in a publish slot AND slot not consumed AND daily limit not reached
  const currentSlotIdx = getSlotIndex();
  if (
    state.articles.some((a) => a.phase === "reviewed") &&
    todayPublishCount(state.articles) < MAX_PUBLISHES_PER_DAY &&
    currentSlotIdx >= 0 &&
    !isSlotConsumed(state.articles, currentSlotIdx)
  ) {
    actions.push("publish");
  }

  // Can rewrite if there are published articles with PV data
  if (state.articles.some((a) => a.phase === "published")) {
    actions.push("rewrite");
  }

  return actions;
}
