import fs from "node:fs";
import {
  BUDGET_FILE,
  MONTHLY_BUDGET_USD,
  INPUT_PRICE_PER_M,
  OUTPUT_PRICE_PER_M,
  IMAGE_BUDGET_USD,
} from "./config.js";

export interface Budget {
  month: string; // "2026-07"
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  imageGenCount: number;
  imageGenCostUsd: number;
  openaiTextCostUsd: number;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function loadBudget(): Budget {
  const month = currentMonth();
  try {
    const raw = fs.readFileSync(BUDGET_FILE, "utf-8");
    const budget: Budget = JSON.parse(raw);
    if (budget.month !== month) {
      // New month — reset
      return { month, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, imageGenCount: 0, imageGenCostUsd: 0, openaiTextCostUsd: 0 };
    }
    // Backfill new fields for old budget files
    budget.imageGenCount ??= 0;
    budget.imageGenCostUsd ??= 0;
    budget.openaiTextCostUsd ??= 0;
    return budget;
  } catch {
    return { month, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, imageGenCount: 0, imageGenCostUsd: 0, openaiTextCostUsd: 0 };
  }
}

export function saveBudget(budget: Budget): void {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2) + "\n");
}

export function recordUsage(inputTokens: number, outputTokens: number): Budget {
  const budget = loadBudget();
  budget.inputTokens += inputTokens;
  budget.outputTokens += outputTokens;
  budget.estimatedCostUsd =
    (budget.inputTokens / 1_000_000) * INPUT_PRICE_PER_M +
    (budget.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
  saveBudget(budget);
  return budget;
}

export function isBudgetExceeded(): boolean {
  const budget = loadBudget();
  // Total text generation cost = Anthropic + OpenAI
  return (budget.estimatedCostUsd + budget.openaiTextCostUsd) >= MONTHLY_BUDGET_USD;
}

export function recordOpenAITextUsage(inputTokens: number, outputTokens: number, costUsd: number): Budget {
  const budget = loadBudget();
  budget.openaiTextCostUsd += costUsd;
  saveBudget(budget);
  return budget;
}

export function recordImageUsage(cost: number): Budget {
  const budget = loadBudget();
  budget.imageGenCount++;
  budget.imageGenCostUsd += cost;
  saveBudget(budget);
  return budget;
}

export function isImageBudgetExceeded(): boolean {
  const budget = loadBudget();
  return budget.imageGenCostUsd >= IMAGE_BUDGET_USD;
}
