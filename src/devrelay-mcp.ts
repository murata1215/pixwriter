import { DEVRELAY_MCP_URL, DEVRELAY_MCP_TOKEN } from "./config.js";
import { log } from "./logger.js";

interface McpSession {
  sessionId: string | null;
}

interface McpJsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpProject {
  id: string;
  name: string;
  path: string;
  machine: string;
  machineId: string;
  online: boolean;
  aiTool: string;
}

interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export interface McpAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface McpMessage {
  id: string;
  role: string;
  content: string;
  truncated: boolean;
  timestamp: string;
  sessionId: string;
  attachments: McpAttachment[];
}

export interface ConversationResult {
  messages: McpMessage[];
  hasMore: boolean;
}

function parseSSEResponse(text: string): McpJsonRpcResponse {
  // SSE format: "event: message\ndata: {...}\n\n"
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const jsonStr = line.slice(6);
      return JSON.parse(jsonStr);
    }
  }
  throw new Error("No data line found in SSE response");
}

async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId: string | null
): Promise<{ response: McpJsonRpcResponse; newSessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${DEVRELAY_MCP_TOKEN}`,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const res = await fetch(DEVRELAY_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP request failed: ${res.status} ${res.statusText} - ${text}`);
  }

  // Extract session ID from response headers
  const newSessionId = res.headers.get("mcp-session-id") || sessionId;

  const body = await res.text();
  const parsed = parseSSEResponse(body);

  if (parsed.error) {
    throw new Error(`MCP error: ${parsed.error.code} - ${parsed.error.message}`);
  }

  return { response: parsed, newSessionId };
}

export async function initSession(): Promise<McpSession> {
  log("INFO", "DevRelay MCP: initializing session");

  const { newSessionId } = await mcpRequest(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pixwriter", version: "1.0.0" },
    },
    1,
    null
  );

  return { sessionId: newSessionId };
}

export async function listProjects(session: McpSession): Promise<McpProject[]> {
  log("INFO", "DevRelay MCP: listing projects");

  const { response } = await mcpRequest(
    "tools/call",
    { name: "list_projects", arguments: {} },
    2,
    session.sessionId
  );

  const result = response.result as McpToolResult;
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent) {
    throw new Error("No text content in list_projects response");
  }

  const data = JSON.parse(textContent.text!);
  return data.projects as McpProject[];
}

export async function searchContext(
  session: McpSession,
  projectId: string,
  query: string
): Promise<string> {
  log("INFO", `DevRelay MCP: searching context for project ${projectId}`);

  const { response } = await mcpRequest(
    "tools/call",
    {
      name: "search_project_context",
      arguments: { projectId, query },
    },
    3,
    session.sessionId
  );

  const result = response.result as McpToolResult;
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent) {
    return "(検索結果なし)";
  }

  return textContent.text ?? "";
}

export async function getConversationHistory(
  session: McpSession,
  projectId: string,
  options: { limit?: number; before?: string; after?: string; order?: "asc" | "desc" } = {}
): Promise<ConversationResult> {
  log("INFO", `DevRelay MCP: get_conversation_history for ${projectId} (limit=${options.limit ?? 50})`);

  const args: Record<string, unknown> = { projectId };
  if (options.limit) args.limit = options.limit;
  if (options.before) args.before = options.before;
  if (options.after) args.after = options.after;
  if (options.order) args.order = options.order;

  const { response } = await mcpRequest(
    "tools/call",
    { name: "get_conversation_history", arguments: args },
    4,
    session.sessionId
  );

  const result = response.result as McpToolResult;
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !textContent.text) {
    return { messages: [], hasMore: false };
  }

  const data = JSON.parse(textContent.text);
  return {
    messages: (data.messages ?? []) as McpMessage[],
    hasMore: data.hasMore ?? false,
  };
}

export async function getAttachment(
  session: McpSession,
  attachmentId: string
): Promise<Buffer | null> {
  log("INFO", `DevRelay MCP: get_attachment ${attachmentId}`);

  const { response } = await mcpRequest(
    "tools/call",
    { name: "get_attachment", arguments: { attachmentId } },
    5,
    session.sessionId
  );

  const result = response.result as McpToolResult;
  // Look for image content (base64)
  const imageContent = result.content.find((c) => c.type === "image" && c.data);
  if (imageContent && imageContent.data) {
    return Buffer.from(imageContent.data, "base64");
  }

  // Fallback: look for text content that might be base64
  const textContent = result.content.find((c) => c.type === "text" && c.text);
  if (textContent && textContent.text) {
    try {
      const data = JSON.parse(textContent.text);
      if (data.base64) return Buffer.from(data.base64, "base64");
    } catch {
      // Not JSON, maybe raw base64
    }
  }

  log("WARN", `Could not extract image data from attachment ${attachmentId}`);
  return null;
}
