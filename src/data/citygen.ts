/**
 * City profile article generator (B-article).
 * Reads data from pixdata DB (or mock), generates article body via Claude,
 * validates numbers, assembles self-contained HTML.
 */
import fs from "node:fs";
import path from "node:path";
import { generateContent } from "../claude-api.js";
import { CLAUDE_MODEL } from "../config.js";
import { log } from "../logger.js";
import type {
  MockData,
  CityRow,
  ComparisonRow,
  FindingRow,
  WageAnnualRow,
  ValueRow,
  SourceRow,
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

// ---- Metric name map ----
const METRIC_NAME: Record<string, string> = {
  tax_vat: "付加価値税",
  tax_income_max: "個人所得税(最高税率)",
  tax_corp: "法人所得税",
  petrol: "ガソリン",
  diesel: "軽油",
  rent_expat: "駐在員住宅",
  wage_worker: "ワーカー賃金",
  wage_engineer: "エンジニア賃金",
  wage_manager: "管理職賃金",
  elec_household: "電気(一般用)",
  si_employee: "社会保険(被雇用者)",
};

// ---- LLM prompt ----

interface LlmInput {
  city: CityRow;
  refCity: CityRow;
  comparisons: ComparisonRow[];
  findings: FindingRow[];
  wageAnnual: WageAnnualRow[];
  values: ValueRow[];
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
  fit: string[];
  unfit: string[];
}

function buildPrompt(input: LlmInput): { system: string; user: string } {
  const { city, refCity, comparisons, findings, wageAnnual, values } = input;

  // Build comparison table text
  const compTable = comparisons
    .sort((a, b) => Math.abs(b.index_vs_ref - 100) - Math.abs(a.index_vs_ref - 100))
    .map((c) => {
      const flags: string[] = [];
      if (c.flag_basis_mismatch) flags.push("basis_mismatch");
      if (c.flag_stat_mismatch) flags.push("stat_mismatch");
      if (c.flag_spec_mismatch) flags.push("spec_mismatch");
      const flagStr = flags.length > 0 ? ` [FLAGS: ${flags.join(",")}]` : "";
      const notes = [c.definition_note, c.ref_definition_note].filter(Boolean).join(" / ");
      return `- ${METRIC_NAME[c.metric_id] ?? c.metric_id}: index=${c.index_vs_ref} (${city.name_ja}=${c.val_base}, ${refCity.name_ja}=${c.ref_val_base})${flagStr}\n  注記: ${notes}`;
    })
    .join("\n");

  // Build wage annual text
  const wageText = wageAnnual
    .map((w) => {
      const bonusInfo = w.bonus_months ? ` 賞与${w.bonus_months}ヶ月含む年収換算` : " 賞与込み年額";
      return `- ${w.city_id} / ${METRIC_NAME[w.metric_id] ?? w.metric_id}: 月額USD${w.monthly_base.toFixed(0)}, 年額USD${w.annual_base.toFixed(0)} (${w.basis}${bonusInfo}, ${w.stat})`;
    })
    .join("\n");

  // Build findings text
  const findingsText = findings
    .map((f) => `- ${f.name_ja}: index=${f.index_vs_ref} (${f.kind}, deviation=${f.deviation})${f.needs_caveat ? " ⚠要注記" : ""}`)
    .join("\n");

  const system = `あなたは都市比較記事の執筆者です。以下のルールを厳守してください。

【絶対ルール】
1. 提供された数値以外の数字を一切書かない。年号・統計値・順位等を創作してはならない。
2. 各セクションは提供データの範囲で書く。データにない主張をしない。
3. flag (basis_mismatch, stat_mismatch, spec_mismatch) が立っている比較には、必ず注記（definition_noteの内容）を本文に織り込む。「ただし定義が異なる」等の但し書きを入れる。
4. 体験談・感想は書かない。筆者は現地に住んだことがない前提。
5. 文体は「だ・である」調。断定と留保を使い分ける。数字で言えることに徹する。
6. 各段落は短く（3-5文）。

【出力形式】
以下のJSON形式で返してください（他の文章は不要）:
{
  "title": "記事タイトル（都市名を含む、40字以内）",
  "excerpt": "検索スニペット用の説明（100-160字）",
  "lead": ["リード段落1", "リード段落2", "リード段落3"],
  "sections": [
    {
      "heading": "セクション見出し（番号付き）",
      "sourceNote": "SOURCE — 出典名",
      "paragraphs": ["段落1", "段落2"]
    }
  ],
  "fit": ["向く条件1", "向く条件2", "向く条件3"],
  "unfit": ["向かない条件1", "向かない条件2", "向かない条件3"]
}

セクション数は3-5個。各セクションは比較データの中から1-2個の指標にフォーカスし、その数値が何を意味するかを解説する。`;

  const user = `以下のデータから、${city.name_ja}（${city.country_ja}）の都市プロファイル記事を生成してください。
比較基準都市: ${refCity.name_ja}

## 比較テーブル（${refCity.name_ja}=100としたindex）
${compTable}

## 発見候補（deviation降順）
${findingsText}

## 賃金の年収換算
${wageText}

## 補足
- 比較はすべて同一調査（ジェトロ2025年度投資関連コスト比較調査）内で行っている
- 電気(一般用)は${refCity.name_ja}で未調査のため比較なし。${city.name_ja}の値は0.36 USD/kWh
- 社会保険被雇用者負担: ${city.name_ja}=11.6%
- flag付きの比較は、本文中で必ず非対称性を注記すること`;

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
    // Add exact, rounded variants
    allowed.add(String(n));
    allowed.add(n.toFixed(0));
    allowed.add(n.toFixed(1));
    allowed.add(n.toFixed(2));
    // Comma-formatted
    if (n >= 1000) {
      allowed.add(n.toLocaleString("en-US"));
    }
  };

  for (const c of input.comparisons) {
    addNum(c.index_vs_ref);
    addNum(c.val_base);
    addNum(c.ref_val_base);
    // Allow ratio expressions: index/100 → e.g. 210 → 2.1 ("2.1倍")
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
    // Extract numbers from definition_note (e.g. "107-175m2" → 107, 175)
    if (v.definition_note) {
      const noteNums = v.definition_note.match(/[\d,]+(?:\.\d+)?/g) ?? [];
      for (const nn of noteNums) addNum(parseFloat(nn.replace(/,/g, "")));
    }
  }
  // Also extract numbers from comparison definition_notes
  for (const c of input.comparisons) {
    for (const note of [c.definition_note, c.ref_definition_note]) {
      if (note) {
        const noteNums = note.match(/[\d,]+(?:\.\d+)?/g) ?? [];
        for (const nn of noteNums) addNum(parseFloat(nn.replace(/,/g, "")));
      }
    }
  }

  // Allow cross-value derived ratios: LLM may express index as "X.X倍"
  // or compute area/wage ratios between the two cities
  for (const c of input.comparisons) {
    if (c.val_base > 0 && c.ref_val_base > 0) {
      addNum(c.val_base / c.ref_val_base);
      addNum(c.ref_val_base / c.val_base);
    }
  }
  // Spec area values from definition_notes (nagoya 55.32m2 etc.)
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
  // Allow wage ratios between cities
  const wageVals = input.wageAnnual.map((w) => w.annual_base);
  for (const a of wageVals) {
    for (const b of wageVals) {
      if (a !== b && b > 0) addNum(a / b);
    }
  }

  // Allow common small numbers, years, months, days
  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  for (let y = 2020; y <= 2030; y++) allowed.add(String(y));
  // Allow percentages already in data
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
    // Check +-5% tolerance (LLM naturally rounds when expressing ratios)
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
      if (c.flag_basis_mismatch) flags.push("定義差あり");
      if (c.flag_spec_mismatch) flags.push("面積差あり");
      if (c.flag_stat_mismatch) flags.push("統計手法差あり");
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

function buildMethodSection(sources: SourceRow[]): string {
  const sourceRows = sources
    .filter((s) => s.attribution_ja)
    .map((s) => `<tr><td>${s.name_ja}</td><td>${s.attribution_ja}</td></tr>`)
    .join("\n");

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
<li>ビザ・在留資格は頻繁に変わるため本記事では扱っていません</li>
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
  refCity: CityRow
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

  // Read the CSS from the reference article
  const css = getReferenceCss();

  return `<div class="iju-post">
${css}
<div class="hero">
${heroSvgStr}
</div>

<div class="wrap">

<div class="eyebrow"><b>都市データ</b><span>${city.country_ja} / ${city.name_ja}</span></div>

${leadHtml}

<div class="byline">
  <span>公的統計をもとに構成</span><span>体験談を含みません</span><span>${today}</span>
</div>

<figure>
${compBarsSvgStr}
<figcaption><b>FIG.1</b>　${refCity.name_ja}を100としたときの${city.name_ja}の水準。比率は現地通貨ベースで算出。</figcaption>
</figure>

${compTableHtml}

${sectionsHtml}

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
  // Extract <style>...</style> from the reference article
  try {
    const refPath = "/opt/pixdata/doc/B-budapest-pixblog.html";
    const content = fs.readFileSync(refPath, "utf-8");
    const match = content.match(/<style>[\s\S]*?<\/style>/);
    if (match) return match[0];
  } catch {
    // Fallback: return empty style
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

// ---- Main generate function ----

export async function generateCityArticle(
  cityId: string,
  refCityId: string,
  outDir: string,
  mock?: MockData
): Promise<{ htmlPath: string; metaPath: string }> {
  // 1. Fetch all data
  log("INFO", `[citygen] Fetching data for ${cityId} vs ${refCityId}`);
  const city = await getCity(cityId, mock);
  const refCity = await getRefCity(refCityId, mock);
  const values = await getValues(cityId, mock);
  const comparisons = await getComparisons(cityId, refCityId, mock);
  const findings = await getFindings(cityId, mock);
  const wageAnnual = await getWageAnnual(cityId, refCityId, mock);
  const sources = await getSources(mock);

  log("INFO", `[citygen] Data: ${comparisons.length} comparisons, ${findings.length} findings, ${wageAnnual.length} wage rows`);

  // 2. Build LLM input
  const llmInput: LlmInput = { city, refCity, comparisons, findings, wageAnnual, values };
  const { system, user } = buildPrompt(llmInput);
  const allowedNumbers = buildAllowedNumbers(llmInput);

  // 3. Generate via Claude (sonnet)
  log("INFO", `[citygen] Generating article body via ${CLAUDE_MODEL}`);
  let llmOutput: LlmOutput | null = null;
  let attempt = 0;

  while (attempt < 2) {
    attempt++;
    const raw = await generateContent(system, user, 4096, CLAUDE_MODEL);

    // Parse JSON
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

    // 4. Number validation gate
    const allText = [
      ...llmOutput.lead,
      ...llmOutput.sections.flatMap((s) => s.paragraphs),
      ...llmOutput.fit,
      ...llmOutput.unfit,
    ].join(" ");

    const { valid, violations } = validateNumbers(allText, allowedNumbers);
    if (valid) {
      log("INFO", `[citygen] Number validation PASSED (attempt ${attempt})`);
      break;
    } else {
      log("WARN", `[citygen] Number validation FAILED (attempt ${attempt}): violations=[${violations.join(", ")}]`);
      if (attempt >= 2) {
        throw new Error(
          `Number validation failed after 2 attempts. Violations: ${violations.join(", ")}`
        );
      }
      llmOutput = null; // retry
    }
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
    }));

  const compBars = comparisonBarsSvg(barRows, refCity.name_ja);

  // 6. Build HTML table and method section
  const compTable = buildComparisonTable(comparisons, city.name_ja, refCity.name_ja);
  const methodSection = buildMethodSection(sources);

  // 7. Assemble HTML
  const html = assembleHtml(llmOutput, hero, compBars, compTable, methodSection, city, refCity);

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

  // 9. Write output
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, `${cityId}-draft.html`);
  const metaPath = path.join(outDir, `${cityId}-meta.json`);

  fs.writeFileSync(htmlPath, html);
  log("INFO", `[citygen] HTML written: ${htmlPath}`);

  const meta = {
    title: llmOutput.title,
    excerpt: llmOutput.excerpt,
    tags: [city.name_ja, city.country_ja, "都市データ", "移住", "生活コスト"],
    category: "都市データ",
    jetro_figures_used: jetroCount,
    findings: findings.map((f) => ({
      metric: f.name_ja,
      index: f.index_vs_ref,
      kind: f.kind,
      needs_caveat: f.needs_caveat,
    })),
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  log("INFO", `[citygen] Meta written: ${metaPath}`);

  return { htmlPath, metaPath };
}
