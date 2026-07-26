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
  return query<ValueRow>(
    "SELECT * FROM v_value WHERE city_id = $1",
    [cityId]
  );
}

export async function getComparisons(cityId: string, refCityId: string, mock?: MockData): Promise<ComparisonRow[]> {
  if (mock) return mock.comparisons;
  return query<ComparisonRow>(
    "SELECT * FROM v_comparison WHERE city_id = $1 AND ref_city_id = $2",
    [cityId, refCityId]
  );
}

export async function getFindings(cityId: string, mock?: MockData): Promise<FindingRow[]> {
  if (mock) return mock.findings;
  return query<FindingRow>(
    "SELECT * FROM v_finding_candidate WHERE city_id = $1 ORDER BY deviation DESC",
    [cityId]
  );
}

export async function getWageAnnual(cityId: string, refCityId: string, mock?: MockData): Promise<WageAnnualRow[]> {
  if (mock) return mock.wageAnnual;
  return query<WageAnnualRow>(
    "SELECT * FROM v_wage_annual WHERE city_id IN ($1, $2)",
    [cityId, refCityId]
  );
}

export async function getSources(mock?: MockData): Promise<SourceRow[]> {
  if (mock) return mock.sources;
  return query<SourceRow>(
    "SELECT id, name_ja, publisher_ja, license, attribution_ja, max_figures_per_article FROM source"
  );
}
