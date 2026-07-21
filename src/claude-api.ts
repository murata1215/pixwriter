import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from "./config.js";
import { recordUsage } from "./budget.js";
import { log } from "./logger.js";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export interface ActionToolCall {
  name: string;
  input: Record<string, unknown>;
}

// Tool definitions for action selection
const ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: "research",
    description:
      "RSSフィード等からネタ候補を収集し ideas.json に追記する。topicで収集したいテーマを指定。",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description: "収集したいテーマ（例: 'Flutter最新動向', 'AI活用Tips'）",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "showcase",
    description:
      "オーナーの公開GitHubリポジトリから1つ選び、プロダクト紹介記事を執筆してdraft投稿する。技術知見記事とバランスよく混ぜる（目安: 公開記事の2-3本に1本程度はshowcase）。全リポジトリ紹介済みの場合は自動スキップ。",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "research_trouble",
    description:
      "DevRelayの会話歴からトラブルシュート記事のネタを発掘。「詰まり→試行錯誤→解決」が揃ったエピソードを探す。検索流入の主力記事になるため積極的に選ぶこと。",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "research_devrelay",
    description:
      "DevRelayの開発活動ログから記事ネタを収集。自分のプロジェクトの実装経験・ハマりどころ・設計判断をネタ源にする。RSSリサーチとは異なり、実体験ベースのネタが得られる。",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description:
            "検索クエリ（例: '最近のバグ修正', 'Flutter UI実装', 'サーバー設定の工夫'）",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "outline",
    description:
      "ideas.jsonから1つ選んで記事の構成（見出し・要点）を作成する。長文解説や比較記事など構成が重要なネタに推奨。軽いネタはスキップしてwriteに直接進んでよい。",
    input_schema: {
      type: "object" as const,
      properties: {
        idea_index: {
          type: "number",
          description: "ideas.jsonの中で構成を作るアイデアのインデックス番号",
        },
      },
      required: ["idea_index"],
    },
  },
  {
    name: "write",
    description:
      "アイデアから本文を執筆し、PixBlogにdraftとして投稿する。outlineが無いアイデア(ideaフェーズ)からも直接執筆可能。軽いネタはoutlineをスキップしてよい。",
    input_schema: {
      type: "object" as const,
      properties: {
        idea_index: {
          type: "number",
          description: "ideas.jsonの中で執筆するアイデアのインデックス番号",
        },
      },
      required: ["idea_index"],
    },
  },
  {
    name: "review",
    description:
      "既存のdraft記事を推敲・改善してPATCHで更新する。review完了後、当日の公開枠に余裕があれば同サイクルでpublishまで自動実行される。",
    input_schema: {
      type: "object" as const,
      properties: {
        post_id: {
          type: "number",
          description: "推敲するdraft記事のpost_id",
        },
      },
      required: ["post_id"],
    },
  },
  {
    name: "publish",
    description:
      "reviewを通過したdraft記事をpublishedに変更する。1日3本まで。通常はreviewが自動でpublishするため、手動で使うのは稀。",
    input_schema: {
      type: "object" as const,
      properties: {
        post_id: {
          type: "number",
          description: "公開する記事のpost_id",
        },
      },
      required: ["post_id"],
    },
  },
  {
    name: "rewrite",
    description:
      "PVデータをもとに既存公開記事を改善してPATCHで更新する。",
    input_schema: {
      type: "object" as const,
      properties: {
        post_id: {
          type: "number",
          description: "改善する公開記事のpost_id",
        },
        improvement_focus: {
          type: "string",
          description: "改善の焦点（例: 'SEOタイトル改善', '本文追記'）",
        },
      },
      required: ["post_id", "improvement_focus"],
    },
  },
  {
    name: "analyze",
    description:
      "PV傾向を分析し、strategy.mdを更新して今後の方針を見直す。",
    input_schema: {
      type: "object" as const,
      properties: {
        focus: {
          type: "string",
          description: "分析の焦点（例: '全体傾向', 'タグ別比較'）",
        },
      },
      required: ["focus"],
    },
  },
  {
    name: "series_plan",
    description:
      "大型プロジェクトの開発記を複数話の連載として企画する。会話履歴をサンプリングして連載構成を作成。在庫ゲートの対象外。",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "series_write",
    description:
      "連載の次の未執筆エピソードを執筆してdraft投稿する。会話歴・画像を素材に開発記を書く。連載のペース目安: 週2-3話、間に通常記事を挟む。",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "idle",
    description:
      "やるべきことがない場合は何もしない。正当な選択肢。",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "何もしない理由",
        },
      },
      required: ["reason"],
    },
  },
];

export async function decideAction(
  systemPrompt: string,
  contextMessage: string,
  availableActions: string[]
): Promise<ActionToolCall> {
  const tools = ACTION_TOOLS.filter((t) => availableActions.includes(t.name));

  log("INFO", `Claude API: deciding action from [${availableActions.join(", ")}]`);

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: contextMessage }],
  });

  // Record usage
  if (response.usage) {
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    log(
      "INFO",
      `Claude API usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    );
  }

  // Extract tool call
  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude API did not return a tool call");
  }

  return {
    name: toolBlock.name,
    input: toolBlock.input as Record<string, unknown>,
  };
}

export async function generateContent(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096
): Promise<string> {
  log("INFO", "Claude API: generating content");

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.usage) {
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    log(
      "INFO",
      `Claude API usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    );
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude API did not return text content");
  }

  return textBlock.text;
}

export async function checkImageSafety(
  imageBase64: string,
  mimeType: string
): Promise<{ safe: boolean; reason: string }> {
  log("INFO", "Claude API: checking image safety (vision)");

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `この画像にブログ公開時に問題になる情報が含まれていないか判定してください。
以下のいずれかが含まれている場合は unsafe です:
- 認証情報・トークン・APIキー
- IPアドレス
- メールアドレス
- 人物の顔
- 非公開の業務情報・社内資料

JSON形式のみで返してください: {"safe": true/false, "reason": "判定理由"}`,
          },
        ],
      },
    ],
  });

  if (response.usage) {
    recordUsage(response.usage.input_tokens, response.usage.output_tokens);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { safe: false, reason: "Vision判定の応答が取得できませんでした" };
  }

  try {
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Parse failure
  }

  return { safe: false, reason: "Vision判定結果のパースに失敗" };
}
