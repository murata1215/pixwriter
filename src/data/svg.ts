/**
 * SVG generators for city profile articles.
 * Pure functions — no LLM, no I/O.
 */

const MONO = "IBM Plex Mono, monospace";
const GOTHIC = "Zen Kaku Gothic New, sans-serif";

// ---- Hero SVG ----

export function heroSvg(
  flagColors: string[],
  landscapeJa: string | null,
  motifEn: string | null
): string {
  const c0 = flagColors[0] ?? "#666";
  const c1 = flagColors[1] ?? "#F4F1EC";
  const c2 = flagColors[2] ?? "#888";

  // Darken the bottom color slightly for detail lines
  const darkLine = darken(c2, 30);

  return `<svg viewBox="0 0 1200 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${landscapeJa ?? "都市"}のキービジュアル">
<rect width="1200" height="480" fill="${c1}"/>
<rect width="1200" height="70" fill="${c0}"/>
<circle cx="410" cy="366" r="80" fill="${lighten(c1, 5)}"/>
<rect y="378" width="1200" height="102" fill="${c2}"/>
<rect y="374" width="1200" height="5" fill="${darkLine}"/>
${motifEn?.includes("spire") ? spireMotifs(darkLine) : genericMotifs(darkLine)}
<rect y="412" width="1200" height="4" fill="${darkLine}"/>
<rect y="446" width="1200" height="4" fill="${darkLine}"/>
</svg>`;
}

function spireMotifs(color: string): string {
  return `<rect x="280" y="260" width="6" height="118" fill="${color}"/>
<polygon points="283,230 260,320 306,320" fill="${color}" opacity=".35"/>
<rect x="580" y="280" width="8" height="98" fill="${color}"/>
<polygon points="584,250 558,340 610,340" fill="${color}" opacity=".35"/>
<rect x="820" y="300" width="5" height="78" fill="${color}"/>
<polygon points="822,275 804,340 841,340" fill="${color}" opacity=".35"/>`;
}

function genericMotifs(color: string): string {
  return `<rect x="196" y="322" width="6" height="56" fill="${color}"/>
<rect x="152" y="322" width="50" height="6" fill="${color}"/>
<rect x="202" y="339" width="40" height="6" fill="${color}"/>
<rect x="672" y="272" width="8" height="106" fill="${color}"/>
<rect x="600" y="272" width="80" height="8" fill="${color}"/>
<rect x="680" y="300" width="62" height="8" fill="${color}"/>
<rect x="964" y="336" width="6" height="42" fill="${color}"/>
<rect x="928" y="336" width="42" height="6" fill="${color}"/>
<rect x="970" y="349" width="30" height="6" fill="${color}"/>`;
}

// ---- Comparison bars SVG (FIG.1 style) ----

export interface BarRow {
  label: string;
  index: number;             // index_vs_ref (100 = same as ref)
  highlight: boolean;        // needs_caveat or significant deviation
  direction: string | null;  // "lower_better" | "higher_better" | "neutral"
}

/**
 * Determine bar color based on direction semantics:
 * - lower_better (tax, rent, fuel): above 100 = RED (worse), below 100 = GREEN (better)
 * - higher_better (wage):           above 100 = GREEN (better), below 100 = RED (worse)
 * - neutral / null:                 GREY
 */
function barColor(diff: number, direction: string | null): string {
  const GREEN = "#436F4D";
  const RED = "#CD2A3E";
  const NEUTRAL = "#9AA39E";

  if (Math.abs(diff) <= 3) return NEUTRAL;

  switch (direction) {
    case "lower_better":
      return diff > 0 ? RED : GREEN;
    case "higher_better":
      return diff > 0 ? GREEN : RED;
    default:
      return NEUTRAL;
  }
}

export function comparisonBarsSvg(rows: BarRow[], refCityName: string): string {
  const baseX = 280;           // increased from 210 for wider left margin
  const rowH = 46;
  const barH = 28;
  const yStart = 58;
  const maxBarW = 350;         // cap bar width to prevent overflow
  const scale = 1.5;           // pixels per index point
  const chartH = yStart + rows.length * rowH + 70;

  const bars = rows.map((r, i) => {
    const y = yStart + i * rowH;
    const barY = y - 14;
    const diff = r.index - 100;
    const rawW = Math.abs(diff) * scale;
    const w = Math.min(rawW, maxBarW);
    const color = barColor(diff, r.direction);

    let barX: number, numX: number, numAnchor: string;
    if (diff >= 0) {
      barX = baseX;
      numX = baseX + w + 8;
      numAnchor = "start";
    } else {
      barX = baseX - w;
      numX = baseX + 8;       // number goes RIGHT of baseline (not left, avoiding label overlap)
      numAnchor = "start";
    }

    return `<text x="16" y="${y}" font-family="${GOTHIC}" font-size="13.5" fill="#16181C">${esc(r.label)}</text>
<rect x="${barX}" y="${barY}" width="${Math.max(w, 4)}" height="${barH}" fill="${color}"/>
<text x="${numX}" y="${y}" text-anchor="${numAnchor}" font-family="${MONO}" font-size="13" font-weight="500" fill="${color}">${r.index}</text>`;
  }).join("\n");

  const noteY = yStart + rows.length * rowH + 12;
  const legendY = noteY + 18;

  return `<svg viewBox="0 0 680 ${chartH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(refCityName)}を100としたときの比較">
<line x1="${baseX}" y1="${yStart - 20}" x2="${baseX}" y2="${yStart + rows.length * rowH - 10}" stroke="#16181C" stroke-width="1.5"/>
<text x="${baseX}" y="${yStart - 28}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="#6B7079">${esc(refCityName)}=100</text>
${bars}
<text x="16" y="${noteY}" font-family="${MONO}" font-size="11" fill="#6B7079">比率は現地通貨ベースで算出（率はそのまま比較）</text>
<rect x="16" y="${legendY - 9}" width="10" height="10" rx="1" fill="#CD2A3E"/>
<text x="30" y="${legendY}" font-family="${MONO}" font-size="10.5" fill="#6B7079">移住者に不利</text>
<rect x="120" y="${legendY - 9}" width="10" height="10" rx="1" fill="#436F4D"/>
<text x="134" y="${legendY}" font-family="${MONO}" font-size="10.5" fill="#6B7079">有利（${esc(refCityName)}比）</text>
</svg>`;
}

// ---- Helpers ----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r - amount, g - amount, b - amount);
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amount, g + amount, b + amount);
}
