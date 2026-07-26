/**
 * City profile article generator (B-article) — v2.
 * Reads data from pixdata DB (or mock), generates article body via Claude,
 * validates numbers, assembles self-contained HTML.
 *
 * v2 → v3 (Phase 2):
 * - Language data loaded from src/data/lang/{cityId}.json (not fixture/mock)
 * - --post support: draft posting to PixBlog + article/citation recording in pixdata
 * - Real DB mode (queries.ts functions run against pixdata)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateContent } from "../claude-api.js";
import { CLAUDE_MODEL } from "../config.js";
import { createPost } from "../pixblog-api.js";
import { log } from "../logger.js";
import { query as dbQuery } from "./db.js";
import { locationMapSvg, distanceKm, type MapResult } from "./geomap.js";
import { searchCityPhotos, type PhotoCandidate } from "./photo.js";
import type {
  MockData,
  CityRow,
  ComparisonRow,
  FindingRow,
  WageAnnualRow,
  ValueRow,
  SourceRow,
  LanguageData,
} from "./queries.js";
import {
  getCity,
  getRefCity,
  getValues,
  getComparisons,
  getFindings,
  getWageAnnual,
  getSources,
} from "./queries.js";
import { heroSvg, comparisonBarsSvg, type BarRow } from "./svg.js";

// ---- Metric display names (reader-facing) ----
const METRIC_NAME: Record<string, string> = {
  tax_vat: "消費税（付加価値税）",
  tax_income_max: "所得税（最高税率）",
  tax_corp: "法人税",
  petrol: "ガソリン",
  diesel: "軽油",
  rent_expat: "住宅家賃",
  wage_worker: "一般職の賃金",
  wage_engineer: "技術職の賃金",
  wage_manager: "管理職の賃金",
  elec_household: "電気代",
  si_employee: "社会保険料（本人負担）",
};

// ---- LLM prompt (v2) ----

interface LlmInput {
  city: CityRow;
  refCity: CityRow;
  comparisons: ComparisonRow[];
  findings: FindingRow[];
  wageAnnual: WageAnnualRow[];
  values: ValueRow[];
  language?: LanguageData;
}

interface LlmOutput {
  title: string;
  excerpt: string;
  lead: string[];
  sections: {
    heading: string;
    sourceNote: string;
    paragraphs: string[];
  }[];
  languageParagraphs: string[];
  fit: string[];
  unfit: string[];
}

function buildPrompt(input: LlmInput): { system: string; user: string } {
  const { city, refCity, comparisons, findings, wageAnnual, language } = input;

  // Build comparison table in reader-facing format (no internal vocabulary)
  const compTable = comparisons
    .sort((a, b) => Math.abs(b.index_vs_ref - 100) - Math.abs(a.index_vs_ref - 100))
    .map((c) => {
      const ratio = (c.index_vs_ref / 100).toFixed(2);
      const caveats: string[] = [];
      if (c.flag_basis_mismatch || c.flag_stat_mismatch) {
        caveats.push(`※定義が異なる: ${city.name_ja}側「${c.definition_note ?? ""}」/ ${refCity.name_ja}側「${c.ref_definition_note ?? ""}」`);
      }
      if (c.flag_spec_mismatch) {
        caveats.push(`※物件の条件（面積等）が異なるため、そのまま比較できない`);
      }
      const caveatStr = caveats.length > 0 ? `\n  ${caveats.join("\n  ")}` : "";
      return `- ${METRIC_NAME[c.metric_id] ?? c.metric_id}: ${refCity.name_ja}の${ratio}倍（${city.name_ja}=${c.val_base}, ${refCity.name_ja}=${c.ref_val_base}）${caveatStr}`;
    })
    .join("\n");

  // Build wage annual text (reader-facing)
  const wageText = wageAnnual
    .map((w) => {
      const cityName = w.city_id === city.id ? city.name_ja : refCity.name_ja;
      const bonusInfo = w.bonus_months
        ? `（基本給のみ。賞与${w.bonus_months}ヶ月分を加えた年収で比較）`
        : "（賞与込みの年額）";
      return `- ${cityName} / ${METRIC_NAME[w.metric_id] ?? w.metric_id}: 月額USD${w.monthly_base.toFixed(0)}, 年額USD${w.annual_base.toFixed(0)} ${bonusInfo}`;
    })
    .join("\n");

  // Build findings text (reader-facing, no internal vocabulary)
  const findingsText = findings
    .map((f) => {
      const ratio = (f.index_vs_ref / 100).toFixed(1);
      const direction = f.kind === "much_higher" ? `${refCity.name_ja}の${ratio}倍` : `${refCity.name_ja}の${ratio}倍（低い）`;
      return `- ${f.name_ja}: ${direction}${f.needs_caveat ? "（ただし調査条件が異なるため注記が必要）" : ""}`;
    })
    .join("\n");

  // Build language section data
  let languageText = "";
  if (language) {
    const epiRows = language.ef_epi.rows
      .map((r) => `  ${r.country}: ${r.rank}位 / スコア${r.score}（${r.band}）`)
      .join("\n");
    languageText = `
## 言語
- 公用語: ${language.official_language_ja}
- EF英語能力指数（${language.ef_epi.year}年、${language.ef_epi.note}）:
${epiRows}
- EU全体の英語会話可能率: ${language.eurobarometer.eu_english_conversational_pct}%（${language.eurobarometer.survey}）
- EU若年層（15-24歳）の英語会話可能率: ${language.eurobarometer.eu_youth_english_pct}%
- 日本人学校: ${language.japanese_infra.japanese_school ? "あり" : "なし"}（${language.japanese_infra.note}）
- 注意: チェコ人の英語会話可能率の国別数値はデータにないため書かないこと。EF順位とEU平均からの示唆に留める
- EF EPIの方法論上の限界（自主受験ベースのため代表性に限界がある点）を本文中で注記すること`;
  }

  const system = `あなたは、日本からの個人移住を検討している読者に向けて、都市の生活コストを数字で解説する記事の執筆者である。以下のルールを厳守すること。

【絶対ルール】
1. 提供された数値以外の数字を一切書かない。年号・統計値・順位等を創作してはならない。
2. 各セクションは提供データの範囲で書く。データにない主張をしない。
3. 比較データに「定義が異なる」「物件条件が異なる」等の注記がある場合、本文中で自然な日本語で非対称性を説明する（例:「ただし両都市の数字は調査主体も集計方法も異なるため、そのまま優劣とは読めない」）。
4. 体験談・感想は書かない。筆者は現地に住んだことがない前提。
5. 文体は「だ・である」調。確度の高い事実（税率・公定価格）は断定し、実例1件の比較（住宅等）は「一つの手がかり」として留保する。
6. 各段落は短く（3-5文）。

【読者ロック】
7. 読者は「日本から個人として移住を検討している人」。
   「企業」「法人」「進出」「事業者」「投資」「駐在員コスト」等の企業向け語彙を使わない。
   データがJETRO調査由来でも、生活者の言葉に翻訳する
   （例: 付加価値税→「買い物のたびにかかる税」、燃料費→「車のある生活のコスト」）。
   「向く/向かない」は個人の条件（収入源のパターン、生活様式、職種、家族構成）で書く。

【内部語彙の禁止】
8. 出力に以下を含めてはならない: index=、basis_mismatch、stat_mismatch、spec_mismatch、flag、v_comparison、deviation。
   比較の非対称性は自然な日本語で説明する。

【タイトルとリードの規則】
9. タイトルは最も意外な数値2つを具体的な倍率・分数で示す形にする
   （手本:「電気は3分の2、ガソリンは1.5倍——プラハの生活コストを名古屋と比べた」）。
   「◯◯プロファイル」「◯◯比較」「コスト比較」等の総称タイトルは禁止。
   リード第1文も具体的な数字から入る。

【出力形式】
以下のJSON形式で返してください（他の文章は不要）:
{
  "title": "記事タイトル（都市名と具体的数値を含む。総称禁止）",
  "excerpt": "検索スニペット用の説明（100-160字）",
  "lead": ["リード段落1（具体的な数字から始める）", "リード段落2", "リード段落3"],
  "sections": [
    {
      "heading": "セクション見出し（番号付き）",
      "sourceNote": "SOURCE — 出典名",
      "paragraphs": ["段落1", "段落2"]
    }
  ],
  "languageParagraphs": ["言語セクションの段落1", "段落2"],
  "fit": ["向く個人条件1", "向く個人条件2", "向く個人条件3"],
  "unfit": ["向かない個人条件1", "向かない個人条件2", "向かない個人条件3"]
}

セクション数は3-5個。各セクションは比較データの中から1-2個の指標にフォーカスし、個人の暮らしにとって何を意味するかを解説する。
languageParagraphsは2-3段落。言語データが提供されている場合のみ書く。`;

  const user = `以下のデータから、${city.name_ja}（${city.country_ja}）に移住した場合の生活コストを${refCity.name_ja}と比較する記事を生成してください。

## 生活コスト比較（${refCity.name_ja}を基準とした倍率）
${compTable}

## 特に差が大きい項目
${findingsText}

## 賃金の年収換算（賞与込みで揃えた比較）
${wageText}
${languageText}

## 補足
- 比較はすべて同一調査（ジェトロ2025年度調査）内で行っている
- 電気代は${refCity.name_ja}で未調査のため比較なし。${city.name_ja}の値は0.36 USD/kWh
- 社会保険の本人負担率: ${city.name_ja}=11.6%
- 注記付きの比較は、本文中で条件の違いを自然な日本語で説明すること
- 「企業」「法人」「進出」「投資」「駐在員」等の語彙は使わないこと`;

  return { system, user };
}

// ---- Number validation ----

function extractNumbers(text: string): string[] {
  const matches = text.match(/[\d,]+(?:\.\d+)?/g) ?? [];
  return matches.map((m) => m.replace(/,/g, ""));
}

function buildAllowedNumbers(input: LlmInput): Set<string> {
  const allowed = new Set<string>();

  const addNum = (n: number | null | undefined) => {
    if (n == null || isNaN(n)) return;
    allowed.add(String(n));
    allowed.add(n.toFixed(0));
    allowed.add(n.toFixed(1));
    allowed.add(n.toFixed(2));
    if (n >= 1000) {
      allowed.add(n.toLocaleString("en-US"));
    }
  };

  for (const c of input.comparisons) {
    addNum(c.index_vs_ref);
    addNum(c.val_base);
    addNum(c.ref_val_base);
    addNum(c.index_vs_ref / 100);
  }
  for (const f of input.findings) {
    addNum(f.index_vs_ref);
    addNum(f.deviation);
    addNum(f.index_vs_ref / 100);
  }
  for (const w of input.wageAnnual) {
    addNum(w.monthly_base);
    addNum(w.annual_base);
    addNum(w.bonus_months);
  }
  for (const v of input.values) {
    addNum(v.val_low);
    addNum(v.val_high);
    addNum(v.val_mid);
    addNum(v.val_base);
    addNum(v.sample_n);
    addNum(v.spec_area_sqm);
    if (v.definition_note) {
      const noteNums = v.definition_note.match(/[\d,]+(?:\.\d+)?/g) ?? [];
      for (const nn of noteNums) addNum(parseFloat(nn.replace(/,/g, "")));
    }
  }
  for (const c of input.comparisons) {
    for (const note of [c.definition_note, c.ref_definition_note]) {
      if (note) {
        const noteNums = note.match(/[\d,]+(?:\.\d+)?/g) ?? [];
        for (const nn of noteNums) addNum(parseFloat(nn.replace(/,/g, "")));
      }
    }
  }

  // Cross-value derived ratios
  for (const c of input.comparisons) {
    if (c.val_base > 0 && c.ref_val_base > 0) {
      addNum(c.val_base / c.ref_val_base);
      addNum(c.ref_val_base / c.val_base);
    }
  }
  const specAreas: number[] = [];
  for (const v of input.values) {
    if (v.spec_area_sqm) specAreas.push(v.spec_area_sqm);
  }
  for (const c of input.comparisons) {
    for (const note of [c.definition_note, c.ref_definition_note]) {
      if (note) {
        const areaMatch = note.match(/([\d.]+)\s*(?:m2|㎡|m²)/);
        if (areaMatch) specAreas.push(parseFloat(areaMatch[1]));
      }
    }
  }
  for (const a of specAreas) {
    for (const b of specAreas) {
      if (a !== b && b > 0) addNum(a / b);
    }
  }
  const wageVals = input.wageAnnual.map((w) => w.annual_base);
  for (const a of wageVals) {
    for (const b of wageVals) {
      if (a !== b && b > 0) addNum(a / b);
    }
  }

  // Language data numbers
  if (input.language) {
    const lang = input.language;
    addNum(lang.ef_epi.year);
    for (const r of lang.ef_epi.rows) {
      addNum(r.rank);
      addNum(r.score);
    }
    addNum(lang.eurobarometer.eu_english_conversational_pct);
    addNum(lang.eurobarometer.eu_youth_english_pct);
    // Numbers from EF note (e.g. "123カ国")
    const epiNoteNums = lang.ef_epi.note.match(/[\d,]+(?:\.\d+)?/g) ?? [];
    for (const nn of epiNoteNums) addNum(parseFloat(nn.replace(/,/g, "")));
    // Numbers from eurobarometer note/survey (e.g. "2.6万人")
    const ebNums = (lang.eurobarometer.survey + " " + lang.eurobarometer.note).match(/[\d,]+(?:\.\d+)?/g) ?? [];
    for (const nn of ebNums) addNum(parseFloat(nn.replace(/,/g, "")));
  }

  // Common small numbers, years, months, days
  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  for (let y = 2020; y <= 2030; y++) allowed.add(String(y));
  allowed.add("100");

  return allowed;
}

function validateNumbers(
  text: string,
  allowed: Set<string>
): { valid: boolean; violations: string[] } {
  const nums = extractNumbers(text);
  const violations: string[] = [];

  for (const n of nums) {
    if (allowed.has(n)) continue;
    const nv = parseFloat(n);
    if (isNaN(nv)) continue;
    let found = false;
    for (const a of allowed) {
      const av = parseFloat(a);
      if (!isNaN(av) && av !== 0 && Math.abs((nv - av) / av) <= 0.05) {
        found = true;
        break;
      }
    }
    if (!found) violations.push(n);
  }

  return { valid: violations.length === 0, violations };
}

// ---- Title validation ----

const GENERIC_TITLE_PATTERNS = [
  /プロファイル/,
  /比較$/,
  /コスト比較/,
  /データ比較/,
  /概要/,
  /まとめ/,
];

function isGenericTitle(title: string): boolean {
  return GENERIC_TITLE_PATTERNS.some((p) => p.test(title));
}

// ---- HTML assembly ----

function buildComparisonTable(
  comparisons: ComparisonRow[],
  cityName: string,
  refCityName: string
): string {
  const sorted = [...comparisons].sort(
    (a, b) => Math.abs(b.index_vs_ref - 100) - Math.abs(a.index_vs_ref - 100)
  );

  const rows = sorted
    .map((c) => {
      const name = METRIC_NAME[c.metric_id] ?? c.metric_id;
      const hi = Math.abs(c.index_vs_ref - 100) > 40 ? ' class="hi"' : "";
      const flags: string[] = [];
      if (c.flag_basis_mismatch) flags.push("調査条件が異なる");
      if (c.flag_spec_mismatch) flags.push("物件条件が異なる");
      if (c.flag_stat_mismatch) flags.push("集計方法が異なる");
      const note = flags.length > 0 ? `<br><span style="font-size:12px;color:#6B7079">${flags.join("、")}</span>` : "";
      return `<tr${hi}><td>${name}${note}</td><td class="n">${c.index_vs_ref}</td></tr>`;
    })
    .join("\n");

  return `<table>
<thead><tr><th>指標</th><th style="text-align:right">${refCityName}=100</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function buildMethodSection(usedSourceIds: Set<string>, allSources: SourceRow[], hasLanguage: boolean): string {
  const sourceRows = allSources
    .filter((s) => usedSourceIds.has(s.id) && s.attribution_ja)
    .map((s) => `<tr><td>${s.name_ja}</td><td>${s.attribution_ja}</td></tr>`)
    .join("\n");

  const epiCaveat = hasLanguage
    ? `<li>EF英語能力指数（EF EPI）は自主受験者の成績に基づくため、各国の英語力の代表値とは限りません。傾向の把握として参照しています</li>\n`
    : "";

  return `<div class="method">
<h2>この記事のデータについて</h2>
<p>公開されている公的統計をもとに構成しています。数値の取得と作図はスクリプトによります。筆者は対象都市に居住した経験がなく、体験談や生活実感は含みません。数字で言えることの範囲を明示することを優先しました。</p>

<table>
<tbody>
${sourceRows}
</tbody>
</table>

<p style="font-weight:500;margin-bottom:8px">注意事項</p>
<ul>
<li>ジェトロ調査の換算レートは調査時点のインターバンクレートによります。都市ごとに調査時期が異なります</li>
<li>住居費は市場平均ではなく、各都市1〜2件の実例です。物件のグレードや立地条件は完全には揃っていません</li>
<li>賃金はすべて税引き前（グロス）です。定義（賞与込み/別、平均/中央値）が都市間で異なる場合があり、本文中で注記しています</li>
<li>統計の参照年は項目により異なります</li>
${epiCaveat}<li>ビザ・在留資格は頻繁に変わるため本記事では扱っていません</li>
</ul>

<p class="foot" style="margin-top:24px">本記事は公的統計に基づく情報提供であり、移住の可否を助言するものではありません。実際の判断にあたっては、税務・法務・在留資格について専門家にご相談ください。</p>
</div>`;
}

function assembleHtml(
  llmOutput: LlmOutput,
  heroSvgStr: string,
  compBarsSvgStr: string,
  compTableHtml: string,
  methodHtml: string,
  city: CityRow,
  refCity: CityRow,
  hasLanguage: boolean,
  opts: {
    locationMapHtml?: string;
    distanceKm?: number;
    photo?: PhotoCandidate;
  } = {}
): string {
  const today = new Date().toISOString().slice(0, 10);

  const leadHtml = llmOutput.lead
    .map((p) => `<p class="lede">${p}</p>`)
    .join("\n");

  const sectionsHtml = llmOutput.sections
    .map(
      (s) =>
        `<h2>${s.heading}</h2>
<p class="h2note">${s.sourceNote}</p>
${s.paragraphs.map((p) => `<p>${p}</p>`).join("\n")}`
    )
    .join("\n\n");

  const fitHtml = llmOutput.fit.map((f) => `<li>${f}</li>`).join("\n");
  const unfitHtml = llmOutput.unfit.map((u) => `<li>${u}</li>`).join("\n");

  // Language section
  let languageHtml = "";
  if (hasLanguage && llmOutput.languageParagraphs?.length > 0) {
    languageHtml = `
<h2>言語 — 何語が話せれば暮らせるか</h2>
<p class="h2note">SOURCE — EF EPI 2025 / Eurobarometer 540</p>
${llmOutput.languageParagraphs.map((p) => `<p>${p}</p>`).join("\n")}
`;
  }

  const css = getReferenceCss();

  // Location map (if coordinates available)
  const locationSection = opts.locationMapHtml
    ? `<figure>
${opts.locationMapHtml}
<figcaption><b>FIG.0</b>　${city.name_ja}の位置</figcaption>
</figure>`
    : "";

  // Distance stat card
  const distanceStat = opts.distanceKm
    ? `<div class="stat"><dt>${refCity.name_ja}からの距離</dt><dd>${opts.distanceKm.toLocaleString()}<small>km</small></dd></div>`
    : "";

  // Photo (if available)
  const photoSection = opts.photo
    ? `<figure>
<img src="${opts.photo.pixblogUrl}" alt="${city.name_ja}の街並み" style="width:100%;border-radius:2px">
<figcaption>${opts.photo.figcaption}</figcaption>
</figure>`
    : "";

  return `<div class="iju-post">
${css}
<div class="hero">
${heroSvgStr}
</div>

<div class="wrap">

${locationSection}

<div class="eyebrow"><b>都市データ</b><span>${city.country_ja} / ${city.name_ja}</span></div>

${leadHtml}

<div class="byline">
  <span>公的統計をもとに構成</span><span>体験談を含みません</span><span>${today}</span>
</div>

<dl class="stats">
${distanceStat}
</dl>

<figure>
${compBarsSvgStr}
<figcaption><b>FIG.1</b>　${refCity.name_ja}を100としたときの${city.name_ja}の水準。比率は現地通貨ベースで算出。</figcaption>
</figure>

${compTableHtml}

${sectionsHtml}

${languageHtml}

${photoSection}

<h2>誰に向いて、誰に向かないか</h2>
<p class="h2note">ASSESSMENT — 上記データからの解釈</p>

<div class="verdict fit">
<section>
<h4>DATA SUGGESTS — 向く</h4>
<ul>
${fitHtml}
</ul>
</section>
</div>

<div class="verdict unfit">
<section>
<h4>DATA SUGGESTS — 向かない</h4>
<ul>
${unfitHtml}
</ul>
</section>
</div>

${methodHtml}

</div>
</div>`;
}

function getReferenceCss(): string {
  try {
    const refPath = "/opt/pixdata/doc/B-budapest-pixblog.html";
    const content = fs.readFileSync(refPath, "utf-8");
    const match = content.match(/<style>[\s\S]*?<\/style>/);
    if (match) return match[0];
  } catch {
    // Fallback
  }
  return "<style>/* reference CSS not found */</style>";
}

// ---- JETRO figure counting ----

function countJetroFigures(llmText: string, values: ValueRow[]): number {
  const jetroValues = values.filter((v) => v.source_id === "jetro_cost");
  let count = 0;
  for (const v of jetroValues) {
    const numStr = String(v.val_mid);
    if (llmText.includes(numStr)) count++;
  }
  return count;
}

// ---- Language data loader ----

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLanguageData(cityId: string): LanguageData | undefined {
  const langPath = path.join(__dirname, "lang", `${cityId}.json`);
  try {
    if (fs.existsSync(langPath)) {
      const data = JSON.parse(fs.readFileSync(langPath, "utf-8")) as LanguageData;
      log("INFO", `[citygen] Language data loaded from ${langPath}`);
      return data;
    }
  } catch (e) {
    log("WARN", `[citygen] Failed to load language data: ${e}`);
  }
  return undefined;
}

// ---- Draft posting & citation recording ----

async function postDraft(
  html: string,
  meta: { title: string; excerpt: string; tags: string[] },
  slug: string
): Promise<{ id: number; url: string }> {
  log("INFO", `[citygen] Posting draft to PixBlog (slug=${slug})`);

  // PixBlog API: HTML uses `content` field (not `body`, no `content_format`).
  // Token comes from ~/.pixblog_token (nagoya-ijyu account), NOT from
  // .pixblog-agent.env (which is the old blog agent's fwjg2507 token).
  const tokenPath = "/home/pixwriter/.pixblog_token";
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`PixBlog token file not found: ${tokenPath}. Refusing to fall back to .pixblog-agent.env.`);
  }
  const token = fs.readFileSync(tokenPath, "utf-8").trim();
  if (!token) {
    throw new Error(`PixBlog token file is empty: ${tokenPath}`);
  }

  const { PIXBLOG_BASE_URL } = await import("../config.js");
  const res = await fetch(`${PIXBLOG_BASE_URL}/api/v1/posts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: meta.title,
      content: html,
      tags: meta.tags,
      status: "draft",
      excerpt: meta.excerpt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PixBlog API error: ${res.status} ${res.statusText} - ${text}`);
  }

  const post = (await res.json()) as { id: number; url: string };
  log("INFO", `[citygen] Draft posted: post_id=${post.id}, url=${post.url}`);
  return { id: post.id, url: post.url };
}

async function recordArticleAndCitations(
  postId: number,
  cityId: string,
  title: string,
  values: ValueRow[]
): Promise<{ articleId: string; citationCount: number }> {
  const articleId = `pixblog-${postId}`;

  // Insert article record
  await dbQuery(
    "INSERT INTO article (id, profile, city_id, title_ja, status) VALUES ($1, $2, $3, $4, $5)",
    [articleId, "b", cityId, title, "draft"]
  );
  log("INFO", `[citygen] Article record created: ${articleId}`);

  // Insert citations for each observation used
  // We cite all observations from the values array (these are the data points available to the article)
  let citationCount = 0;
  const errors: string[] = [];

  for (const v of values) {
    try {
      await dbQuery(
        "INSERT INTO article_citation (article_id, observation_id) VALUES ($1, $2)",
        [articleId, v.id]
      );
      citationCount++;
    } catch (e) {
      const msg = String(e);
      errors.push(`observation_id=${v.id}: ${msg}`);
      // If this is the citation limit trigger, log but continue
      if (msg.includes("引用が記事あたり上限")) {
        log("WARN", `[citygen] Citation limit reached: ${msg}`);
      } else {
        log("WARN", `[citygen] Citation insert failed: ${msg}`);
      }
    }
  }

  if (errors.length > 0) {
    log("WARN", `[citygen] ${errors.length} citation inserts had errors`);
  }

  log("INFO", `[citygen] Citations recorded: ${citationCount}/${values.length}`);
  return { articleId, citationCount };
}

// ---- Main generate function ----

export interface GenerateOptions {
  cityId: string;
  refCityId: string;
  outDir: string;
  mock?: MockData;
  post?: boolean;
  slug?: string;
}

export async function generateCityArticle(
  opts: GenerateOptions
): Promise<{ htmlPath: string; metaPath: string; postId?: number }> {
  const { cityId, refCityId, outDir, mock, post: doPost, slug } = opts;

  // 1. Fetch all data
  log("INFO", `[citygen] Fetching data for ${cityId} vs ${refCityId}`);
  const city = await getCity(cityId, mock);
  const refCity = await getRefCity(refCityId, mock);
  const values = await getValues(cityId, mock);
  const comparisons = await getComparisons(cityId, refCityId, mock);
  const findings = await getFindings(cityId, mock);
  const wageAnnual = await getWageAnnual(cityId, refCityId, mock);
  const sources = await getSources(mock);

  // Load language data from src/data/lang/{cityId}.json (same for mock and real DB)
  const language = loadLanguageData(cityId);

  log("INFO", `[citygen] Data: ${comparisons.length} comparisons, ${findings.length} findings, ${wageAnnual.length} wage rows, language=${!!language}`);

  // 2. Build LLM input
  const llmInput: LlmInput = { city, refCity, comparisons, findings, wageAnnual, values, language };
  const { system, user } = buildPrompt(llmInput);
  const allowedNumbers = buildAllowedNumbers(llmInput);

  // 3. Generate via Claude (sonnet) with validation gates
  log("INFO", `[citygen] Generating article body via ${CLAUDE_MODEL}`);
  let llmOutput: LlmOutput | null = null;
  let attempt = 0;
  let titleRetried = false;

  while (attempt < 2) {
    attempt++;
    const raw = await generateContent(system, user, 4096, CLAUDE_MODEL);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log("WARN", `[citygen] Attempt ${attempt}: No JSON found in LLM output`);
      if (attempt >= 2) throw new Error("LLM did not return valid JSON after 2 attempts");
      continue;
    }

    try {
      llmOutput = JSON.parse(jsonMatch[0]) as LlmOutput;
    } catch (e) {
      log("WARN", `[citygen] Attempt ${attempt}: JSON parse error: ${e}`);
      if (attempt >= 2) throw new Error("LLM JSON parse failed after 2 attempts");
      continue;
    }

    // 4a. Number validation gate
    const allText = [
      ...llmOutput.lead,
      ...llmOutput.sections.flatMap((s) => s.paragraphs),
      ...(llmOutput.languageParagraphs ?? []),
      ...llmOutput.fit,
      ...llmOutput.unfit,
    ].join(" ");

    const { valid, violations } = validateNumbers(allText, allowedNumbers);
    if (!valid) {
      log("WARN", `[citygen] Number validation FAILED (attempt ${attempt}): violations=[${violations.join(", ")}]`);
      if (attempt >= 2) {
        throw new Error(`Number validation failed after 2 attempts. Violations: ${violations.join(", ")}`);
      }
      llmOutput = null;
      continue;
    }

    log("INFO", `[citygen] Number validation PASSED (attempt ${attempt})`);

    // 4b. Title validation gate (one retry only)
    if (isGenericTitle(llmOutput.title) && !titleRetried) {
      log("WARN", `[citygen] Generic title detected: "${llmOutput.title}". Retrying once.`);
      titleRetried = true;
      llmOutput = null;
      continue;
    }
    if (isGenericTitle(llmOutput.title)) {
      log("WARN", `[citygen] Generic title persisted after retry: "${llmOutput.title}". Proceeding anyway.`);
    }

    break;
  }

  if (!llmOutput) throw new Error("LLM generation failed");

  // 5. Build SVGs
  const hero = heroSvg(city.flag_colors, city.landscape_ja, city.motif_en);

  const barRows: BarRow[] = comparisons
    .sort((a, b) => Math.abs(b.index_vs_ref - 100) - Math.abs(a.index_vs_ref - 100))
    .map((c) => ({
      label: METRIC_NAME[c.metric_id] ?? c.metric_id,
      index: c.index_vs_ref,
      highlight: c.flag_basis_mismatch || c.flag_spec_mismatch || c.flag_stat_mismatch,
      direction: c.direction,
    }));

  const compBars = comparisonBarsSvg(barRows, refCity.name_ja);

  // 5b. Location map and distance
  let mapSvgStr: string | undefined;
  let distance: number | undefined;
  if (city.lat != null && city.lon != null) {
    const mapResult: MapResult = locationMapSvg(city.lat, city.lon, city.name_ja, city.country_iso2);
    mapSvgStr = mapResult.svg;
    log("INFO", `[citygen] Location map: marker at ${mapResult.markerCenterPct.xPct.toFixed(1)}%/${mapResult.markerCenterPct.yPct.toFixed(1)}%, countries=[${mapResult.countriesInView.join(",")}]`);
    if (refCity.lat != null && refCity.lon != null) {
      distance = distanceKm(refCity.lat, refCity.lon, city.lat, city.lon);
      log("INFO", `[citygen] Distance: ${refCity.name_ja} → ${city.name_ja} = ${distance}km`);
    }
  } else {
    log("INFO", `[citygen] No coordinates for ${city.name_ja}, skipping location map`);
  }

  // 5c. City photos from Wikimedia Commons
  let photoCandidates: PhotoCandidate[] = [];
  const cityEnName = city.id.charAt(0).toUpperCase() + city.id.slice(1); // "prague" → "Prague"
  try {
    const { PIXBLOG_BASE_URL } = await import("../config.js");
    photoCandidates = await searchCityPhotos(cityEnName, city.name_ja, PIXBLOG_BASE_URL);
    log("INFO", `[citygen] Photos: ${photoCandidates.length} candidates uploaded`);
  } catch (e) {
    log("WARN", `[citygen] Photo search failed: ${e}`);
  }

  // 6. Build HTML components
  const compTable = buildComparisonTable(comparisons, city.name_ja, refCity.name_ja);

  const usedSourceIds = new Set<string>();
  usedSourceIds.add("jetro_cost");
  if (language) {
    usedSourceIds.add("ef_epi");
    usedSourceIds.add("eurobarometer");
  }

  const methodSection = buildMethodSection(usedSourceIds, sources, !!language);

  // 7. Assemble HTML
  const html = assembleHtml(
    llmOutput, hero, compBars, compTable, methodSection, city, refCity, !!language,
    {
      locationMapHtml: mapSvgStr,
      distanceKm: distance,
      photo: photoCandidates[0],
    }
  );

  // 8. Count JETRO figures used
  const allLlmText = [
    ...llmOutput.lead,
    ...llmOutput.sections.flatMap((s) => s.paragraphs),
  ].join(" ");
  const jetroCount = countJetroFigures(allLlmText, values);
  if (jetroCount > 8) {
    log("WARN", `[citygen] JETRO figures used: ${jetroCount} (exceeds limit of 8)`);
  } else {
    log("INFO", `[citygen] JETRO figures used: ${jetroCount}/8`);
  }

  // 9. Check for internal vocabulary leaks
  const internalVocab = ["index=", "basis_mismatch", "stat_mismatch", "spec_mismatch", "flag_", "v_comparison", "deviation="];
  const htmlLower = html.toLowerCase();
  for (const term of internalVocab) {
    if (htmlLower.includes(term.toLowerCase())) {
      log("WARN", `[citygen] Internal vocabulary leak detected in HTML: "${term}"`);
    }
  }

  // 10. Write output files
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, `${cityId}-draft.html`);
  const metaPath = path.join(outDir, `${cityId}-meta.json`);

  fs.writeFileSync(htmlPath, html);
  log("INFO", `[citygen] HTML written: ${htmlPath}`);

  const meta: Record<string, unknown> = {
    title: llmOutput.title,
    excerpt: llmOutput.excerpt,
    tags: [city.name_ja, city.country_ja, "都市データ", "移住", "生活コスト"],
    category: "都市データ",
    distance_km: distance ?? null,
    photo_candidates: photoCandidates.length > 0
      ? photoCandidates.map((p) => ({ url: p.pixblogUrl, artist: p.artist, license: p.license, commons_page: p.commonsPage }))
      : "none",
    jetro_figures_used: jetroCount,
    findings: findings.map((f) => ({
      metric: f.name_ja,
      index: f.index_vs_ref,
      kind: f.kind,
      needs_caveat: f.needs_caveat,
    })),
  };

  // 11. Post to PixBlog as draft (if --post)
  let postId: number | undefined;
  if (doPost) {
    if (!slug) throw new Error("--slug is required when --post is specified");

    const postResult = await postDraft(
      html,
      { title: llmOutput.title, excerpt: llmOutput.excerpt, tags: meta.tags as string[] },
      slug
    );
    postId = postResult.id;
    meta.post_id = postId;
    meta.url = postResult.url;

    // Record article and citations in pixdata
    try {
      const { articleId, citationCount } = await recordArticleAndCitations(
        postId, cityId, llmOutput.title, values
      );
      meta.pixdata_article_id = articleId;
      meta.citation_count = citationCount;
    } catch (e) {
      log("ERROR", `[citygen] Failed to record article/citations in pixdata: ${e}`);
      log("INFO", `[citygen] Draft was posted (post_id=${postId}) but DB recording failed`);
      meta.pixdata_error = String(e);
    }
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  log("INFO", `[citygen] Meta written: ${metaPath}`);

  return { htmlPath, metaPath, postId };
}
