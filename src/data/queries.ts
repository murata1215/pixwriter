/**
 * Data queries for city profile generation.
 * Each function accepts optional mockData to bypass DB access.
 */
import { query } from "./db.js";

// ---- Types ----

export interface CityRow {
  id: string;
  name_ja: string;
  country_ja: string;
  country_iso2: string;
  currency: string;
  flag_colors: string[];
  landscape_ja: string | null;
  motif_en: string | null;
}

export interface ValueRow {
  id: number;
  city_id: string;
  metric_id: string;
  survey_id: string;
  category: string;
  unit: string;
  is_rate: boolean;
  direction: string | null;
  val_low: number;
  val_high: number;
  val_mid: number;
  val_base: number | null;
  currency: string | null;
  basis: string | null;
  bonus_months: number | null;
  stat: string | null;
  sample_n: number | null;
  spec_area_sqm: number | null;
  definition_note: string | null;
  as_of: string | null;
  source_id: string;
  license: string;
  max_figures_per_article: number | null;
}

export interface ComparisonRow {
  city_id: string;
  ref_city_id: string;
  metric_id: string;
  val_base: number;
  ref_val_base: number;
  index_vs_ref: number;
  direction: string | null;
  flag_basis_mismatch: boolean;
  flag_stat_mismatch: boolean;
  flag_source_mismatch: boolean;
  flag_period_gap: boolean;
  flag_spec_mismatch: boolean;
  definition_note: string | null;
  ref_definition_note: string | null;
}

export interface FindingRow {
  city_id: string;
  ref_city_id: string;
  metric_id: string;
  name_ja: string;
  index_vs_ref: number;
  kind: "much_lower" | "much_higher";
  deviation: number;
  needs_caveat: boolean;
}

export interface WageAnnualRow {
  city_id: string;
  metric_id: string;
  survey_id: string;
  monthly_base: number;
  annual_base: number;
  basis: string | null;
  bonus_months: number | null;
  stat: string | null;
  sample_n: number | null;
}

export interface SourceRow {
  id: string;
  name_ja: string;
  publisher_ja: string;
  license: string;
  attribution_ja: string | null;
  max_figures_per_article: number | null;
}

export interface EfEpiRow {
  country: string;
  rank: number;
  score: number;
  band: string;
}

export interface LanguageData {
  official_language_ja: string;
  ef_epi: {
    year: number;
    note: string;
    rows: EfEpiRow[];
  };
  eurobarometer: {
    survey: string;
    eu_english_conversational_pct: number;
    eu_youth_english_pct: number;
    note: string;
  };
  japanese_infra: {
    japanese_school: boolean;
    note: string;
  };
}

export interface MockData {
  city: CityRow;
  refCity: CityRow;
  values: ValueRow[];
  comparisons: ComparisonRow[];
  findings: FindingRow[];
  wageAnnual: WageAnnualRow[];
  sources: SourceRow[];
  language?: LanguageData;
}

// ---- Helpers: PostgreSQL numeric → JavaScript number ----
// node-postgres returns numeric columns as strings. These helpers cast them.

function num(v: unknown): number {
  if (v == null) return 0;
  return Number(v);
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function castValueRow(r: Record<string, unknown>): ValueRow {
  return {
    ...r,
    id: num(r.id),
    val_low: num(r.val_low),
    val_high: num(r.val_high),
    val_mid: num(r.val_mid),
    val_base: numOrNull(r.val_base),
    bonus_months: numOrNull(r.bonus_months),
    sample_n: numOrNull(r.sample_n),
    spec_area_sqm: numOrNull(r.spec_area_sqm),
    max_figures_per_article: numOrNull(r.max_figures_per_article),
  } as ValueRow;
}

function castComparisonRow(r: Record<string, unknown>): ComparisonRow {
  return {
    ...r,
    val_base: num(r.val_base),
    ref_val_base: num(r.ref_val_base),
    index_vs_ref: num(r.index_vs_ref),
  } as ComparisonRow;
}

function castFindingRow(r: Record<string, unknown>): FindingRow {
  return {
    ...r,
    index_vs_ref: num(r.index_vs_ref),
    deviation: num(r.deviation),
  } as FindingRow;
}

function castWageAnnualRow(r: Record<string, unknown>): WageAnnualRow {
  return {
    ...r,
    monthly_base: num(r.monthly_base),
    annual_base: num(r.annual_base),
    bonus_months: numOrNull(r.bonus_months),
    sample_n: numOrNull(r.sample_n),
  } as WageAnnualRow;
}

function castSourceRow(r: Record<string, unknown>): SourceRow {
  return {
    ...r,
    max_figures_per_article: numOrNull(r.max_figures_per_article),
  } as SourceRow;
}

// ---- Query functions ----

export async function getCity(cityId: string, mock?: MockData): Promise<CityRow> {
  if (mock) return mock.city;
  const rows = await query<CityRow>(
    "SELECT id, name_ja, country_ja, country_iso2, currency, flag_colors, landscape_ja, motif_en FROM city WHERE id = $1",
    [cityId]
  );
  if (rows.length === 0) throw new Error(`City not found: ${cityId}`);
  return rows[0];
}

export async function getRefCity(refCityId: string, mock?: MockData): Promise<CityRow> {
  if (mock) return mock.refCity;
  return getCity(refCityId);
}

export async function getValues(cityId: string, mock?: MockData): Promise<ValueRow[]> {
  if (mock) return mock.values;
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM v_value WHERE city_id = $1",
    [cityId]
  );
  return rows.map(castValueRow);
}

export async function getComparisons(cityId: string, refCityId: string, mock?: MockData): Promise<ComparisonRow[]> {
  if (mock) return mock.comparisons;
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM v_comparison WHERE city_id = $1 AND ref_city_id = $2",
    [cityId, refCityId]
  );
  return rows.map(castComparisonRow);
}

export async function getFindings(cityId: string, mock?: MockData): Promise<FindingRow[]> {
  if (mock) return mock.findings;
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM v_finding_candidate WHERE city_id = $1 ORDER BY deviation DESC",
    [cityId]
  );
  return rows.map(castFindingRow);
}

export async function getWageAnnual(cityId: string, refCityId: string, mock?: MockData): Promise<WageAnnualRow[]> {
  if (mock) return mock.wageAnnual;
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM v_wage_annual WHERE city_id IN ($1, $2)",
    [cityId, refCityId]
  );
  return rows.map(castWageAnnualRow);
}

export async function getSources(mock?: MockData): Promise<SourceRow[]> {
  if (mock) return mock.sources;
  const rows = await query<Record<string, unknown>>(
    "SELECT id, name_ja, publisher_ja, license, attribution_ja, max_figures_per_article FROM source"
  );
  return rows.map(castSourceRow);
}
