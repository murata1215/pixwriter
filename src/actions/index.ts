import type { AppState } from "../state.js";
import type { ActionToolCall } from "../claude-api.js";
import { executeResearch } from "./research.js";
import { executeResearchDevrelay } from "./research_devrelay.js";
import { executeResearchTrouble } from "./research_trouble.js";
import { executeOutline } from "./outline.js";
import { executeWrite } from "./write.js";
import { executeReview } from "./review.js";
import { executePublish } from "./publish.js";
import { executeRewrite } from "./rewrite.js";
import { executeAnalyze } from "./analyze.js";
import { executeShowcase } from "./showcase.js";
import { executeSeriesPlan } from "./series_plan.js";
import { executeSeriesWrite } from "./series_write.js";
import { executeIdle } from "./idle.js";

export interface ActionResult {
  success: boolean;
  summary: string;
}

export async function dispatch(
  action: ActionToolCall,
  state: AppState
): Promise<ActionResult> {
  switch (action.name) {
    case "research":
      return executeResearch(state, action.input);
    case "research_devrelay":
      return executeResearchDevrelay(state, action.input);
    case "research_trouble":
      return executeResearchTrouble(state, action.input);
    case "outline":
      return executeOutline(state, action.input);
    case "write":
      return executeWrite(state, action.input);
    case "review":
      return executeReview(state, action.input);
    case "publish":
      return executePublish(state, action.input);
    case "rewrite":
      return executeRewrite(state, action.input);
    case "analyze":
      return executeAnalyze(state, action.input);
    case "showcase":
      return executeShowcase(state, action.input);
    case "series_plan":
      return executeSeriesPlan(state, action.input);
    case "series_write":
      return executeSeriesWrite(state, action.input);
    case "idle":
      return executeIdle(action.input);
    default:
      return { success: false, summary: `Unknown action: ${action.name}` };
  }
}
