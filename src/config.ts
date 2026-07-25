import path from "node:path";

export const HOME = "/home/pixwriter";
export const AGENT_DIR = path.join(HOME, "agent");
export const STATE_DIR = path.join(HOME, "state");
export const LOGS_DIR = path.join(HOME, "logs");

// State files
export const MISSION_FILE = path.join(STATE_DIR, "mission.md");
export const STRATEGY_FILE = path.join(STATE_DIR, "strategy.md");
export const IDEAS_FILE = path.join(STATE_DIR, "ideas.json");
export const ARTICLES_FILE = path.join(STATE_DIR, "articles.json");
export const JOURNAL_FILE = path.join(STATE_DIR, "journal.md");
export const BUDGET_FILE = path.join(STATE_DIR, "budget.json");
export const HALT_FILE = path.join(STATE_DIR, "HALT");
export const LOCK_FILE = path.join(STATE_DIR, ".lock");
export const SERIES_FILE = path.join(STATE_DIR, "series.json");
export const QUALITY_FILE = path.join(STATE_DIR, "quality.md");

// PixBlog API
export const PIXBLOG_BASE_URL = "https://pixblog.net";
export const PIXBLOG_API_TOKEN = process.env.PIXBLOG_API_TOKEN ?? "";

// Claude API
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const CLAUDE_MODEL = "claude-sonnet-4-6" as const;
// Cheaper model for lightweight, non-generation work (action decision, PV
// analysis). Article body generation stays on CLAUDE_MODEL (sonnet) for quality.
export const DECISION_MODEL = "claude-haiku-4-5-20251001" as const;

// Budget
export const MONTHLY_BUDGET_USD = 20;

// Pricing (per million tokens)
// Claude Sonnet 4
export const INPUT_PRICE_PER_M = 3.0;
export const OUTPUT_PRICE_PER_M = 15.0;
// Claude Haiku 4.5
export const HAIKU_INPUT_PRICE_PER_M = 1.0;
export const HAIKU_OUTPUT_PRICE_PER_M = 5.0;

/** Returns the per-million-token pricing for an Anthropic model id. */
export function anthropicPricing(model: string): { input: number; output: number } {
  if (model.includes("haiku")) {
    return { input: HAIKU_INPUT_PRICE_PER_M, output: HAIKU_OUTPUT_PRICE_PER_M };
  }
  return { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M };
}

// Timezone
export const JST_OFFSET_HOURS = 9;

// Timing
export const CYCLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes
export const LOG_RETENTION_DAYS = 30;

// Guardrails
export const MAX_CONSECUTIVE_ERRORS = 3;
export const MAX_PUBLISHES_PER_DAY = 3;

// PV evaluation. Below this, view counts are treated as noise (mostly the
// owner's own confirmation access) and MUST NOT drive theme/strategy decisions.
export const PV_SUCCESS_THRESHOLD = 100;

// Quality gate (review): total score below this triggers one rewrite pass.
// Score is 4 axes x 1-5 = 4..20.
export const QUALITY_SCORE_MIN = 12;

// Publish time slots (UTC hours). JST = UTC + 9.
// Slot 0: JST 08:00-10:00 = UTC 23:00-01:00
// Slot 1: JST 12:00-14:00 = UTC 03:00-05:00
// Slot 2: JST 19:00-21:00 = UTC 10:00-12:00
export const PUBLISH_SLOTS_UTC = [
  { from: 23, to: 1 },   // wraps midnight
  { from: 3, to: 5 },
  { from: 10, to: 12 },
];

// Journal
export const JOURNAL_PROMPT_ENTRIES = 12;

// OpenAI (image generation)
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const EYECATCH_MODEL = "gpt-image-1";
export const IMAGE_BUDGET_USD = 10;
export const EYECATCH_COST_PER_IMAGE = 0.011; // gpt-image-1 low quality

// DevRelay MCP
export const DEVRELAY_MCP_URL = "https://app.devrelay.io/mcp";
export const DEVRELAY_MCP_TOKEN = process.env.DEVRELAY_MCP_TOKEN ?? "";

// RSS feeds for research
export const RSS_FEEDS = [
  "https://zenn.dev/feed",
  "https://hnrss.org/best?count=20",
  "https://dev.to/feed",
];
