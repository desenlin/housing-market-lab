export type CpiArea = "la" | "us";
export type InflationView = "yoy" | "cumulative";
export type InflationCategory = { key: string; label: string; code: string; description: string };
export type CpiSourceFile = { url: string; method: "bulk" | "api"; sha256: string; series_ids: string[]; start_year?: number; end_year?: number };

export type CpiSeries = {
  key: string;
  id: string;
  label: string;
  long_label: string;
  area: string;
  coverage: string;
  seasonal_adjustment: string;
  frequency: string;
  unit: string;
  dates: string[];
  values: (number | null)[];
  yoy: (number | null)[];
  latest_observation: string;
  missing_observations: string[];
  area_key?: CpiArea;
  category?: string;
};

export type CpiInterpolationRule = {
  month: string;
  method: "log_linear";
  reason: string;
};

export type CpiDataset = {
  provider: string;
  frequency: string;
  data_page: string;
  categories?: InflationCategory[];
  real_value_interpolation?: CpiInterpolationRule[];
  series: Record<string, CpiSeries>;
};

export type CpiManifest = {
  release: string;
  created_at: string;
  provider: string;
  attribution: string;
  data_page: string;
  frequency: string;
  real_value_interpolation?: CpiInterpolationRule[];
  source_files?: CpiSourceFile[];
  bundle_sha256: string;
  series: Record<string, {
    id: string;
    label: string;
    latest_observation: string;
    missing_observations: string[];
  }>;
};


export const CPI_AREAS: Record<CpiArea, string> = { la: "LA & Orange counties", us: "United States" };
export const INFLATION_DEFINITIONS = {
  yoy: "Percentage change from the same month one year earlier. A lower positive rate means prices are still rising, but more slowly.",
  cumulative: "Percentage change since the selected starting month. The starting month changes the comparison period; changing the chart window only changes what is visible.",
  geography: "The LA-area CPI covers Los Angeles and Orange counties together. It does not provide separate county, city or ZIP-code inflation rates. The U.S. city average provides a national benchmark.",
  categories: "Headline, core and component indexes overlap. Food includes groceries and dining; energy includes gasoline. Their inflation rates cannot be added together.",
};
export const INFLATION_STYLES: Record<string, { color: string; dash?: string }> = {
  all: { color: "var(--chart-2)" }, core: { color: "var(--chart-overlay)", dash: "6 3" },
  food: { color: "var(--chart-3)" }, grocery: { color: "var(--chart-3)", dash: "6 3" },
  dining: { color: "var(--chart-3)", dash: "2 3" }, energy: { color: "var(--chart-1)" },
  gasoline: { color: "var(--chart-1)", dash: "6 3" }, shelter: { color: "var(--chart-4)" },
  rent: { color: "var(--chart-4)", dash: "6 3" }, nonshelter: { color: "var(--chart-5)" },
};
export function inflationSeriesKey(area: CpiArea, category: string) {
  return category === "all" ? area : `${area}_${category}`;
}

export function inflationValues(series: Pick<CpiSeries, "dates" | "values">, view: InflationView, baseMonth: string) {
  const byMonth = new Map(series.dates.map((date, index) => [date.slice(0, 7), series.values[index]]));
  return series.dates.map((date, index) => {
    const value = series.values[index];
    const previousMonth = `${Number(date.slice(0, 4)) - 1}${date.slice(4, 7)}`;
    const base = byMonth.get(view === "yoy" ? previousMonth : baseMonth);
    return value != null && base != null && base > 0 ? value / base - 1 : null;
  });
}

export function commonInflationMonths(series: CpiSeries[]) {
  if (!series.length) return [];
  const observed = series.map(item => new Set(item.dates.filter((_, index) => item.values[index] != null).map(date => date.slice(0, 7))));
  return [...observed[0]].filter(month => observed.every(months => months.has(month))).sort();
}

export function toggleInflationCategory(selected: string[], key: string, limit = 5) {
  return selected.includes(key) ? selected.filter(item => item !== key) : selected.length < limit ? [...selected, key] : selected;
}

export function inflationDate(month: string) {
  return month ? new Date(`${month.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "Unavailable";
}
export function inflationRate(value: number | null) {
  return value == null ? "—" : new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value) < 0.0005 ? 0 : value);
}
