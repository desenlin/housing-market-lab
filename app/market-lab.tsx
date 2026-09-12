"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Cell,
  Legend,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Check, Copy, ExternalLink, Info, Plus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PermitPanel, type PermitManifest } from "@/components/permits/permit-panel";
import { AcsPanel, type AcsManifestSummary } from "@/components/acs/acs-panel";
import { FactEnginePanel } from "@/components/facts/fact-engine-panel";
import { FigureAttribution, type FigureSource } from "@/components/figure-attribution";
import { DEFAULT_MAP_FIT_OPTIONS, focusedMapBounds } from "@/lib/map-view";

type Value = number | null;
type MetricKey =
  | "zhvi"
  | "zori"
  | "price_rent"
  | "inventory"
  | "days_pending"
  | "price_cut_share"
  | "sale_to_list"
  | "months_supply"
  | "median_dom"
  | "sold_above_original_share"
  | "price_drop_share"
  | "median_sale_ppsf"
  | "active_listing_count"
  | "new_listing_count"
  | "pending_ratio"
  | "hotness_score"
  | "viewer_ratio"
  | "demand_score"
  | "supply_score"
  | "realtor_median_dom";
type ViewKey = "level" | "yoy" | "index";
type ChangeMode = "percent" | "difference" | "percentage_point";
type TimeRange = "1y" | "3y" | "5y" | "max";
type RankKey = "growth" | "level";
type MapPaletteKey = "navy" | "orange";
type PriceBasis = "nominal" | "real";
type CpiSeriesKey = "la" | "us";
type ActivityLens = "redfin" | "realtor";

type Metric = {
  dates: string[];
  label: string;
  short_label: string;
  unit: string;
  decimals: number;
  definition: string;
  provider?: string;
  frequency?: string;
  source_product?: "inventory" | "hotness";
  change_mode?: ChangeMode;
};

type Region = {
  id: string;
  name: string;
  county: string | null;
  context: string | null;
  census_region?: "Northeast" | "Midwest" | "South" | "West";
  division?: string;
  population_rank?: number;
  selection_note?: string;
  role?: "focus" | "nearby";
  series: Record<string, Value[] | { o: number; v: Value[] }>;
  quality?: Partial<Record<"inventory" | "hotness", number[]>>;
};

type Dataset = {
  geography: "city" | "zip" | "metro";
  metrics: Record<string, Metric>;
  regions: Region[];
};

type MapData = {
  geography: "city" | "zip";
  counties: Record<
    string,
    {
      bounds: [[number, number], [number, number]];
      mapped: number;
      available: number;
      boundaries?: number;
      regions: {
        id: string;
        name: string;
        county?: string;
        geometry: {
          type: "Polygon" | "MultiPolygon";
          coordinates: unknown;
        };
      }[];
    }
  >;
};

type Manifest = {
  release: string;
  created_at: string;
  provider: string;
  attribution: string;
  data_page: string;
  bundle_sha256: string;
  storage_schema_version?: number;
  files?: Partial<Record<"city" | "zip" | "metro", string[]>>;
  latest_observations: Record<string, string>;
  counts: Record<string, number>;
  map_coverage: Record<
    string,
    Record<string, { mapped: number; available: number; boundaries?: number }>
  >;
  sources: Record<
    string,
    { url: string; bytes: number; latest_observation: string; regions: number }
  >;
};

type RedfinManifest = Manifest & {
  methodology_page: string;
  frequency: string;
  start_date: string;
};

type RealtorManifest = {
  schema_version: number;
  release: string;
  created_at: string;
  provider: string;
  product: "inventory" | "hotness";
  attribution: string;
  data_page: string;
  methodology_page: string;
  frequency: string;
  start_date: string;
  bundle_sha256: string;
  storage_schema_version?: number;
  files?: { zip?: string[] };
  counts: { zip: number };
  latest_observations: Record<string, string>;
  retained_releases: number;
  source: {
    url: string;
    bytes: number;
    etag: string;
    last_modified: string;
    latest_observation: string;
    rows_scanned: number;
    regions: number;
    flagged_local_rows_retained: number;
  };
};

type CpiSeries = {
  key: CpiSeriesKey;
  id: string;
  label: string;
  long_label: string;
  area: string;
  coverage: string;
  seasonal_adjustment: string;
  frequency: string;
  unit: string;
  dates: string[];
  values: Value[];
  yoy: Value[];
  latest_observation: string;
  missing_observations: string[];
};

type CpiInterpolationRule = {
  month: string;
  method: "log_linear";
  reason: string;
};

type CpiDataset = {
  provider: string;
  frequency: string;
  data_page: string;
  real_value_interpolation?: CpiInterpolationRule[];
  series: Record<CpiSeriesKey, CpiSeries>;
};

type CpiManifest = {
  release: string;
  created_at: string;
  provider: string;
  attribution: string;
  data_page: string;
  frequency: string;
  real_value_interpolation?: CpiInterpolationRule[];
  bundle_sha256: string;
  series: Record<CpiSeriesKey, {
    id: string;
    label: string;
    latest_observation: string;
    missing_observations: string[];
  }>;
};

type PriceAdjustment = {
  basis: PriceBasis;
  cpi: CpiSeries | null;
  baseMonth: string;
  interpolationRules?: CpiInterpolationRule[];
};

type ChartOverlay = {
  id: string;
  label: string;
  dates: string[];
  values: Value[];
  color: string;
  dashed?: boolean;
};

const COUNTY_OPTIONS = ["Orange County", "Los Angeles County", "Both"];
const LOCAL_METRICS: { key: MetricKey; label: string }[] = [
  { key: "zhvi", label: "Typical home value" },
  { key: "zori", label: "Typical observed rent" },
  { key: "price_rent", label: "Price–rent multiple" },
];
const REGIONAL_METRICS: { key: MetricKey; label: string }[] = [
  { key: "zhvi", label: "Typical home value" },
  { key: "zori", label: "Typical observed rent" },
  { key: "inventory", label: "For-sale inventory" },
  { key: "days_pending", label: "Median days to pending" },
  { key: "price_cut_share", label: "Listings with a price cut" },
  { key: "sale_to_list", label: "Mean sale-to-list ratio" },
];
const ACTIVITY_METRICS: { key: MetricKey; label: string }[] = [
  { key: "months_supply", label: "Months of supply" },
  { key: "median_dom", label: "Median days on market" },
  { key: "sold_above_original_share", label: "Homes sold above original list" },
  { key: "price_drop_share", label: "Active listings with price drops" },
  { key: "median_sale_ppsf", label: "Median sale price per square foot" },
];
const REALTOR_METRICS: { key: MetricKey; label: string }[] = [
  { key: "active_listing_count", label: "Active listings" },
  { key: "new_listing_count", label: "New listings" },
  { key: "pending_ratio", label: "Pending-to-active ratio" },
  { key: "viewer_ratio", label: "Listing viewers relative to U.S." },
  { key: "hotness_score", label: "Market Hotness score" },
];
const COLORS = ["#ff7a1a", "#12355b", "#2f7d6d", "#9b4f96", "#c7a227"];
const MAP_PALETTES: Record<MapPaletteKey, string[]> = {
  navy: ["#edf4fa", "#b9d2e5", "#74a8cc", "#2f6f9f", "#12355b"],
  orange: ["#fff3e8", "#ffd2aa", "#f7a35c", "#df6b1c", "#913500"],
};
const TIME_RANGES: { key: TimeRange; label: string; months: number | null }[] = [
  { key: "1y", label: "1 year", months: 12 },
  { key: "3y", label: "3 years", months: 36 },
  { key: "5y", label: "5 years", months: 60 },
  { key: "max", label: "Max", months: null },
];

function normalizedPlaceName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function lastValue(values: Value[]) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null) return { value: values[index] as number, index };
  }
  return null;
}

function expandedSeries(series: Value[] | { o: number; v: Value[] } | undefined, length: number) {
  if (!series) return [];
  if (Array.isArray(series)) return series;
  const values: Value[] = Array(length).fill(null);
  series.v.forEach((value, index) => {
    if (series.o + index < length) values[series.o + index] = value;
  });
  return values;
}

function mergeDatasets(datasets: Dataset[]): Dataset | null {
  if (!datasets.length) return null;
  const metrics: Record<string, Metric> = {};
  const regions = new Map<string, Region>();
  datasets.forEach((dataset) => {
    Object.assign(metrics, dataset.metrics);
    dataset.regions.forEach((region) => {
      const existing = regions.get(region.id);
      regions.set(region.id, existing
        ? {
            ...existing,
            series: { ...existing.series, ...region.series },
            quality: { ...existing.quality, ...region.quality },
          }
        : { ...region, series: { ...region.series } });
    });
  });
  return {
    geography: "zip",
    metrics,
    regions: [...regions.values()].sort((a, b) =>
      `${a.county}-${a.name}`.localeCompare(`${b.county}-${b.name}`)),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function loadDatasetFiles(
  releaseBase: string,
  names: string[] | undefined,
  legacyName: string,
) {
  const shards = await Promise.all(
    (names?.length ? names : [legacyName]).map((name) =>
      fetchJson<Dataset>(`${releaseBase}/${name}`),
    ),
  );
  const merged = mergeDatasets(shards);
  if (!merged) throw new Error(`Dataset release has no ${legacyName} files.`);
  return merged;
}

async function loadMapFiles(releaseBase: string, names: string[]) {
  const shards = await Promise.all(
    names.map((name) => fetchJson<MapData>(`${releaseBase}/${name}`)),
  );
  if (!shards.length) throw new Error("Map release contains no files.");
  return {
    geography: shards[0].geography,
    counties: Object.assign({}, ...shards.map((shard) => shard.counties)),
  } as MapData;
}

export function cpiValuesForRealAdjustment(
  cpi: Pick<CpiSeries, "dates" | "values">,
  rules: CpiInterpolationRule[] = [],
) {
  const values = [...cpi.values];
  const approvedMonths = new Set(
    rules.filter((rule) => rule.method === "log_linear").map((rule) => rule.month),
  );
  cpi.dates.forEach((date, index) => {
    if (values[index] != null || !approvedMonths.has(date.slice(0, 7))) return;
    const previous = values[index - 1];
    const next = values[index + 1];
    if (previous != null && next != null && previous > 0 && next > 0) {
      values[index] = Math.sqrt(previous * next);
    }
  });
  return new Map(cpi.dates.map((date, index) => [date.slice(0, 7), values[index]]));
}

export function applyPriceAdjustment(
  series: { dates: string[]; values: Value[]; unit: string; changeMode: ChangeMode; qualityFlags?: boolean[] },
  metric: MetricKey,
  adjustment?: PriceAdjustment,
) {
  if (
    adjustment?.basis !== "real" ||
    !adjustment.cpi ||
    !adjustment.baseMonth ||
    (metric !== "zhvi" && metric !== "zori")
  ) return series;
  const cpiByMonth = cpiValuesForRealAdjustment(
    adjustment.cpi,
    adjustment.interpolationRules,
  );
  const baseCpi = cpiByMonth.get(adjustment.baseMonth);
  if (baseCpi == null || baseCpi === 0) return { ...series, values: series.values.map(() => null) };
  return {
    ...series,
    values: series.values.map((value, index) => {
      const currentCpi = cpiByMonth.get(series.dates[index]?.slice(0, 7));
      return value != null && currentCpi != null && currentCpi !== 0
        ? value * baseCpi / currentCpi
        : null;
    }),
  };
}

function metricSeries(
  dataset: Dataset,
  region: Region,
  metric: MetricKey,
  adjustment?: PriceAdjustment,
) {
  if (metric !== "price_rent") {
    const metadata = dataset.metrics[metric];
    const dates = metadata?.dates ?? [];
    const qualityIndices = metadata?.source_product
      ? region.quality?.[metadata.source_product] ?? []
      : [];
    const qualityIndexSet = new Set(qualityIndices);
    return applyPriceAdjustment({
      dates,
      values: expandedSeries(region.series[metric], dates.length),
      qualityFlags: dates.map((_, index) => qualityIndexSet.has(index)),
      unit: metadata?.unit ?? "number",
      changeMode: metadata?.change_mode ??
        (metadata?.unit === "share" ? "percentage_point" : metadata?.unit === "ratio" ? "difference" : "percent"),
    }, metric, adjustment);
  }
  const rent = dataset.metrics.zori;
  const value = dataset.metrics.zhvi;
  if (!rent || !value) return { dates: [], values: [], qualityFlags: [], unit: "multiple", changeMode: "percent" as ChangeMode };
  const homeValues = expandedSeries(region.series.zhvi, value.dates.length);
  const rents = expandedSeries(region.series.zori, rent.dates.length);
  const valueByDate = new Map(value.dates.map((date, index) => [date, homeValues[index]]));
  return {
    dates: rent.dates,
    values: rent.dates.map((date, index) => {
      const homeValue = valueByDate.get(date);
      const monthlyRent = rents[index];
      return homeValue != null && monthlyRent != null && monthlyRent > 0
        ? homeValue / (monthlyRent * 12)
        : null;
    }),
    qualityFlags: rent.dates.map(() => false),
    unit: "multiple",
    changeMode: "percent" as ChangeMode,
  };
}

function observedCpiMonths(cpi: CpiSeries | null, dates: string[]) {
  if (!cpi) return [];
  const housingMonths = new Set(dates.map((date) => date.slice(0, 7)));
  return cpi.dates
    .map((date, index) => cpi.values[index] != null ? date.slice(0, 7) : null)
    .filter((month): month is string => month != null && housingMonths.has(month));
}

export function normalizedRealBaseMonth(cpi: CpiSeries | null, dates: string[], requested: string) {
  const months = observedCpiMonths(cpi, dates);
  if (!months.length) return "";
  if (!requested) return months.at(-1)!;
  if (months.includes(requested)) return requested;
  return [...months].reverse().find((month) => month < requested) ?? months[0];
}

function cpiOverlay(cpi: CpiSeries | null, view: ViewKey): ChartOverlay[] {
  if (!cpi || (view !== "yoy" && view !== "index")) return [];
  return [{
    id: `cpi-${cpi.key}`,
    label: view === "yoy" ? `${cpi.label} inflation` : cpi.label,
    dates: cpi.dates,
    values: cpi.values,
    color: "#5d6570",
    dashed: true,
  }];
}

function cpiYoyAtMonth(cpi: CpiSeries | null, month: string) {
  if (!cpi || !month) return null;
  const index = cpi.dates.findIndex((date) => date.startsWith(month));
  return index >= 0 ? cpi.yoy[index] : null;
}

export function transformValues(
  values: Value[],
  view: ViewKey,
  dates: string[] = [],
  indexBaseMonth = "",
  changeMode: ChangeMode = "percent",
): Value[] {
  if (view === "level") return values;
  if (view === "yoy") {
    return values.map((value, index) => {
      const prior = values[index - 12];
      if (value == null || prior == null) return null;
      if (changeMode !== "percent") return value - prior;
      return prior !== 0 ? value / prior - 1 : null;
    });
  }
  const requestedIndex = indexBaseMonth
    ? dates.findIndex((date) => date.startsWith(indexBaseMonth))
    : -1;
  const baseIndex = values.findIndex(
    (value, index) => value != null && (requestedIndex < 0 || index >= requestedIndex),
  );
  const base = baseIndex >= 0 ? values[baseIndex] : null;
  return values.map((value) =>
    value != null && base != null && base !== 0 ? (value / base) * 100 : null,
  );
}

function transformQualityFlags(flags: boolean[], view: ViewKey, smoothMonths = 1) {
  const smoothed = flags.map((_, index) => {
    const start = Math.max(0, index - smoothMonths + 1);
    return flags.slice(start, index + 1).some(Boolean);
  });
  if (view !== "yoy") return smoothed;
  return smoothed.map((flagged, index) => flagged || Boolean(smoothed[index - 12]));
}

function trailingAverage(values: Value[], months: number) {
  if (months <= 1) return values;
  return values.map((value, index) => {
    if (value == null) return null;
    const window = values.slice(Math.max(0, index - months + 1), index + 1);
    if (window.length < months || window.some((item) => item == null)) return null;
    return window.reduce<number>((total, item) => total + (item ?? 0), 0) / months;
  });
}

function metricDates(dataset: Dataset, metric: MetricKey) {
  return metric === "price_rent"
    ? dataset.metrics.zori?.dates ?? []
    : dataset.metrics[metric]?.dates ?? [];
}

function normalizedBaseMonth(dates: string[], requested: string) {
  const months = dates.map((date) => date.slice(0, 7));
  if (!months.length) return "";
  if (!requested) return months[0];
  if (requested <= months[0]) return months[0];
  if (requested >= months.at(-1)!) return months.at(-1)!;
  return months.find((month) => month >= requested) ?? months[0];
}

function timeRangeStart(length: number, range: TimeRange) {
  const months = TIME_RANGES.find((item) => item.key === range)?.months;
  return months == null ? 0 : Math.max(0, length - months);
}

function formatValue(
  value: number | null,
  unit: string,
  view: ViewKey,
  compact = false,
  changeMode: ChangeMode = "percent",
) {
  if (value == null || Number.isNaN(value)) return "—";
  if (view === "yoy") {
    if (changeMode === "percentage_point") return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
    if (changeMode === "difference") {
      const prefix = value >= 0 ? "+" : "";
      if (unit === "months") return `${prefix}${value.toFixed(1)} months`;
      if (unit === "days") return `${prefix}${value.toFixed(0)} days`;
      if (unit === "ratio") return `${prefix}${value.toFixed(3)}`;
      if (unit === "viewer_multiple") return `${prefix}${value.toFixed(2)}×`;
      return `${prefix}${value.toFixed(1)}`;
    }
    return `${(value * 100).toFixed(1)}%`;
  }
  if (view === "index") return value.toFixed(1);
  if (unit === "usd") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      notation: compact ? "compact" : "standard",
    }).format(value);
  }
  if (unit === "usd_month") return `$${Math.round(value).toLocaleString()}/mo`;
  if (unit === "usd_sqft") return `$${Math.round(value).toLocaleString()}/sq. ft.`;
  if (unit === "share") return `${(value * 100).toFixed(1)}%`;
  if (unit === "ratio") return value.toFixed(3);
  if (unit === "multiple") return `${value.toFixed(1)}×`;
  if (unit === "viewer_multiple") return `${value.toFixed(2)}×`;
  if (unit === "score") return value.toFixed(1);
  if (unit === "days") return `${value.toFixed(0)} days`;
  if (unit === "months") return `${value.toFixed(1)} months`;
  return Math.round(value).toLocaleString();
}

function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function validationDate(date: string | undefined) {
  if (!date) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date));
}

function latestObservation(values: Iterable<string>) {
  return [...values].sort().at(-1);
}

export function timeAxisTicks(dates: string[], maxTicks = 6) {
  if (!dates.length) return [];
  if (dates.length <= 18) {
    const count = Math.min(maxTicks, dates.length);
    return [...new Set(Array.from({ length: count }, (_, index) =>
      dates[Math.round(index * (dates.length - 1) / Math.max(1, count - 1))],
    ))];
  }
  const firstDateByYear = dates.filter((date, index) =>
    index === 0 || date.slice(0, 4) !== dates[index - 1].slice(0, 4),
  );
  if (firstDateByYear.length <= maxTicks) return firstDateByYear;
  return [...new Set(Array.from({ length: maxTicks }, (_, index) =>
    firstDateByYear[Math.round(index * (firstDateByYear.length - 1) / (maxTicks - 1))],
  ))];
}

export function valueAxisDomain(
  rows: Record<string, string | number | boolean | null>[],
  dataKeys: string[],
  view: "level" | "yoy" | "index",
) {
  const values = rows.flatMap((row) => dataKeys
    .map((key) => row[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  if (!values.length) return [0, 1] as [number, number];
  if (view === "yoy") values.push(0);
  if (view === "index") values.push(100);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const padding = span > 0 ? span * 0.06 : Math.max(Math.abs(maximum) * 0.03, 0.01);
  return [minimum - padding, maximum + padding] as [number, number];
}

function LabelledSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="control-label">
      <span>{label}</span>
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)} className="w-full">
        {children}
      </NativeSelect>
    </label>
  );
}

function TimeRangeControl({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}) {
  return (
    <div className="time-range" aria-label="Chart time period">
      <span>Time period</span>
      <div role="group" aria-label="Choose chart time period">
        {TIME_RANGES.map((option) => (
          <button
            type="button"
            key={option.key}
            className={value === option.key ? "active" : ""}
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function IndexBaseControl({
  value,
  dates,
  onChange,
}: {
  value: string;
  dates: string[];
  onChange: (value: string) => void;
}) {
  if (!dates.length) return null;
  return (
    <label className="index-base">
      <span>Index starting month</span>
      <input
        type="month"
        min={dates[0].slice(0, 7)}
        max={dates.at(-1)!.slice(0, 7)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function RealBaseControl({
  value,
  dates,
  onChange,
}: {
  value: string;
  dates: string[];
  onChange: (value: string) => void;
}) {
  if (!dates.length) return null;
  return (
    <label className="index-base">
      <span>Constant-dollar month</span>
      <input
        type="month"
        min={dates[0]}
        max={dates.at(-1)!}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function InflationToggle({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="inflation-toggle">
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span>{label}</span>
    </label>
  );
}

function SeriesDot({
  cx,
  cy,
  payload,
  qualityKey,
  color,
  showAll,
}: {
  cx?: number;
  cy?: number;
  payload?: Record<string, unknown>;
  qualityKey: string;
  color: string;
  showAll: boolean;
}) {
  if (cx == null || cy == null) return null;
  const flagged = Boolean(payload?.[qualityKey]);
  if (!flagged && !showAll) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={flagged ? 3.4 : 1.6}
      fill={flagged ? "#fffaf4" : color}
      fillOpacity={flagged ? 1 : 0.42}
      stroke={flagged ? "#9a4b00" : color}
      strokeWidth={flagged ? 1.7 : 0.5}
    />
  );
}

function SeriesChart({
  dataset,
  regions,
  metric,
  view,
  timeRange,
  indexBaseMonth,
  priceAdjustment,
  overlays = [],
  showQuality = false,
  smoothMonths = 1,
}: {
  dataset: Dataset;
  regions: Region[];
  metric: MetricKey;
  view: ViewKey;
  timeRange: TimeRange;
  indexBaseMonth: string;
  priceAdjustment?: PriceAdjustment;
  overlays?: ChartOverlay[];
  showQuality?: boolean;
  smoothMonths?: number;
}) {
  const chart = useMemo(() => {
    if (!regions.length) return { rows: [], unit: "number", changeMode: "percent" as ChangeMode };
    const first = metricSeries(dataset, regions[0], metric, priceAdjustment);
    const series = regions.map((region) => {
      const current = metricSeries(dataset, region, metric, priceAdjustment);
      const rawValues = transformValues(current.values, view, current.dates, indexBaseMonth, current.changeMode);
      const plottedValues = transformValues(
        trailingAverage(current.values, smoothMonths),
        view,
        current.dates,
        indexBaseMonth,
        current.changeMode,
      );
      const qualityFlags = transformQualityFlags(current.qualityFlags ?? [], view);
      const byDate = new Map(
        current.dates.map((date, index) => [
          date,
          {
            value: plottedValues[index],
            raw: rawValues[index],
            flagged: showQuality && Boolean(qualityFlags[index]),
          },
        ]),
      );
      return { region, byDate };
    });
    const overlaySeries = overlays.map((overlay) => ({
      overlay,
      byDate: new Map(
        overlay.dates.map((date, index) => [
          date.slice(0, 7),
          transformValues(overlay.values, view, overlay.dates, indexBaseMonth, "percent")[index],
        ]),
      ),
    }));
    const rows = first.dates.map((date) => {
      const row: Record<string, string | number | boolean | null> = { date };
      series.forEach(({ region, byDate }) => {
        const observation = byDate.get(date);
        row[region.id] = observation?.value ?? null;
        row[`${region.id}__raw`] = observation?.raw ?? null;
        row[`${region.id}__quality`] = observation?.flagged ?? false;
      });
      overlaySeries.forEach(({ overlay, byDate }) => {
        row[overlay.id] = byDate.get(date.slice(0, 7)) ?? null;
      });
      return row;
    });
    const rangeStart = timeRangeStart(rows.length, timeRange);
    const indexStart = view === "index"
      ? Math.max(0, rows.findIndex((row) => String(row.date).startsWith(indexBaseMonth)))
      : 0;
    return {
      unit: first.unit,
      changeMode: first.changeMode,
      rows: rows.slice(Math.max(rangeStart, indexStart)),
    };
  }, [dataset, regions, metric, view, timeRange, indexBaseMonth, overlays, priceAdjustment, showQuality, smoothMonths]);

  const overlayById = new Map(overlays.map((overlay) => [overlay.id, overlay]));
  const timeTicks = timeAxisTicks(chart.rows.map((row) => String(row.date)));
  const showMonthOnAxis = chart.rows.length <= 18;
  const valueKeys = [
    ...regions.flatMap((region) => smoothMonths > 1 ? [region.id, `${region.id}__raw`] : [region.id]),
    ...overlays.map((overlay) => overlay.id),
  ];
  const valueDomain = valueAxisDomain(chart.rows, valueKeys, view);

  if (!regions.length) {
    return (
      <div className="chart-empty" role="status">
        Select a place from the ranking or add a comparison to display the chart.
      </div>
    );
  }

  return (
    <div className="h-[360px] min-w-0 w-full" aria-label="Housing market time-series chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chart.rows} margin={{ top: 12, right: 12, left: 8, bottom: 8 }}>
          <CartesianGrid stroke="#dbe3e8" strokeDasharray="3 4" vertical={false} />
          <XAxis
            dataKey="date"
            ticks={timeTicks}
            tickFormatter={(date) => showMonthOnAxis ? shortDate(String(date)) : String(date).slice(0, 4)}
            tick={{ fill: "#627180", fontSize: 12 }}
            axisLine={{ stroke: "#b9c6cf" }}
            tickLine={false}
          />
          <YAxis
            width={78}
            domain={valueDomain}
            tickFormatter={(value) => formatValue(Number(value), chart.unit, view, true, chart.changeMode)}
            tick={{ fill: "#627180", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <ChartTooltip
            labelFormatter={(date) => shortDate(String(date))}
            formatter={(value, name, item) => {
              const key = String(name);
              const row = item.payload as Record<string, unknown> | undefined;
              const flagged = Boolean(row?.[`${key}__quality`]);
              const label = regions.find((region) => region.id === key)?.name
                ?? overlayById.get(key)?.label
                ?? key;
              return [
                formatValue(Number(value), chart.unit, view, false, chart.changeMode),
                `${label}${flagged ? " · provider flagged" : ""}`,
              ];
            }}
            contentStyle={{ borderRadius: 8, borderColor: "#cbd6dc", boxShadow: "0 12px 30px #12355b20" }}
          />
          <Legend formatter={(id) => regions.find((region) => region.id === String(id))?.name ?? overlayById.get(String(id))?.label ?? String(id)} />
          {regions.flatMap((region, index) => {
            const color = COLORS[index % COLORS.length];
            const dot = (props: { cx?: number; cy?: number; payload?: Record<string, unknown> }) => (
              <SeriesDot
                {...props}
                qualityKey={`${region.id}__quality`}
                color={color}
                showAll={smoothMonths > 1}
              />
            );
            return smoothMonths > 1 ? [
                <Line
                  key={`${region.id}-raw`}
                  type="monotone"
                  dataKey={`${region.id}__raw`}
                  name={region.id}
                  legendType="none"
                  stroke={color}
                  strokeDasharray="4 3"
                  strokeOpacity={0.42}
                  strokeWidth={1}
                  dot={dot}
                  connectNulls={false}
                  isAnimationActive={false}
                />,
                <Line
                  key={`${region.id}-smoothed`}
                  type="monotone"
                  dataKey={region.id}
                  name={region.id}
                  tooltipType="none"
                  stroke={color}
                  strokeWidth={index === 0 ? 3 : 2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />,
              ] : [
              <Line
                key={region.id}
                type="monotone"
                dataKey={region.id}
                name={region.id}
                stroke={color}
                strokeWidth={index === 0 ? 3 : 2}
                dot={dot}
                connectNulls={false}
                isAnimationActive={false}
              />,
            ];
          })}
          {overlays.map((overlay) => (
            <Line
              key={overlay.id}
              type="monotone"
              dataKey={overlay.id}
              stroke={overlay.color}
              strokeWidth={2}
              strokeDasharray={overlay.dashed ? "6 4" : undefined}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type RegionalCyclePoint = {
  id: string;
  name: string;
  inventoryGrowth: number;
  homeValueGrowth: number;
  color: string;
  selected: boolean;
  spotlight: boolean;
  role?: "focus" | "nearby";
  label: string;
};

function RegionalCycleTooltip({ active, payload, real }: {
  active?: boolean;
  payload?: { payload?: RegionalCyclePoint }[];
  real: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="cycle-tooltip">
      <strong>{point.name}</strong>
      <span>For-sale inventory: {formatValue(point.inventoryGrowth, "homes", "yoy")}</span>
      <span>{real ? "Real home value" : "Home value"}: {formatValue(point.homeValueGrowth, "usd", "yoy")}</span>
    </div>
  );
}

function growthDomain(values: number[]) {
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const padding = Math.max((maximum - minimum) * 0.14, 0.015);
  return [minimum - padding, maximum + padding] as [number, number];
}

function RegionalCycleChart({
  dataset,
  selectedIds,
  cpi,
  interpolationRules,
}: {
  dataset: Dataset;
  selectedIds: string[];
  cpi: CpiSeries | null;
  interpolationRules: CpiInterpolationRule[];
}) {
  const snapshot = useMemo(() => {
    const valueDates = metricDates(dataset, "zhvi");
    const inventoryDates = metricDates(dataset, "inventory");
    const valueAdjustment: PriceAdjustment | undefined = cpi
      ? {
          basis: "real",
          cpi,
          baseMonth: normalizedRealBaseMonth(cpi, valueDates, ""),
          interpolationRules,
        }
      : undefined;
    const series = dataset.regions.map((region) => {
      const inventory = metricSeries(dataset, region, "inventory");
      const homeValue = metricSeries(dataset, region, "zhvi", valueAdjustment);
      const inventoryGrowth = transformValues(inventory.values, "yoy", inventory.dates);
      const homeValueGrowth = transformValues(homeValue.values, "yoy", homeValue.dates);
      return {
        region,
        inventoryByMonth: new Map(inventory.dates.map((date, index) => [date.slice(0, 7), inventoryGrowth[index]])),
        valueByMonth: new Map(homeValue.dates.map((date, index) => [date.slice(0, 7), homeValueGrowth[index]])),
      };
    });
    const valueMonths = new Set(valueDates.map((date) => date.slice(0, 7)));
    const sharedMonths = inventoryDates
      .map((date) => date.slice(0, 7))
      .filter((month) => valueMonths.has(month));
    const month = [...sharedMonths].reverse().find((candidate) =>
      series.every(({ inventoryByMonth, valueByMonth }) =>
        inventoryByMonth.get(candidate) != null && valueByMonth.get(candidate) != null,
      ),
    );
    if (!month) return { month: "", points: [] as RegionalCyclePoint[] };
    const points = series.map(({ region, inventoryByMonth, valueByMonth }) => {
      const selectedIndex = selectedIds.indexOf(region.id);
      const spotlight = region.role === "focus" || region.role === "nearby";
      return {
        id: region.id,
        name: region.name,
        inventoryGrowth: inventoryByMonth.get(month) as number,
        homeValueGrowth: valueByMonth.get(month) as number,
        color: selectedIndex >= 0 ? COLORS[selectedIndex % COLORS.length] : "#9baab4",
        selected: selectedIndex >= 0,
        spotlight,
        role: region.role,
        label: selectedIndex >= 0 || spotlight ? region.name : "",
      };
    });
    return { month, points };
  }, [dataset, selectedIds, cpi, interpolationRules]);

  if (!snapshot.points.length) {
    return <div className="chart-empty">A common home-value and inventory observation is not available.</div>;
  }

  const xDomain = growthDomain(snapshot.points.map((point) => point.inventoryGrowth));
  const yDomain = growthDomain(snapshot.points.map((point) => point.homeValueGrowth));
  return (
    <>
      <div className="regional-cycle-chart" aria-label="Metro housing cycle position chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 32, right: 28, bottom: 34, left: 8 }}>
            <CartesianGrid stroke="#dbe3e8" strokeDasharray="3 4" />
            <XAxis
              type="number"
              dataKey="inventoryGrowth"
              domain={xDomain}
              tickFormatter={(value) => `${Math.round(Number(value) * 100)}%`}
              tick={{ fill: "#627180", fontSize: 11 }}
              axisLine={{ stroke: "#b9c6cf" }}
              tickLine={false}
              label={{ value: "For-sale inventory growth", position: "insideBottom", offset: -24, fill: "#526675", fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="homeValueGrowth"
              domain={yDomain}
              width={52}
              tickFormatter={(value) => `${Math.round(Number(value) * 100)}%`}
              tick={{ fill: "#627180", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: cpi ? "Real home-value growth" : "Home-value growth", angle: -90, position: "insideLeft", offset: 5, fill: "#526675", fontSize: 11 }}
            />
            <ZAxis range={[75, 75]} />
            <ReferenceLine x={0} stroke="#7f8f99" strokeWidth={1.2} />
            <ReferenceLine y={0} stroke="#7f8f99" strokeWidth={1.2} />
            <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<RegionalCycleTooltip real={Boolean(cpi)} />} />
            <Scatter data={snapshot.points} isAnimationActive={false}>
              {snapshot.points.map((point) => (
                <Cell
                  key={point.id}
                  fill={point.color}
                  fillOpacity={point.selected || point.spotlight ? 1 : 0.42}
                  stroke={point.role === "nearby" ? "#d85d08" : point.role === "focus" ? "#12355b" : point.selected ? "#ffffff" : "#6d7f8b"}
                  strokeWidth={point.spotlight ? 3 : point.selected ? 2 : 1}
                />
              ))}
              <LabelList dataKey="label" position="top" offset={7} fill="#3f5667" fontSize={10} fontWeight={700} />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span>As of {shortDate(`${snapshot.month}-01`)}</span>
        <span>Selected metros use the line-chart colors. Los Angeles, CA is outlined in navy; nearby Riverside, CA is outlined in orange. Hover gray points for other metro names.</span>
      </div>
    </>
  );
}

function InventoryLineGuide() {
  return (
    <div className="series-guide" aria-label="Realtor.com inventory chart line guide">
      <span><i className="series-guide-line smoothed" aria-hidden="true" />Solid: trailing three-month average</span>
      <span><i className="series-guide-line monthly" aria-hidden="true" />Dashed with points: reported monthly observations</span>
      <span className="series-guide-method">Simple moving average; no polynomial fit.</span>
    </div>
  );
}

function QualityCoverage({
  dataset,
  region,
  metric,
  timeRange,
}: {
  dataset: Dataset;
  region?: Region;
  metric: MetricKey;
  timeRange: TimeRange;
}) {
  if (!region) return null;
  const series = metricSeries(dataset, region, metric);
  const start = timeRangeStart(series.dates.length, timeRange);
  const values = series.values.slice(start);
  const flags = series.qualityFlags?.slice(start) ?? [];
  const reported = values.filter((value) => value != null).length;
  const flagged = values.filter((value, index) => value != null && flags[index]).length;
  return (
    <div className="quality-summary" aria-label="Realtor.com data coverage">
      <span><strong>{reported}</strong> of {values.length} months reported</span>
      <span className="quality-summary-flag"><i /> <strong>{flagged}</strong> provider-flagged</span>
      <span>Hollow points identify flagged observations.</span>
    </div>
  );
}

type HotnessPoint = {
  id: string;
  name: string;
  county: string | null;
  demand: number;
  supply: number;
  flagged: boolean;
  label: string;
};

function HotnessChartTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: HotnessPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="hotness-tooltip">
      <strong>{point.name}</strong>
      <span>{point.county}</span>
      <span>Demand score: {point.demand.toFixed(1)}</span>
      <span>Supply score: {point.supply.toFixed(1)}</span>
      {point.flagged && <span className="quality-text">Provider flagged</span>}
    </div>
  );
}

function HotnessQuadrant({
  dataset,
  regions,
  selectedId,
}: {
  dataset: Dataset;
  regions: Region[];
  selectedId: string;
}) {
  const points = regions.flatMap((region): HotnessPoint[] => {
    const demand = metricSeries(dataset, region, "demand_score");
    const supply = metricSeries(dataset, region, "supply_score");
    const demandValue = demand.values.at(-1);
    const supplyValue = supply.values.at(-1);
    if (demandValue == null || supplyValue == null) return [];
    return [{
      id: region.id,
      name: region.name,
      county: region.county,
      demand: demandValue,
      supply: supplyValue,
      flagged: Boolean(demand.qualityFlags?.at(-1) || supply.qualityFlags?.at(-1)),
      label: region.id === selectedId ? region.name : "",
    }];
  });
  const focus = points.filter((point) => point.id === selectedId);
  const unflagged = points.filter((point) => point.id !== selectedId && !point.flagged);
  const flagged = points.filter((point) => point.id !== selectedId && point.flagged);
  const dates = dataset.metrics.hotness_score?.dates ?? [];
  return (
    <Card className="hotness-quadrant-card">
      <CardHeader>
        <p className="section-kicker">Demand × supply</p>
        <CardTitle>Market Hotness quadrant</CardTitle>
        <p className="quadrant-date">Latest common month · {dates.length ? shortDate(dates.at(-1)!) : "Unavailable"}</p>
      </CardHeader>
      <CardContent className="hotness-chart-wrap">
        <div className="hotness-chart" aria-label="Demand score versus supply score by ZIP code">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 24, bottom: 14, left: 0 }}>
              <CartesianGrid stroke="#dbe3e8" strokeDasharray="3 4" />
              <XAxis type="number" dataKey="demand" name="Demand score" domain={[0, 100]} tick={{ fill: "#627180", fontSize: 11 }} label={{ value: "Demand score →", position: "insideBottom", offset: -8, fill: "#526a7a", fontSize: 11 }} />
              <YAxis type="number" dataKey="supply" name="Supply score" domain={[0, 100]} width={44} tick={{ fill: "#627180", fontSize: 11 }} label={{ value: "Supply score →", angle: -90, position: "insideLeft", fill: "#526a7a", fontSize: 11 }} />
              <ZAxis range={[34, 34]} />
              <ReferenceLine x={50} stroke="#9aaab4" strokeDasharray="4 4" />
              <ReferenceLine y={50} stroke="#9aaab4" strokeDasharray="4 4" />
              <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<HotnessChartTooltip />} />
              <Scatter name="Reported ZIPs" data={unflagged} fill="#12355b" fillOpacity={0.48} />
              <Scatter name="Provider flagged" data={flagged} fill="#fff7e8" stroke="#9a4b00" strokeWidth={1.5} />
              <Scatter name="Selected ZIP" data={focus} fill="#ff7a1a" stroke="#7e3100" strokeWidth={1.5}>
                <LabelList dataKey="label" position="top" fill="#7e3100" fontSize={11} fontWeight={700} />
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="quadrant-key">
          <span><i className="reported" />Reported</span>
          <span><i className="flagged" />Provider flagged</span>
          <span><i className="selected" />Selected ZIP</span>
        </div>
        <p className="data-note">Upper-right ZIPs combine stronger listing attention with faster-moving supply. Scores are relative rankings, not percentage changes.</p>
        <FigureAttribution sources={["realtor"]} />
      </CardContent>
    </Card>
  );
}

function CountyMap({
  county,
  mapData,
  dataset,
  metric,
  metricLabel,
  view,
  indexBaseMonth,
  selectedId,
  onSelect,
  paletteKey,
  onPaletteChange,
  provider,
  priceAdjustment,
  showQuality = false,
}: {
  county: string;
  mapData: MapData;
  dataset: Dataset;
  metric: MetricKey;
  metricLabel: string;
  view: ViewKey;
  indexBaseMonth: string;
  selectedId: string;
  onSelect: (id: string) => void;
  paletteKey: MapPaletteKey;
  onPaletteChange: (palette: MapPaletteKey) => void;
  provider: string;
  priceAdjustment?: PriceAdjustment;
  showQuality?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const onSelectRef = useRef(onSelect);
  const lastFitKey = useRef("");
  const [mapReady, setMapReady] = useState(false);
  const shapes = useMemo(() => {
    const countyNames = county === "Both" ? ["Orange County", "Los Angeles County"] : [county];
    const groups = countyNames.map((name) => mapData.counties[name]);
    return {
      bounds: [
        [
          Math.min(...groups.map((group) => group.bounds[0][0])),
          Math.min(...groups.map((group) => group.bounds[0][1])),
        ],
        [
          Math.max(...groups.map((group) => group.bounds[1][0])),
          Math.max(...groups.map((group) => group.bounds[1][1])),
        ],
      ] as [[number, number], [number, number]],
      mapped: groups.reduce((total, group) => total + group.mapped, 0),
      available: groups.reduce((total, group) => total + group.available, 0),
      regions: groups.flatMap((group, index) =>
        group.regions.map((region) => ({
          ...region,
          county: region.county ?? countyNames[index],
        })),
      ),
    };
  }, [county, mapData]);
  const dates = metricDates(dataset, metric);
  const datasetByPlace = useMemo(
    () => new Map(
      dataset.regions.map((region) => [
        `${region.county ?? ""}:${normalizedPlaceName(region.name)}`,
        region,
      ]),
    ),
    [dataset],
  );

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const values = useMemo(
    () =>
      shapes.regions.map((shape) => {
        const region = datasetByPlace.get(
          `${shape.county ?? ""}:${normalizedPlaceName(shape.name)}`,
        );
        const series = region ? metricSeries(dataset, region, metric, priceAdjustment) : null;
        const transformed = series
          ? transformValues(series.values, view, series.dates, indexBaseMonth, series.changeMode)
          : [];
        const yoyValues = series
          ? transformValues(series.values, "yoy", series.dates, "", series.changeMode)
          : [];
        const qualityFlags = series
          ? transformQualityFlags(series.qualityFlags ?? [], view)
          : [];
        return {
          id: shape.id,
          dataId: region?.id ?? null,
          name: shape.name,
          county: shape.county ?? region?.county ?? "",
          value: transformed.at(-1) ?? null,
          yoy: yoyValues.at(-1) ?? null,
          qualityFlagged: showQuality && Boolean(qualityFlags.at(-1)),
          unit: series?.unit ?? "number",
          changeMode: series?.changeMode ?? "percent",
        };
      }),
    [dataset, datasetByPlace, indexBaseMonth, metric, priceAdjustment, shapes.regions, showQuality, view],
  );
  const valueById = useMemo(
    () => new Map(values.map((item) => [item.id, item])),
    [values],
  );
  const finite = values
    .map((item) => item.value)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 0;
  const palette = MAP_PALETTES[paletteKey];
  const fillById = useMemo(() => {
    const currentPalette = MAP_PALETTES[paletteKey];
    return new Map(values.map((item) => {
      const value = item.value;
      if (value == null || !Number.isFinite(value)) return [item.id, "#dce3e6"];
      let ratio = high === low ? 0.5 : (value - low) / (high - low);
      if (view === "yoy") {
        const span = Math.max(Math.abs(low), Math.abs(high), 0.001);
        ratio = (value + span) / (span * 2);
      }
      const index = Math.min(
        currentPalette.length - 1,
        Math.max(0, Math.floor(ratio * currentPalette.length)),
      );
      return [item.id, currentPalette[index]];
    }));
  }, [high, low, paletteKey, values, view]);
  const selected = values.find((item) => item.dataId === selectedId);
  const observed = values.filter((item) => item.value != null && Number.isFinite(item.value)).length;
  const flagged = values.filter((item) => item.value != null && item.qualityFlagged).length;
  const countyLabel = county === "Both" ? "Orange and Los Angeles Counties" : county;
  const geographyLabel = dataset.geography === "zip" ? "ZIP code" : "City/community";
  const outsideGeographyLabel = dataset.geography === "zip"
    ? "Outside mapped ZCTA geography"
    : "Outside city/CDP geography";
  const viewLabel = view === "level"
    ? "current level"
    : view === "yoy"
      ? "change from one year earlier"
      : `index (${shortDate(`${indexBaseMonth}-01`)} = 100)`;
  const providerSource: FigureSource = provider.toLowerCase().startsWith("realtor")
    ? "realtor"
    : provider.toLowerCase().startsWith("redfin")
      ? "redfin"
      : "zillow";
  const mapSources: FigureSource[] = priceAdjustment?.basis === "real"
    ? [providerSource, "bls"]
    : [providerSource];

  useEffect(() => {
    let cancelled = false;
    async function initializeMap() {
      if (!containerRef.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, {
        zoomControl: true,
        scrollWheelZoom: true,
        minZoom: 7,
        maxZoom: 18,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(map);
      mapRef.current = map;
      setMapReady(true);
    }
    initializeMap();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!mapReady || !L || !map) return;
    if (layerRef.current) layerRef.current.remove();
    const featureCollection = {
      type: "FeatureCollection" as const,
      features: shapes.regions.map((shape) => ({
        type: "Feature" as const,
        properties: { id: shape.id, name: shape.name },
        geometry: shape.geometry,
      })),
    };
    const overlay = L.geoJSON(featureCollection as GeoJSON.FeatureCollection, {
      style: (feature) => {
        const id = String(feature?.properties?.id ?? "");
        const item = valueById.get(id);
        const isSelected = item?.dataId === selectedId;
        return {
          color: isSelected ? "#ff7a1a" : item?.qualityFlagged ? "#9a4b00" : "#ffffff",
          weight: isSelected ? 3 : item?.qualityFlagged ? 2.2 : 1.2,
          dashArray: item?.qualityFlagged ? "5 3" : undefined,
          opacity: 1,
          fillColor: fillById.get(id) ?? "#dce3e6",
          fillOpacity: isSelected ? 0.88 : 0.72,
        };
      },
      onEachFeature: (feature, layer) => {
        const id = String(feature.properties?.id ?? "");
        const item = valueById.get(id);
        const tooltip = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = item?.name ?? String(feature.properties?.name ?? id);
        const measure = document.createElement("span");
        measure.textContent = item?.dataId
          ? `${geographyLabel} · ${formatValue(item.value, item.unit, view, false, item.changeMode)}`
          : `No ${provider} data for this ${geographyLabel.toLowerCase()}`;
        const growth = document.createElement("span");
        growth.textContent = item?.dataId
          ? `Change from one year earlier: ${formatValue(item.yoy, item.unit, "yoy", false, item.changeMode)}`
          : "Boundary shown for geographic context";
        const quality = document.createElement("span");
        quality.textContent = item?.qualityFlagged
          ? "Provider quality flag — review before reporting"
          : "";
        const location = document.createElement("span");
        location.textContent = item?.county ?? "";
        tooltip.append(name, location, measure, growth);
        if (item?.qualityFlagged) tooltip.append(quality);
        layer.bindTooltip(tooltip, { sticky: true, direction: "top" });
        if (item?.dataId) layer.on("click", () => onSelectRef.current(item.dataId!));
      },
    }).addTo(map);
    layerRef.current = overlay;
    const fitKey = `${county}:${dataset.geography}`;
    if (lastFitKey.current !== fitKey) {
      map.fitBounds(L.latLngBounds(focusedMapBounds(county, shapes.bounds)), DEFAULT_MAP_FIT_OPTIONS);
      lastFitKey.current = fitKey;
    }
    map.invalidateSize({ pan: false });
  }, [
    county,
    dataset.geography,
    geographyLabel,
    high,
    indexBaseMonth,
    low,
    mapReady,
    provider,
    selectedId,
    shapes,
    fillById,
    valueById,
    view,
  ]);

  function resetMap() {
    const L = leafletRef.current;
    if (L && mapRef.current) {
      mapRef.current.fitBounds(L.latLngBounds(focusedMapBounds(county, shapes.bounds)), DEFAULT_MAP_FIT_OPTIONS);
    }
  }

  return (
    <div className="map-panel">
      <div className="map-heading">
        <div>
          <p className="section-kicker">Map · {geographyLabel}</p>
          <h3>{countyLabel}</h3>
          <p><strong>{metricLabel}</strong> · {viewLabel} · {dates.length ? shortDate(dates.at(-1)!) : "latest observation"}</p>
        </div>
        <div className="map-tools">
          <div className="map-actions">
            <div className="map-palette" role="group" aria-label="Map color gradient">
              <span>Color</span>
              {(["navy", "orange"] as MapPaletteKey[]).map((option) => (
                <button key={option} type="button" className={paletteKey === option ? "active" : ""} onClick={() => onPaletteChange(option)}>
                  {option === "navy" ? "Navy" : "Orange"}
                </button>
              ))}
            </div>
            <button type="button" className="map-reset" onClick={resetMap}><RotateCcw /> Reset map</button>
          </div>
          <div className="map-legend" role="list" aria-label="Map legend">
            <span className="map-legend-item map-legend-scale" role="listitem">
              <span className="map-legend-label">{provider} data</span>
              {formatValue(low, values[0]?.unit ?? "number", view, false, values[0]?.changeMode)}
              <i className="map-gradient" style={{ background: `linear-gradient(90deg, ${palette.join(",")})` }} />
              {formatValue(high, values[0]?.unit ?? "number", view, false, values[0]?.changeMode)}
            </span>
            {showQuality && <span className="map-legend-item" role="listitem"><i className="map-swatch flagged" />Provider flagged</span>}
            <span className="map-legend-item" role="listitem"><i className="map-swatch no-data" />No {provider} data</span>
            <span className="map-legend-item" role="listitem"><i className="map-swatch outside" />{outsideGeographyLabel}</span>
          </div>
        </div>
      </div>
      {selected && (
        <div className="map-selection" aria-live="polite">
          <strong>{selected.name}</strong>
          <span>{geographyLabel} · {selected.county}</span>
          <span>{metricLabel}: {formatValue(selected.value, selected.unit, view, false, selected.changeMode)}</span>
          <span>Change from one year earlier: {formatValue(selected.yoy, selected.unit, "yoy", false, selected.changeMode)}</span>
          {selected.qualityFlagged && <span className="quality-text">Provider flagged</span>}
        </div>
      )}
      <div
        ref={containerRef}
        className="leaflet-map"
        role="region"
        aria-label={`${countyLabel} ${geographyLabel.toLowerCase()} map of ${metricLabel.toLowerCase()}`}
      />
      <p className="map-coverage">{observed} of {shapes.regions.length} boundaries have a current {provider} observation for this measure{showQuality ? `; ${flagged} are provider-flagged` : ""}. Gray boundaries have no data; unshaded map areas are outside the displayed {dataset.geography === "city" ? "city/CDP" : "ZCTA"} geography. Hover or tap a boundary for details; click a data region to update the focus series.</p>
      <FigureAttribution sources={mapSources} boundaries basemap />
    </div>
  );
}

function DefinitionHelp({ label, definition }: { label: string; definition: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Definition of ${label}`}
        className="definition-help"
        type="button"
      >
        ?
      </TooltipTrigger>
      <TooltipContent className="definition-tooltip" sideOffset={6}>
        {definition}
      </TooltipContent>
    </Tooltip>
  );
}

function MetricHeading({ metric, fallback }: { metric?: Metric; fallback: string }) {
  return (
    <span className="metric-heading">
      {metric?.label ?? fallback}
      {metric?.definition && <DefinitionHelp label={metric.label} definition={metric.definition} />}
    </span>
  );
}

function SourceBadge({ provider, frequency }: { provider: string; frequency?: string }) {
  const providerClass = provider.toLowerCase().startsWith("realtor")
    ? "realtor"
    : provider.toLowerCase();
  return <span className={`source-badge ${providerClass}`}>Source: {provider}{frequency ? ` · ${frequency}` : ""}</span>;
}

function Kpi({ label, value, note, definition }: { label: string; value: string; note: string; definition?: string }) {
  return (
    <Card className="kpi-card">
      <CardContent className="p-4">
        <p className="kpi-label">{label}{definition && <DefinitionHelp label={label} definition={definition} />}</p>
        <p className="kpi-value">{value}</p>
        <p className="kpi-note">{note}</p>
      </CardContent>
    </Card>
  );
}

export default function MarketLab() {
  const [datasets, setDatasets] = useState<Record<string, Dataset> | null>(null);
  const [activityDatasets, setActivityDatasets] = useState<Record<string, Dataset> | null>(null);
  const [realtorDataset, setRealtorDataset] = useState<Dataset | null>(null);
  const [maps, setMaps] = useState<Record<string, MapData> | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [redfinManifest, setRedfinManifest] = useState<RedfinManifest | null>(null);
  const [realtorManifests, setRealtorManifests] = useState<Partial<Record<"inventory" | "hotness", RealtorManifest>>>({});
  const [cpi, setCpi] = useState<CpiDataset | null>(null);
  const [cpiManifest, setCpiManifest] = useState<CpiManifest | null>(null);
  const [permitManifests, setPermitManifests] = useState<{ history: PermitManifest; provisional: PermitManifest } | null>(null);
  const [acsManifest, setAcsManifest] = useState<AcsManifestSummary | null>(null);
  const [mainTab, setMainTab] = useState("local");
  const [cpiError, setCpiError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [realtorError, setRealtorError] = useState("");
  const [error, setError] = useState("");
  const [geography, setGeography] = useState<"city" | "zip">("city");
  const [county, setCounty] = useState("Orange County");
  const [metric, setMetric] = useState<MetricKey>("zhvi");
  const [view, setView] = useState<ViewKey>("level");
  const [timeRange, setTimeRange] = useState<TimeRange>("max");
  const [indexBaseRequest, setIndexBaseRequest] = useState("2015-01");
  const [rankBy, setRankBy] = useState<RankKey>("growth");
  const [mapPalette, setMapPalette] = useState<MapPaletteKey>("orange");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addId, setAddId] = useState("");
  const [activitySelectedIds, setActivitySelectedIds] = useState<string[]>([]);
  const [activityAddId, setActivityAddId] = useState("");
  const [activityLens, setActivityLens] = useState<ActivityLens>("redfin");
  const [realtorSelectedIds, setRealtorSelectedIds] = useState<string[]>([]);
  const [realtorAddId, setRealtorAddId] = useState("");
  const [regionalMetric, setRegionalMetric] = useState<MetricKey>("zhvi");
  const [regionalView, setRegionalView] = useState<ViewKey>("index");
  const [regionalTimeRange, setRegionalTimeRange] = useState<TimeRange>("max");
  const [regionalIndexBaseRequest, setRegionalIndexBaseRequest] = useState("2015-01");
  const [regionalIds, setRegionalIds] = useState<string[]>([]);
  const [regionalAddId, setRegionalAddId] = useState("");
  const [copied, setCopied] = useState(false);
  const [activityMetric, setActivityMetric] = useState<MetricKey>("months_supply");
  const [realtorMetric, setRealtorMetric] = useState<MetricKey>("active_listing_count");
  const [activityView, setActivityView] = useState<Exclude<ViewKey, "index">>("level");
  const [realtorView, setRealtorView] = useState<ViewKey>("yoy");
  const [realtorIndexBaseRequest, setRealtorIndexBaseRequest] = useState("2020-01");
  const [activityTimeRange, setActivityTimeRange] = useState<TimeRange>("5y");
  const [realtorTimeRange, setRealtorTimeRange] = useState<TimeRange>("5y");
  const [activityRankBy, setActivityRankBy] = useState<RankKey>("growth");
  const [realtorRankBy, setRealtorRankBy] = useState<RankKey>("growth");
  const [priceBasis, setPriceBasis] = useState<PriceBasis>("nominal");
  const [deflatorKey, setDeflatorKey] = useState<CpiSeriesKey>("la");
  const [realBaseRequest, setRealBaseRequest] = useState("");
  const [showLocalInflation, setShowLocalInflation] = useState(true);
  const [regionalPriceBasis, setRegionalPriceBasis] = useState<PriceBasis>("nominal");
  const [regionalRealBaseRequest, setRegionalRealBaseRequest] = useState("");
  const [showRegionalInflation, setShowRegionalInflation] = useState(true);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    async function loadAcsProvenance() {
      try {
        const pointer = await fetchJson<{ release: string }>(`${base}/data/acs/latest.json`);
        const releaseManifest = await fetchJson<AcsManifestSummary>(`${base}/data/acs/releases/${pointer.release}/manifest.json`);
        setAcsManifest(releaseManifest);
      } catch {
        setAcsManifest(null);
      }
    }
    async function load() {
      try {
        const pointer = await fetch(`${base}/data/latest.json`).then((response) => {
          if (!response.ok) throw new Error("No published data release was found.");
          return response.json() as Promise<{ release: string }>;
        });
        const releaseBase = `${base}/data/releases/${pointer.release}`;
        const releaseManifest = await fetchJson<Manifest>(`${releaseBase}/manifest.json`);
        const [city, zip, metro] = await Promise.all([
          loadDatasetFiles(releaseBase, releaseManifest.files?.city, "city.json"),
          loadDatasetFiles(releaseBase, releaseManifest.files?.zip, "zip.json"),
          loadDatasetFiles(releaseBase, releaseManifest.files?.metro, "metro.json"),
        ]);
        let mapCity: MapData;
        let mapZip: MapData;
        try {
          const mapPointer = await fetchJson<{ release: string }>(`${base}/data/maps/latest.json`);
          const mapBase = `${base}/data/maps/releases/${mapPointer.release}`;
          const mapManifest = await fetchJson<{ files: Record<"city" | "zip", string[]> }>(`${mapBase}/manifest.json`);
          [mapCity, mapZip] = await Promise.all([
            loadMapFiles(mapBase, mapManifest.files.city),
            loadMapFiles(mapBase, mapManifest.files.zip),
          ]);
        } catch {
          [mapCity, mapZip] = await Promise.all([
            fetchJson<MapData>(`${releaseBase}/map-city.json`),
            fetchJson<MapData>(`${releaseBase}/map-zip.json`),
          ]);
        }
        setDatasets({ city, zip, metro });
        setMaps({ city: mapCity, zip: mapZip });
        setManifest(releaseManifest);
        try {
          const cpiPointer = await fetch(`${base}/data/cpi/latest.json`).then((response) => {
            if (!response.ok) throw new Error("No validated BLS CPI release was found.");
            return response.json() as Promise<{ release: string }>;
          });
          const cpiBase = `${base}/data/cpi/releases/${cpiPointer.release}`;
          const [cpiDataset, cpiReleaseManifest] = await Promise.all([
            fetch(`${cpiBase}/cpi.json`).then((response) => response.json()),
            fetch(`${cpiBase}/manifest.json`).then((response) => response.json()),
          ]);
          setCpi(cpiDataset);
          setCpiManifest(cpiReleaseManifest);
        } catch (caught) {
          setCpiError(caught instanceof Error ? caught.message : "The BLS CPI release could not be loaded.");
        }
        try {
          const redfinPointer = await fetch(`${base}/data/redfin/latest.json`).then((response) => {
            if (!response.ok) throw new Error("No validated Redfin release was found.");
            return response.json() as Promise<{ release: string }>;
          });
          const redfinBase = `${base}/data/redfin/releases/${redfinPointer.release}`;
          const redfinReleaseManifest = await fetchJson<RedfinManifest>(`${redfinBase}/manifest.json`);
          const [redfinCity, redfinZip] = await Promise.all([
            loadDatasetFiles(redfinBase, redfinReleaseManifest.files?.city, "city.json"),
            loadDatasetFiles(redfinBase, redfinReleaseManifest.files?.zip, "zip.json"),
          ]);
          setActivityDatasets({ city: redfinCity, zip: redfinZip });
          setRedfinManifest(redfinReleaseManifest);
          const redfinOrangeCities = (redfinCity as Dataset).regions.filter(
            (region) => region.county === "Orange County",
          );
          const redfinDefaults = ["Fullerton", "Irvine", "Anaheim"]
            .map((name) => redfinOrangeCities.find((region) => region.name === name)?.id)
            .filter((id): id is string => Boolean(id));
          setActivitySelectedIds(
            redfinDefaults.length
              ? redfinDefaults
              : redfinOrangeCities.slice(0, 3).map((region) => region.id),
          );
        } catch (caught) {
          setActivityError(caught instanceof Error ? caught.message : "The Redfin activity release could not be loaded.");
        }
        try {
          const products = ["inventory", "hotness"] as const;
          const results = await Promise.allSettled(products.map(async (product) => {
            const pointer = await fetch(`${base}/data/realtor/${product}/latest.json`).then((response) => {
              if (!response.ok) throw new Error(`No validated Realtor.com ${product} release was found.`);
              return response.json() as Promise<{ release: string }>;
            });
            const productBase = `${base}/data/realtor/${product}/releases/${pointer.release}`;
            const productManifest = await fetchJson<RealtorManifest>(`${productBase}/manifest.json`);
            const productDataset = await loadDatasetFiles(
              productBase,
              productManifest.files?.zip,
              "zip.json",
            );
            return { product, dataset: productDataset, manifest: productManifest };
          }));
          const loaded = results
            .filter((result): result is PromiseFulfilledResult<{
              product: "inventory" | "hotness";
              dataset: Dataset;
              manifest: RealtorManifest;
            }> => result.status === "fulfilled")
            .map((result) => result.value);
          if (!loaded.length) throw new Error("No validated Realtor.com release could be loaded.");
          const combined = mergeDatasets(loaded.map((result) => result.dataset));
          setRealtorDataset(combined);
          setRealtorManifests(Object.fromEntries(
            loaded.map((result) => [result.product, result.manifest]),
          ));
          const firstMetric = REALTOR_METRICS.find((option) => combined?.metrics[option.key]);
          if (firstMetric) setRealtorMetric(firstMetric.key);
          const orangeZips = combined?.regions.filter((region) => region.county === "Orange County") ?? [];
          const preferred = ["92831", "92832", "92833"]
            .map((name) => orangeZips.find((region) => region.name === name)?.id)
            .filter((id): id is string => Boolean(id));
          setRealtorSelectedIds(preferred.length ? preferred : orangeZips.slice(0, 3).map((region) => region.id));
          const failed = results.filter((result) => result.status === "rejected").length;
          if (failed) setRealtorError("One Realtor.com product is delayed or temporarily unavailable; the other validated release remains available.");
        } catch (caught) {
          setRealtorError(caught instanceof Error ? caught.message : "The Realtor.com release could not be loaded.");
        }
        try {
          const [historyPointer, provisionalPointer] = await Promise.all([
            fetchJson<{ release: string }>(`${base}/data/permits/history/latest.json`),
            fetchJson<{ release: string }>(`${base}/data/permits/provisional/latest.json`),
          ]);
          const [history, provisional] = await Promise.all([
            fetchJson<PermitManifest>(`${base}/data/permits/history/releases/${historyPointer.release}/manifest.json`),
            fetchJson<PermitManifest>(`${base}/data/permits/provisional/releases/${provisionalPointer.release}/manifest.json`),
          ]);
          setPermitManifests({ history, provisional });
        } catch {
          setPermitManifests(null);
        }
        const orangeCities = (city as Dataset).regions.filter((region) => region.county === "Orange County");
        const defaults = ["Fullerton", "Irvine", "Anaheim"]
          .map((name) => orangeCities.find((region) => region.name === name)?.id)
          .filter((id): id is string => Boolean(id));
        setSelectedIds(defaults.length ? defaults : orangeCities.slice(0, 3).map((region) => region.id));
        const metros = (metro as Dataset).regions;
        setRegionalIds(
          ["Los Angeles, CA", "Riverside, CA", "San Diego, CA"]
            .map((name) => metros.find((region) => region.name === name)?.id)
            .filter((id): id is string => Boolean(id)),
        );
        const query = new URLSearchParams(window.location.search);
        const queryGeo = query.get("geo");
        const queryCounty = query.get("county");
        const queryMetric = query.get("metric");
        const queryView = query.get("view");
        const queryRange = query.get("range");
        const queryBase = query.get("base");
        const queryPalette = query.get("palette");
        const queryBasis = query.get("basis");
        const queryDeflator = query.get("deflator");
        const queryRealBase = query.get("real_base");
        const queryInflation = query.get("inflation");
        const restoredGeo = queryGeo === "zip" ? "zip" : "city";
        const restoredCounty = COUNTY_OPTIONS.includes(queryCounty ?? "") ? queryCounty! : "Orange County";
        const restoredDataset = restoredGeo === "zip" ? (zip as Dataset) : (city as Dataset);
        const restoredIds = (query.get("regions") ?? "")
          .split(",")
          .filter((id) =>
            restoredDataset.regions.some(
              (region) =>
                region.id === id &&
                (restoredCounty === "Both" || region.county === restoredCounty),
            ),
          )
          .slice(0, 5);
        setGeography(restoredGeo);
        setCounty(restoredCounty);
        if (LOCAL_METRICS.some((item) => item.key === queryMetric)) setMetric(queryMetric as MetricKey);
        if (["level", "yoy", "index"].includes(queryView ?? "")) setView(queryView as ViewKey);
        if (["1y", "3y", "5y", "max"].includes(queryRange ?? "")) setTimeRange(queryRange as TimeRange);
        if (/^\d{4}-\d{2}$/.test(queryBase ?? "")) setIndexBaseRequest(queryBase!);
        if (queryPalette === "navy" || queryPalette === "orange") setMapPalette(queryPalette);
        if (queryBasis === "real") setPriceBasis("real");
        if (queryDeflator === "la" || queryDeflator === "us") setDeflatorKey(queryDeflator);
        if (/^\d{4}-\d{2}$/.test(queryRealBase ?? "")) setRealBaseRequest(queryRealBase!);
        if (queryInflation === "0") setShowLocalInflation(false);
        if (restoredIds.length) setSelectedIds(restoredIds);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The data release could not be loaded.");
      }
    }
    void loadAcsProvenance();
    load();
  }, []);

  const dataset = datasets?.[geography];
  const localDates = dataset ? metricDates(dataset, metric) : [];
  const indexBaseMonth = normalizedBaseMonth(localDates, indexBaseRequest);
  const localMetricSupportsReal = metric === "zhvi" || metric === "zori";
  const localCpi = cpi?.series[deflatorKey] ?? null;
  const realBaseMonth = normalizedRealBaseMonth(localCpi, localDates, realBaseRequest);
  const localBasis: PriceBasis = localMetricSupportsReal && priceBasis === "real" && localCpi
    ? "real"
    : "nominal";
  const localPriceAdjustment: PriceAdjustment = {
    basis: localBasis,
    cpi: localCpi,
    baseMonth: realBaseMonth,
    interpolationRules: cpi?.real_value_interpolation ?? [],
  };
  const localRealBaseMonths = observedCpiMonths(localCpi, localDates);
  const regionalDates = datasets ? metricDates(datasets.metro, regionalMetric) : [];
  const regionalIndexBaseMonth = normalizedBaseMonth(regionalDates, regionalIndexBaseRequest);
  const regionalMetricSupportsReal = regionalMetric === "zhvi" || regionalMetric === "zori";
  const regionalCpi = cpi?.series.us ?? null;
  const regionalRealBaseMonth = normalizedRealBaseMonth(regionalCpi, regionalDates, regionalRealBaseRequest);
  const regionalBasis: PriceBasis = regionalMetricSupportsReal && regionalPriceBasis === "real" && regionalCpi
    ? "real"
    : "nominal";
  const regionalPriceAdjustment: PriceAdjustment = {
    basis: regionalBasis,
    cpi: regionalCpi,
    baseMonth: regionalRealBaseMonth,
    interpolationRules: cpi?.real_value_interpolation ?? [],
  };
  const regionalRealBaseMonths = observedCpiMonths(regionalCpi, regionalDates);
  const eligible = useMemo(
    () =>
      dataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [],
    [dataset, county],
  );

  const selectedRegions = selectedIds
    .map((id) => eligible.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(region));
  const primary = selectedRegions[0];
  const primarySeries = dataset && primary
    ? metricSeries(dataset, primary, metric, localPriceAdjustment)
    : null;
  const primaryLast = primarySeries ? lastValue(primarySeries.values) : null;
  const primaryYoy = primarySeries
    ? lastValue(transformValues(primarySeries.values, "yoy", primarySeries.dates))
    : null;
  const primaryObservationMonth = primaryLast && primarySeries
    ? primarySeries.dates[primaryLast.index].slice(0, 7)
    : "";
  const localInflation = cpiYoyAtMonth(localCpi, primaryObservationMonth);
  const fiveYear = (() => {
    if (!primarySeries || !primaryLast) return null;
    const prior = primarySeries.values[primaryLast.index - 60];
    return prior != null && prior !== 0 ? primaryLast.value / prior - 1 : null;
  })();
  const ranked = (() => {
    if (!dataset) return [];
    return eligible
      .map((region) => {
        const series = metricSeries(dataset, region, metric, localPriceAdjustment);
        const level = lastValue(series.values)?.value ?? null;
        const yoy = lastValue(transformValues(series.values, "yoy", series.dates))?.value ?? null;
        return { region, level, yoy, unit: series.unit };
      })
      .filter((item) => item.level != null)
      .sort((a, b) =>
        rankBy === "growth"
          ? (b.yoy ?? -Infinity) - (a.yoy ?? -Infinity)
          : (b.level ?? -Infinity) - (a.level ?? -Infinity),
      );
  })();
  const rank = primary ? ranked.findIndex((item) => item.region.id === primary.id) + 1 : 0;
  const unit = primarySeries?.unit ?? "number";

  const redfinActivityDataset = activityDatasets?.[geography];
  const activityDataset = activityLens === "redfin" ? redfinActivityDataset : realtorDataset;
  const activeActivityMetric = activityLens === "redfin" ? activityMetric : realtorMetric;
  const activeActivitySelectedIds = activityLens === "redfin" ? activitySelectedIds : realtorSelectedIds;
  const activeActivityAddId = activityLens === "redfin" ? activityAddId : realtorAddId;
  const activeActivityView = activityLens === "redfin" ? activityView : realtorView;
  const activeActivityTimeRange = activityLens === "redfin" ? activityTimeRange : realtorTimeRange;
  const activeActivityRankBy = activityLens === "redfin" ? activityRankBy : realtorRankBy;
  const activityMetricOptions = (activityLens === "redfin" ? ACTIVITY_METRICS : REALTOR_METRICS)
    .filter((option) => activityDataset?.metrics[option.key]);
  const activityDates = activityDataset ? metricDates(activityDataset, activeActivityMetric) : [];
  const activityIndexBaseMonth = activityLens === "realtor"
    ? normalizedBaseMonth(activityDates, realtorIndexBaseRequest)
    : "";
  const activityEligible = useMemo(
    () => activityDataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [],
    [activityDataset, county],
  );
  const activitySelectedRegions = (() => {
    const selected = activeActivitySelectedIds
      .map((id) => activityEligible.find((region) => region.id === id))
      .filter((region): region is Region => Boolean(region));
    return selected;
  })();
  const activityPrimary = activitySelectedRegions[0];
  const activityPrimarySeries = activityDataset && activityPrimary
    ? metricSeries(activityDataset, activityPrimary, activeActivityMetric)
    : null;
  const activityLast = activityPrimarySeries ? lastValue(activityPrimarySeries.values) : null;
  const activityYoy = activityPrimarySeries
    ? lastValue(transformValues(
        activityPrimarySeries.values,
        "yoy",
        activityPrimarySeries.dates,
        "",
        activityPrimarySeries.changeMode,
      ))
    : null;
  const activityLastFlagged = activityLens === "realtor" && activityLast
    ? Boolean(activityPrimarySeries?.qualityFlags?.[activityLast.index])
    : false;
  const activityYoyFlagged = activityLens === "realtor" && activityYoy
    ? Boolean(transformQualityFlags(activityPrimarySeries?.qualityFlags ?? [], "yoy")[activityYoy.index])
    : false;
  const activityFiveYear = (() => {
    if (!activityPrimarySeries || !activityLast) return null;
    const prior = activityPrimarySeries.values[activityLast.index - 60];
    if (prior == null) return null;
    return activityPrimarySeries.changeMode === "percent"
      ? (prior !== 0 ? activityLast.value / prior - 1 : null)
      : activityLast.value - prior;
  })();
  const activityRanked = useMemo(() => {
    if (!activityDataset) return [];
    return activityEligible
      .map((region) => {
        const series = metricSeries(activityDataset, region, activeActivityMetric);
        const yoyValues = transformValues(series.values, "yoy", series.dates, "", series.changeMode);
        const level = series.values.at(-1) ?? null;
        const yoy = yoyValues.at(-1) ?? null;
        const levelFlagged = Boolean(series.qualityFlags?.at(-1));
        const yoyFlagged = Boolean(transformQualityFlags(series.qualityFlags ?? [], "yoy").at(-1));
        return {
          region,
          level,
          yoy,
          qualityFlagged: activityLens === "realtor" && (levelFlagged || yoyFlagged),
          unit: series.unit,
          changeMode: series.changeMode,
        };
      })
      .filter((item) => item.level != null)
      .sort((a, b) => activeActivityRankBy === "growth"
        ? (b.yoy ?? -Infinity) - (a.yoy ?? -Infinity)
        : (b.level ?? -Infinity) - (a.level ?? -Infinity));
  }, [activityDataset, activityEligible, activeActivityMetric, activeActivityRankBy, activityLens]);
  const activityRank = activityPrimary
    ? activityRanked.findIndex((item) => item.region.id === activityPrimary.id) + 1
    : 0;

  function changeGeography(next: string) {
    if (!datasets) return;
    const nextGeo = next as "city" | "zip";
    const nextRegions = datasets[nextGeo].regions.filter(
      (region) => county === "Both" || region.county === county,
    );
    const preferred = nextGeo === "city" ? "Fullerton" : "92831";
    const first = nextRegions.find((region) => region.name === preferred) ?? nextRegions[0];
    setGeography(nextGeo);
    setSelectedIds(first ? [first.id] : []);
    const nextActivityRegions = activityDatasets?.[nextGeo].regions.filter(
      (region) => county === "Both" || region.county === county,
    ) ?? [];
    const activityFirst = nextActivityRegions.find((region) => region.name === preferred)
      ?? nextActivityRegions[0];
    setActivitySelectedIds(activityFirst ? [activityFirst.id] : []);
  }

  function changeCounty(next: string) {
    if (!dataset) return;
    const nextRegions = dataset.regions.filter(
      (region) => next === "Both" || region.county === next,
    );
    const preferred = geography === "city" ? "Fullerton" : "92831";
    const first = nextRegions.find((region) => region.name === preferred) ?? nextRegions[0];
    setCounty(next);
    setSelectedIds(first ? [first.id] : []);
    const nextActivityRegions = redfinActivityDataset?.regions.filter(
      (region) => next === "Both" || region.county === next,
    ) ?? [];
    const activityFirst = nextActivityRegions.find((region) => region.name === preferred)
      ?? nextActivityRegions[0];
    setActivitySelectedIds(activityFirst ? [activityFirst.id] : []);
    const nextRealtorRegions = realtorDataset?.regions.filter(
      (region) => next === "Both" || region.county === next,
    ) ?? [];
    const realtorPreferred = ["92831", "92832", "92833"]
      .map((name) => nextRealtorRegions.find((region) => region.name === name)?.id)
      .filter((id): id is string => Boolean(id));
    setRealtorSelectedIds(
      realtorPreferred.length ? realtorPreferred : nextRealtorRegions.slice(0, 3).map((region) => region.id),
    );
  }

  function addRegion() {
    if (!addId || selectedIds.includes(addId) || selectedIds.length >= 5) return;
    setSelectedIds((current) => [...current, addId]);
    setAddId("");
  }

  function selectPrimary(id: string) {
    setSelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
  }

  function togglePlaceSelection(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 5) return current;
      return [id, ...current];
    });
  }

  function addActivityRegion() {
    if (!activeActivityAddId || activeActivitySelectedIds.includes(activeActivityAddId) || activeActivitySelectedIds.length >= 5) return;
    if (activityLens === "redfin") {
      setActivitySelectedIds((current) => [...current, activeActivityAddId]);
      setActivityAddId("");
    } else {
      setRealtorSelectedIds((current) => [...current, activeActivityAddId]);
      setRealtorAddId("");
    }
  }

  function addRegionalMetro() {
    if (!regionalAddId || regionalIds.includes(regionalAddId) || regionalIds.length >= 5) return;
    setRegionalIds((current) => [...current, regionalAddId]);
    setRegionalAddId("");
  }

  function selectActivityPrimary(id: string) {
    if (activityLens === "redfin") {
      setActivitySelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
    } else {
      setRealtorSelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
    }
  }

  function toggleActivityPlaceSelection(id: string) {
    const toggle = (current: string[]) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 5) return current;
      return [id, ...current];
    };
    if (activityLens === "redfin") {
      setActivitySelectedIds(toggle);
    } else {
      setRealtorSelectedIds(toggle);
    }
  }

  function removeActivityRegion(id: string) {
    if (activityLens === "redfin") {
      setActivitySelectedIds((current) => current.filter((item) => item !== id));
    } else {
      setRealtorSelectedIds((current) => current.filter((item) => item !== id));
    }
  }

  function changeActivityMetric(next: string) {
    if (activityLens === "redfin") setActivityMetric(next as MetricKey);
    else setRealtorMetric(next as MetricKey);
  }

  function changeActivityView(next: string) {
    if (activityLens === "redfin") setActivityView(next as Exclude<ViewKey, "index">);
    else setRealtorView(next as ViewKey);
  }

  function changeActivityTimeRange(next: TimeRange) {
    if (activityLens === "redfin") setActivityTimeRange(next);
    else setRealtorTimeRange(next);
  }

  function changeActivityRankBy(next: string) {
    if (activityLens === "redfin") setActivityRankBy(next as RankKey);
    else setRealtorRankBy(next as RankKey);
  }

  async function copyLink() {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("geo", geography);
    url.searchParams.set("county", county);
    url.searchParams.set("metric", metric);
    url.searchParams.set("view", view);
    url.searchParams.set("range", timeRange);
    if (view === "index") url.searchParams.set("base", indexBaseMonth);
    if (localBasis === "real") {
      url.searchParams.set("basis", "real");
      url.searchParams.set("deflator", deflatorKey);
      url.searchParams.set("real_base", realBaseMonth);
    }
    if (!showLocalInflation) url.searchParams.set("inflation", "0");
    url.searchParams.set("palette", mapPalette);
    url.searchParams.set("regions", selectedIds.join(","));
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function openReleaseProvenance(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setMainTab("methods");
    window.setTimeout(() => {
      document.getElementById("current-release-provenance")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      window.history.replaceState(null, "", "#current-release-provenance");
    }, 0);
  }

  if (error) {
    return <main className="status-screen"><Info /><h1>Housing Market Lab</h1><p>{error}</p></main>;
  }
  if (!datasets || !maps || !manifest || !dataset) {
    return <main className="status-screen"><div className="loader" /><h1>Housing Market Lab</h1><p>Loading the latest validated release…</p></main>;
  }

  const nominalMetricLabel = LOCAL_METRICS.find((item) => item.key === metric)?.label ?? metric;
  const currentMetricLabel = localBasis === "real"
    ? `Real ${nominalMetricLabel.toLowerCase()}`
    : nominalMetricLabel;
  const currentMetricMetadata = metric === "price_rent"
    ? {
        dates: localDates,
        label: "Price–rent multiple",
        short_label: "Price–rent",
        unit: "multiple",
        decimals: 1,
        definition: "Typical Zillow home value divided by twelve months of typical Zillow observed asking rent. It is not a capitalization rate or investment return.",
        provider: "Zillow-derived",
        frequency: "Monthly",
      }
    : {
        ...dataset.metrics[metric],
        label: currentMetricLabel,
        definition: localBasis === "real"
          ? `${dataset.metrics[metric].definition} Expressed in ${shortDate(`${realBaseMonth}-01`)} dollars using ${localCpi?.long_label}.`
          : dataset.metrics[metric].definition,
      };
  const activityMetricMetadata = activityDataset?.metrics[activeActivityMetric];
  const realtorCurrentManifest = activityMetricMetadata?.source_product
    ? realtorManifests[activityMetricMetadata.source_product]
    : undefined;
  const activityFreshnessDate = activityDates.at(-1)
    ?? (activityLens === "redfin"
      ? redfinManifest?.release ?? manifest.release
      : realtorCurrentManifest?.release ?? manifest.release);
  const realtorSupportValue = (metricKey: MetricKey) => {
    if (activityLens !== "realtor" || !activityDataset || !activityPrimary || !activityDataset.metrics[metricKey]) return null;
    const series = metricSeries(activityDataset, activityPrimary, metricKey);
    return lastValue(series.values)?.value ?? null;
  };
  const regionalMetricMetadata = {
    ...datasets.metro.metrics[regionalMetric],
    label: regionalBasis === "real"
      ? `Real ${datasets.metro.metrics[regionalMetric].label.toLowerCase()}`
      : datasets.metro.metrics[regionalMetric].label,
  };
  const regionalRegions = regionalIds
    .map((id) => datasets.metro.regions.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(region));
  const localInflationOverlays = showLocalInflation && localMetricSupportsReal && view === "yoy"
    ? cpiOverlay(localCpi, view)
    : [];
  const regionalInflationOverlays = showRegionalInflation && regionalMetricSupportsReal && (regionalView === "yoy" || regionalView === "index")
    ? cpiOverlay(regionalCpi, regionalView)
    : [];

  return (
    <TooltipProvider delayDuration={120}>
    <main>
      <header className="site-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Real Estate Analytics</p>
            <h1><a className="header-link" href="./" aria-label="Housing Market Lab home">Housing Market Lab</a></h1>
            <p className="byline">Created by <a className="header-link" href="https://desenlin.com/">Desen Lin</a>, <a className="header-link" href="https://www.fullerton.edu/">California State University, Fullerton</a>.</p>
            <p className="deck">Southern California housing data for teaching and research.</p>
          </div>
          <a className="release-stamp release-stamp-link" href="#current-release-provenance" onClick={openReleaseProvenance}>
            <span>Latest validated release</span>
            <strong>{manifest.release}</strong>
            <small>Data through {shortDate(Object.values(manifest.latest_observations).sort().at(-1) ?? manifest.release)}</small>
          </a>
        </div>
      </header>

      <Tabs value={mainTab} onValueChange={setMainTab} className="page-shell">
        <TabsList variant="line" className="main-tabs" aria-label="Dashboard sections">
          <TabsTrigger value="local">Prices &amp; Rents</TabsTrigger>
          <TabsTrigger value="activity">Market Conditions</TabsTrigger>
          <TabsTrigger value="permits">Building Permits</TabsTrigger>
          <TabsTrigger value="context">Housing Context</TabsTrigger>
          <TabsTrigger value="regional">Metro Comparisons</TabsTrigger>
          <TabsTrigger value="facts">Market Brief</TabsTrigger>
          <TabsTrigger value="methods">Data &amp; methods</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="space-y-5">
          <section className="control-deck" aria-label="Local market controls">
            <div className="source-strip">
              <SourceBadge provider={currentMetricMetadata.provider ?? "Zillow"} frequency={currentMetricMetadata.frequency ?? "Monthly"} />
              {localMetricSupportsReal && (localBasis === "real" || (view === "yoy" && showLocalInflation)) && cpiManifest && (
                <SourceBadge provider="BLS CPI-U" frequency="Monthly" />
              )}
              <span>Values and rents</span>
            </div>
            <div className="control-grid">
              <LabelledSelect label="County" value={county} onChange={changeCounty}>
                {COUNTY_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
              </LabelledSelect>
              <LabelledSelect label="Geography" value={geography} onChange={changeGeography}>
                <NativeSelectOption value="city">Cities &amp; communities</NativeSelectOption>
                <NativeSelectOption value="zip">ZIP codes</NativeSelectOption>
              </LabelledSelect>
              <LabelledSelect label="Metric" value={metric} onChange={(next) => setMetric(next as MetricKey)}>
                {LOCAL_METRICS.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}
              </LabelledSelect>
              <LabelledSelect label="View" value={view} onChange={(next) => setView(next as ViewKey)}>
                <NativeSelectOption value="level">Level</NativeSelectOption>
                <NativeSelectOption value="yoy">Year-over-year change</NativeSelectOption>
                <NativeSelectOption value="index">Indexed to 100</NativeSelectOption>
              </LabelledSelect>
            </div>
            {localMetricSupportsReal && (
              <div className="price-controls" aria-label="Inflation adjustment controls">
                <LabelledSelect label="Dollar terms" value={localBasis} onChange={(next) => setPriceBasis(next as PriceBasis)}>
                  <NativeSelectOption value="nominal">Nominal</NativeSelectOption>
                  <NativeSelectOption value="real" disabled={!cpi}>Real (inflation-adjusted)</NativeSelectOption>
                </LabelledSelect>
                {localBasis === "real" && (
                  <>
                    <LabelledSelect label="Deflator" value={deflatorKey} onChange={(next) => setDeflatorKey(next as CpiSeriesKey)}>
                      <NativeSelectOption value="la">LA-area CPI-U</NativeSelectOption>
                      <NativeSelectOption value="us">U.S. CPI-U</NativeSelectOption>
                    </LabelledSelect>
                    <RealBaseControl value={realBaseMonth} dates={localRealBaseMonths} onChange={setRealBaseRequest} />
                    <p className="price-basis-note">Values are expressed in {shortDate(`${realBaseMonth}-01`)} dollars. The base month changes the scale, not real growth.</p>
                  </>
                )}
                {!cpi && cpiError && <p className="price-basis-note warning">Real terms are temporarily unavailable; nominal data remain current.</p>}
              </div>
            )}
            <div className="comparison-row">
              <label className="control-label comparison-select">
                <span>Add a comparison (up to five)</span>
                <NativeSelect value={addId} onChange={(event) => setAddId(event.target.value)} className="w-full">
                  <NativeSelectOption value="">Choose a region…</NativeSelectOption>
                  {eligible.filter((region) => !selectedIds.includes(region.id)).map((region) => (
                    <NativeSelectOption key={region.id} value={region.id}>{region.name}{region.context ? ` · ${region.context}` : ""}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button variant="outline" onClick={addRegion} disabled={!addId || selectedIds.length >= 5}><Plus /> Add</Button>
              <Button variant="ghost" onClick={copyLink}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy view"}</Button>
            </div>
            <div className="chips" aria-label="Selected regions">
              {selectedRegions.map((region, index) => (
                <button key={region.id} className={index === 0 ? "chip primary" : "chip"} onClick={() => selectPrimary(region.id)}>
                  <i style={{ background: COLORS[index % COLORS.length] }} />
                  {region.name}{index === 0 ? " · focus" : ""}
                  {index > 0 && <X onClick={(event) => { event.stopPropagation(); setSelectedIds((ids) => ids.filter((id) => id !== region.id)); }} />}
                </button>
              ))}
            </div>
          </section>

          <section className="kpi-grid" aria-label="Current market summary">
            <Kpi label={currentMetricLabel} definition={currentMetricMetadata.definition} value={formatValue(primaryLast?.value ?? null, unit, "level")} note={primaryLast ? `As of ${shortDate(primarySeries!.dates[primaryLast.index])}` : "No observation"} />
            <Kpi
              label={localBasis === "real" ? "Real year over year" : "Year over year"}
              value={formatValue(primaryYoy?.value ?? null, unit, "yoy")}
              note={localInflation != null
                ? `${localCpi?.label} inflation: ${formatValue(localInflation, "number", "yoy")}`
                : "Versus the same month one year ago"}
            />
            <Kpi label="Five-year change" value={formatValue(fiveYear, unit, "yoy")} note="Longer view of the recent cycle" />
            <Kpi
              label={`${county === "Both" ? "Two-county" : county.replace(" County", "")} rank`}
              value={rank ? `${rank} of ${ranked.length}` : "—"}
              note={rankBy === "growth" ? "Ranked by change from one year earlier" : `Ranked by current ${currentMetricLabel.toLowerCase()}`}
            />
          </section>

          <section className="analysis-grid">
            <Card className="chart-card">
              <CardHeader className="chart-header">
                <div><p className="section-kicker">Time</p><CardTitle><MetricHeading metric={currentMetricMetadata} fallback={currentMetricLabel} /></CardTitle></div>
                <div className="chart-options">
                  <TimeRangeControl value={timeRange} onChange={setTimeRange} />
                  {view === "index" && (
                    <IndexBaseControl value={indexBaseMonth} dates={localDates} onChange={setIndexBaseRequest} />
                  )}
                  {view === "yoy" && localCpi && (
                    <InflationToggle checked={showLocalInflation} onCheckedChange={setShowLocalInflation} label={`Plot ${localCpi.label} inflation`} />
                  )}
                  <p>{view === "level"
                    ? localBasis === "real" ? `${shortDate(`${realBaseMonth}-01`)} dollars` : "Monthly level"
                    : view === "yoy" ? `${localBasis === "real" ? "Real " : ""}percent change from one year earlier`
                    : `${shortDate(`${indexBaseMonth}-01`)} = 100`}</p>
                </div>
              </CardHeader>
              <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
                <SeriesChart dataset={dataset} regions={selectedRegions} metric={metric} view={view} timeRange={timeRange} indexBaseMonth={indexBaseMonth} priceAdjustment={localPriceAdjustment} overlays={localInflationOverlays} />
                <FigureAttribution sources={localMetricSupportsReal && (localBasis === "real" || (view === "yoy" && showLocalInflation)) && cpiManifest ? ["zillow", "bls"] : ["zillow"]} />
                {localBasis === "real" && (
                  <p className="data-note">October 2025 uses a log-linear CPI interpolation between September and November because BLS did not publish that month. Official CPI overlays retain the gap; no other missing or trailing CPI month is filled.</p>
                )}
                {metric !== "zhvi" && selectedRegions.some((region) => metricSeries(dataset, region, metric).values.every((value) => value == null)) && (
                  <p className="data-note">Some regions are omitted where Zillow does not publish a usable rent history.</p>
                )}
              </CardContent>
            </Card>

            <Card className="ranking-card">
              <CardHeader>
                <div className="ranking-title">
                  <div><p className="section-kicker">Place</p><CardTitle>Market ranking</CardTitle></div>
                  <LabelledSelect label="Sort by" value={rankBy} onChange={(next) => setRankBy(next as RankKey)}>
                    <NativeSelectOption value="growth">12-month growth</NativeSelectOption>
                    <NativeSelectOption value="level">Current value</NativeSelectOption>
                  </LabelledSelect>
                </div>
                <div className="rank-columns" aria-hidden="true">
                  <span>#</span><span>Place</span><span>{currentMetricLabel}</span><span>Change from<br />one year earlier</span>
                </div>
              </CardHeader>
              <CardContent className="ranking-list">
                {ranked.map((item, index) => (
                  <button
                    key={item.region.id}
                    onClick={() => togglePlaceSelection(item.region.id)}
                    className={`rank-row${item.region.id === primary?.id ? " active" : selectedIds.includes(item.region.id) ? " selected" : ""}`}
                    aria-pressed={selectedIds.includes(item.region.id)}
                  >
                    <span className="rank-number">{index + 1}</span>
                    <span className="rank-name">{item.region.name}<small>{item.region.context}</small></span>
                    <strong>{formatValue(item.level, item.unit, "level")}</strong>
                    <span className={(item.yoy ?? 0) < 0 ? "negative" : "positive"}>{formatValue(item.yoy, item.unit, "yoy")}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className="maps-grid">
            <CountyMap county={county} mapData={maps[geography]} dataset={dataset} metric={metric} metricLabel={currentMetricLabel} view={view} indexBaseMonth={indexBaseMonth} selectedId={primary?.id ?? ""} onSelect={selectPrimary} paletteKey={mapPalette} onPaletteChange={setMapPalette} provider="Zillow" priceAdjustment={localPriceAdjustment} />
          </section>
        </TabsContent>

        <TabsContent value="activity" className="space-y-5">
          {(activityLens === "redfin" ? activityError || !redfinManifest : !realtorDataset)
            || !activityDataset || !activityMetricMetadata ? (
            <Card className="disclaimer-card">
              <CardHeader><CardTitle>Market activity is temporarily unavailable</CardTitle></CardHeader>
              <CardContent className="method-copy"><p>{activityLens === "redfin"
                ? activityError || "The latest Redfin release has not finished loading."
                : realtorError || "The latest Realtor.com release has not finished loading."} Zillow value and rent views remain available.</p>
                {activityLens === "realtor" && <Button variant="outline" onClick={() => setActivityLens("redfin")}>Return to Redfin activity</Button>}
              </CardContent>
            </Card>
          ) : (
            <>
              <section className="regional-intro activity-intro">
                <div><p className="section-kicker">{activityLens === "redfin" ? "Listings and transactions" : "Inventory and buyer interest"}</p><h2>{activityLens === "redfin" ? "How quickly is the local market moving?" : "Where are supply and attention shifting?"}</h2></div>
                <p>{activityLens === "redfin"
                  ? "Redfin adds city- and ZIP-level supply, speed, competition, repricing, and sale-price signals. Each observation is a rolling three-month window, so the change view compares it with the same three-month window one year earlier."
                  : "Realtor.com adds monthly ZIP-level inventory, listing inflow, pending activity, online buyer attention, and a relative Market Hotness measure. Inventory and Hotness can have different latest months."}</p>
              </section>
              <section className="control-deck" aria-label="Market conditions controls">
                <div className="source-strip">
                  <SourceBadge
                    provider={activityLens === "redfin" ? "Redfin" : "Realtor.com® Economic Research"}
                    frequency={activityLens === "redfin" ? redfinManifest?.frequency ?? "Rolling three-month" : "Monthly"}
                  />
                  <span>Data through {shortDate(activityFreshnessDate)}</span>
                  {activityLens === "realtor" && realtorError && <span className="source-warning">{realtorError}</span>}
                </div>
                <div className="control-grid activity-controls">
                  <LabelledSelect label="Data lens" value={activityLens} onChange={(next) => setActivityLens(next as ActivityLens)}>
                    <NativeSelectOption value="redfin">Market outcomes — Redfin</NativeSelectOption>
                    <NativeSelectOption value="realtor">Inventory &amp; buyer interest — Realtor.com</NativeSelectOption>
                  </LabelledSelect>
                  <LabelledSelect label="County" value={county} onChange={changeCounty}>
                    {COUNTY_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
                  </LabelledSelect>
                  {activityLens === "redfin" && (
                    <LabelledSelect label="Geography" value={geography} onChange={changeGeography}>
                      <NativeSelectOption value="city">Cities &amp; communities</NativeSelectOption>
                      <NativeSelectOption value="zip">ZIP codes</NativeSelectOption>
                    </LabelledSelect>
                  )}
                  <LabelledSelect label="Metric" value={activeActivityMetric} onChange={changeActivityMetric}>
                    {activityMetricOptions.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}
                  </LabelledSelect>
                  <LabelledSelect label="View" value={activeActivityView} onChange={changeActivityView}>
                    <NativeSelectOption value="level">Level</NativeSelectOption>
                    <NativeSelectOption value="yoy">Change from one year earlier</NativeSelectOption>
                    {activityLens === "realtor" && <NativeSelectOption value="index">Indexed to 100</NativeSelectOption>}
                  </LabelledSelect>
                  {activityLens === "realtor" && activeActivityView === "index" && (
                    <IndexBaseControl value={activityIndexBaseMonth} dates={activityDates} onChange={setRealtorIndexBaseRequest} />
                  )}
                </div>
                <div className="comparison-row">
                  <label className="control-label comparison-select">
                    <span>Add a comparison (up to five)</span>
                    <NativeSelect value={activeActivityAddId} onChange={(event) => activityLens === "redfin" ? setActivityAddId(event.target.value) : setRealtorAddId(event.target.value)} className="w-full">
                      <NativeSelectOption value="">Choose a region…</NativeSelectOption>
                  {activityEligible.filter((region) => !activeActivitySelectedIds.includes(region.id)).map((region) => (
                    <NativeSelectOption key={region.id} value={region.id}>{region.name}{region.context ? ` · ${region.context}` : ""}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button variant="outline" onClick={addActivityRegion} disabled={!activeActivityAddId || activeActivitySelectedIds.length >= 5}><Plus /> Add</Button>
            </div>
                <div className="chips" aria-label="Selected activity regions">
                  {activitySelectedRegions.map((region, index) => (
                    <button key={region.id} className={index === 0 ? "chip primary" : "chip"} onClick={() => selectActivityPrimary(region.id)}>
                      <i style={{ background: COLORS[index % COLORS.length] }} />
                      {region.name}{index === 0 ? " · focus" : ""}
                      {index > 0 && <X onClick={(event) => { event.stopPropagation(); removeActivityRegion(region.id); }} />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="kpi-grid" aria-label="Current local market activity summary">
                <Kpi
                  label={activityMetricMetadata.label}
                  definition={activityMetricMetadata.definition}
                  value={formatValue(activityLast?.value ?? null, activityPrimarySeries?.unit ?? "number", "level")}
                  note={activityLast ? `${activityLens === "redfin" ? "Rolling window ending" : "As of"} ${shortDate(activityPrimarySeries!.dates[activityLast.index])}${activityLastFlagged ? " · provider flagged" : ""}` : "No observation"}
                />
                <Kpi
                  label="Change from one year earlier"
                  value={formatValue(activityYoy?.value ?? null, activityPrimarySeries?.unit ?? "number", "yoy", false, activityPrimarySeries?.changeMode)}
                  note={`${activityLens === "redfin" ? "Versus the same rolling three-month window" : "Versus the same month one year earlier"}${activityYoyFlagged ? " · provider flagged" : ""}`}
                />
                <Kpi
                  label="Five-year change"
                  value={formatValue(activityFiveYear, activityPrimarySeries?.unit ?? "number", "yoy", false, activityPrimarySeries?.changeMode)}
                  note="Pre- and post-pandemic market context"
                />
                <Kpi
                  label={`${county === "Both" ? "Two-county" : county.replace(" County", "")} rank`}
                  value={activityRank ? `${activityRank} of ${activityRanked.length}` : "—"}
                  note={activeActivityRankBy === "growth" ? "Ranked by change from one year earlier" : `Ranked by current ${activityMetricMetadata.label.toLowerCase()}`}
                />
              </section>

              {activityLens === "realtor" && activeActivityMetric === "hotness_score" && (
                <section className="kpi-grid hotness-breakdown" aria-label="Market Hotness components">
                  <Kpi label="Demand score" definition={activityDataset.metrics.demand_score?.definition} value={formatValue(realtorSupportValue("demand_score"), "score", "level")} note="Relative listing attention" />
                  <Kpi label="Supply score" definition={activityDataset.metrics.supply_score?.definition} value={formatValue(realtorSupportValue("supply_score"), "score", "level")} note="Relative market speed" />
                  <Kpi label="Viewer multiple" definition={activityDataset.metrics.viewer_ratio?.definition} value={formatValue(realtorSupportValue("viewer_ratio"), "viewer_multiple", "level")} note="Typical ZIP listing versus U.S." />
                  <Kpi label="Median days on market" definition={activityDataset.metrics.realtor_median_dom?.definition} value={formatValue(realtorSupportValue("realtor_median_dom"), "days", "level")} note="Hotness supply input" />
                </section>
              )}

              <section className="analysis-grid">
                <Card className="chart-card">
                  <CardHeader className="chart-header">
                    <div>
                      <p className="section-kicker">Local activity</p>
                      <div className="metric-title-row">
                        <CardTitle><MetricHeading metric={activityMetricMetadata} fallback={activityMetricMetadata.label} /></CardTitle>
                        <span className="metric-freshness">Data through {shortDate(activityFreshnessDate)}</span>
                      </div>
                    </div>
                    <div className="chart-options">
                      <TimeRangeControl value={activeActivityTimeRange} onChange={changeActivityTimeRange} />
                      <p>{activeActivityView === "index"
                        ? `Indexed to ${shortDate(`${activityIndexBaseMonth}-01`)} = 100`
                        : activeActivityView === "level"
                          ? activityLens === "redfin" ? "Rolling three-month level" : activityMetricMetadata.source_product === "inventory" ? "Three-month average with monthly observations" : "Monthly level"
                          : activityLens === "redfin" ? "Change from the same window one year earlier" : "Change from the same month one year earlier"}</p>
                    </div>
                  </CardHeader>
                  <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
                    <SeriesChart
                      dataset={activityDataset}
                      regions={activitySelectedRegions}
                      metric={activeActivityMetric}
                      view={activeActivityView}
                      timeRange={activeActivityTimeRange}
                      indexBaseMonth={activityIndexBaseMonth}
                      showQuality={activityLens === "realtor"}
                      smoothMonths={activityLens === "realtor" && activeActivityView === "level" && activityMetricMetadata.source_product === "inventory" ? 3 : 1}
                    />
                    <FigureAttribution sources={[activityLens === "redfin" ? "redfin" : "realtor"]} />
                    {activityLens === "realtor" && activeActivityView === "level" && activityMetricMetadata.source_product === "inventory" && (
                      <InventoryLineGuide />
                    )}
                    {activityLens === "realtor" && (
                      <QualityCoverage dataset={activityDataset} region={activityPrimary} metric={activeActivityMetric} timeRange={activeActivityTimeRange} />
                    )}
                    <p className="data-note">{activityLens === "redfin"
                      ? "Redfin may revise recent observations. Thin local markets can be volatile even after three-month smoothing."
                      : "Realtor.com may revise its full history each month. Flagged observations remain visible but should be reviewed before reporting; thin ZIP markets can be volatile."}</p>
                  </CardContent>
                </Card>

                {activityLens === "realtor" && activeActivityMetric === "hotness_score" ? (
                  <HotnessQuadrant dataset={activityDataset} regions={activityEligible} selectedId={activityPrimary?.id ?? ""} />
                ) : (
                <Card className="ranking-card">
                  <CardHeader>
                    <div className="ranking-title">
                      <div><p className="section-kicker">Place</p><CardTitle>Market activity ranking</CardTitle></div>
                      <LabelledSelect label="Sort by" value={activeActivityRankBy} onChange={changeActivityRankBy}>
                        <NativeSelectOption value="growth">Change from one year earlier</NativeSelectOption>
                        <NativeSelectOption value="level">Current level</NativeSelectOption>
                      </LabelledSelect>
                    </div>
                    <div className="rank-columns" aria-hidden="true">
                      <span>#</span><span>Place</span><span>{activityMetricMetadata.short_label}</span><span>Change from<br />one year earlier</span>
                    </div>
                  </CardHeader>
                  <CardContent className="ranking-list">
                    {activityRanked.map((item, index) => (
                      <button
                        key={item.region.id}
                        onClick={() => toggleActivityPlaceSelection(item.region.id)}
                        className={`rank-row${item.region.id === activityPrimary?.id ? " active" : activeActivitySelectedIds.includes(item.region.id) ? " selected" : ""}`}
                        aria-pressed={activeActivitySelectedIds.includes(item.region.id)}
                      >
                        <span className="rank-number">{index + 1}</span>
                        <span className="rank-name">{item.region.name}<small className={item.qualityFlagged ? "quality-mini" : undefined}>{item.region.context}{item.qualityFlagged ? `${item.region.context ? " · " : ""}Provider flagged` : ""}</small></span>
                        <strong>{formatValue(item.level, item.unit, "level")}</strong>
                        <span className={(item.yoy ?? 0) < 0 ? "negative" : "positive"}>{formatValue(item.yoy, item.unit, "yoy", false, item.changeMode)}</span>
                      </button>
                    ))}
                  </CardContent>
                </Card>
                )}
              </section>

              <section className="maps-grid">
                <CountyMap county={county} mapData={maps[activityLens === "redfin" ? geography : "zip"]} dataset={activityDataset} metric={activeActivityMetric} metricLabel={activityMetricMetadata.label} view={activeActivityView} indexBaseMonth={activityIndexBaseMonth} selectedId={activityPrimary?.id ?? ""} onSelect={selectActivityPrimary} paletteKey={mapPalette} onPaletteChange={setMapPalette} provider={activityLens === "redfin" ? "Redfin" : "Realtor.com"} showQuality={activityLens === "realtor"} />
              </section>
            </>
          )}
        </TabsContent>

        <TabsContent value="permits" className="space-y-5">
          <PermitPanel
            mapData={maps.city}
            onManifest={(history, provisional) => setPermitManifests({ history, provisional })}
          />
        </TabsContent>

        <TabsContent value="context" className="space-y-5">
          <AcsPanel
            basePath={process.env.NEXT_PUBLIC_BASE_PATH ?? ""}
            maps={maps}
            marketDatasets={datasets}
            onManifest={setAcsManifest}
          />
        </TabsContent>

        <TabsContent value="regional" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Context</p><h2>How does Los Angeles fit into the housing cycle?</h2></div>
            <p>Compare Los Angeles, Riverside, and San Diego with the 20 largest U.S. metropolitan statistical areas by July 1, 2025 population. San Jose is retained as a selected California comparator; the full set spans eight Census divisions.</p>
          </section>
          <section className="control-deck">
            <div className="source-strip">
              <SourceBadge provider="Zillow" frequency="Monthly" />
              {cpiManifest && (
                <SourceBadge provider="BLS CPI-U" frequency="Monthly" />
              )}
              <span>Metro comparison</span>
            </div>
            <div className="control-grid regional-controls">
              <LabelledSelect label="Metric" value={regionalMetric} onChange={(next) => setRegionalMetric(next as MetricKey)}>
                {REGIONAL_METRICS.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}
              </LabelledSelect>
              <LabelledSelect label="View" value={regionalView} onChange={(next) => setRegionalView(next as ViewKey)}>
                <NativeSelectOption value="level">Level</NativeSelectOption>
                <NativeSelectOption value="yoy">Year-over-year change</NativeSelectOption>
                <NativeSelectOption value="index">Indexed to 100</NativeSelectOption>
              </LabelledSelect>
              {regionalView === "index" && (
                <IndexBaseControl value={regionalIndexBaseMonth} dates={regionalDates} onChange={setRegionalIndexBaseRequest} />
              )}
            </div>
            {regionalMetricSupportsReal && (
              <div className="price-controls regional-price-controls" aria-label="Regional inflation adjustment controls">
                <LabelledSelect label="Dollar terms" value={regionalBasis} onChange={(next) => setRegionalPriceBasis(next as PriceBasis)}>
                  <NativeSelectOption value="nominal">Nominal</NativeSelectOption>
                  <NativeSelectOption value="real" disabled={!cpi}>Real (inflation-adjusted)</NativeSelectOption>
                </LabelledSelect>
                {regionalBasis === "real" && (
                  <>
                    <RealBaseControl value={regionalRealBaseMonth} dates={regionalRealBaseMonths} onChange={setRegionalRealBaseRequest} />
                    <p className="price-basis-note"><strong>Common deflator: U.S. CPI-U.</strong> Applying one national index preserves comparability across metros; local CPI series are not mixed because their coverage and release frequencies differ.</p>
                  </>
                )}
              </div>
            )}
            <TimeRangeControl value={regionalTimeRange} onChange={setRegionalTimeRange} />
            <div className="comparison-row regional-comparison-row">
              <label className="control-label comparison-select">
                <span>Add a metro comparison (up to five)</span>
                <NativeSelect value={regionalAddId} onChange={(event) => setRegionalAddId(event.target.value)} className="w-full" disabled={regionalIds.length >= 5}>
                  <NativeSelectOption value="">{regionalIds.length >= 5 ? "Five-metro maximum reached" : "Choose a metro…"}</NativeSelectOption>
                  {(["West", "Midwest", "South", "Northeast"] as const).map((censusRegion) => (
                    <NativeSelectOptGroup key={censusRegion} label={censusRegion}>
                      {datasets.metro.regions
                        .filter((region) => region.census_region === censusRegion && !regionalIds.includes(region.id))
                        .sort((a, b) => (a.population_rank ?? 999) - (b.population_rank ?? 999) || a.name.localeCompare(b.name))
                        .map((region) => (
                          <NativeSelectOption key={region.id} value={region.id}>
                            {region.population_rank ? `#${region.population_rank} · ` : `${region.selection_note ?? "Selected comparator"} · `}{region.name}{region.division ? ` · ${region.division}` : ""}
                          </NativeSelectOption>
                        ))}
                    </NativeSelectOptGroup>
                  ))}
                </NativeSelect>
              </label>
              <Button variant="outline" onClick={addRegionalMetro} disabled={!regionalAddId || regionalIds.length >= 5}><Plus /> Add</Button>
              <p className="selection-count" aria-live="polite">{regionalIds.length} of 5 selected</p>
            </div>
            <div className="chips" aria-label="Selected metro comparisons">
              {regionalRegions.map((region, index) => (
                <button
                  key={region.id}
                  type="button"
                  className="chip"
                  onClick={() => setRegionalIds((current) => current.filter((id) => id !== region.id))}
                  aria-label={`Remove ${region.name} from comparison`}
                  title={`Remove ${region.name}`}
                >
                  <i style={{ background: COLORS[index % COLORS.length] }} />
                  {region.population_rank ? `#${region.population_rank} · ` : ""}{region.name}{region.selection_note ? " · selected comparator" : ""}
                  <X aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
          <section className="regional-visual-grid">
            <Card className="chart-card regional-chart">
              <CardHeader className="chart-header">
                <div><p className="section-kicker">Trend comparison</p><CardTitle><MetricHeading metric={regionalMetricMetadata} fallback={REGIONAL_METRICS.find((item) => item.key === regionalMetric)?.label ?? regionalMetric} /></CardTitle></div>
                <div className="chart-options">
                  {(regionalView === "yoy" || regionalView === "index") && regionalCpi && regionalMetricSupportsReal && (
                    <InflationToggle checked={showRegionalInflation} onCheckedChange={setShowRegionalInflation} label={`Plot ${regionalCpi.label}${regionalView === "yoy" ? " inflation" : ""}`} />
                  )}
                  <p>{regionalView === "index"
                    ? `${shortDate(`${regionalIndexBaseMonth}-01`)} = 100`
                    : regionalView === "level" && regionalBasis === "real"
                      ? `${shortDate(`${regionalRealBaseMonth}-01`)} dollars`
                      : "Choose up to five metros"}</p>
                </div>
              </CardHeader>
              <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
                <SeriesChart dataset={datasets.metro} regions={regionalRegions} metric={regionalMetric} view={regionalView} timeRange={regionalTimeRange} indexBaseMonth={regionalIndexBaseMonth} priceAdjustment={regionalPriceAdjustment} overlays={regionalInflationOverlays} />
                <FigureAttribution sources={regionalMetricSupportsReal && (regionalBasis === "real" || ((regionalView === "yoy" || regionalView === "index") && showRegionalInflation)) && cpiManifest ? ["zillow", "bls"] : ["zillow"]} />
                {regionalBasis === "real" && <p className="data-note">All real metro series use U.S. city-average CPI-U. October 2025 uses a log-linear interpolation between September and November; official CPI overlays retain the gap.</p>}
              </CardContent>
            </Card>
            <Card className="chart-card cycle-card">
              <CardHeader className="chart-header">
                <div>
                  <p className="section-kicker">Latest cycle position</p>
                  <CardTitle>
                    Inventory growth vs. {cpi?.series.us ? "real " : ""}home-value growth
                    <DefinitionHelp
                      label="Metro cycle position"
                      definition={`Each point compares the change in for-sale inventory from one year earlier with the change in ${cpi?.series.us ? "U.S. CPI-adjusted " : "nominal "}home values over the same period. It is a descriptive cycle indicator, not a forecast.`}
                    />
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="cycle-chart-wrap">
                <RegionalCycleChart dataset={datasets.metro} selectedIds={regionalIds} cpi={cpi?.series.us ?? null} interpolationRules={cpi?.real_value_interpolation ?? []} />
                <FigureAttribution sources={cpi?.series.us ? ["zillow", "bls"] : ["zillow"]} />
              </CardContent>
            </Card>
          </section>
        </TabsContent>

        <TabsContent value="facts" className="space-y-5">
          <FactEnginePanel basePath={process.env.NEXT_PUBLIC_BASE_PATH ?? ""} onNavigate={setMainTab} />
        </TabsContent>

        <TabsContent value="methods" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Reproducibility</p><h2>Housing evidence with documented methods.</h2></div>
            <p>The lab organizes selected housing indicators for teaching and academic research. Definitions, transformations, source vintages, and release identifiers are documented so users can interpret and cite the evidence consistently.</p>
          </section>
          <section className="method-grid">
            <Card><CardHeader><CardTitle>Zillow measures</CardTitle></CardHeader><CardContent className="method-copy"><p><strong>ZHVI</strong> estimates the typical mid-tier home value. <strong>ZORI</strong> tracks typical observed asking rent. The price–rent multiple is ZHVI divided by twelve months of ZORI.</p><p>Monthly year-over-year change compares each observation with the same month one year earlier. In indexed views, the user-selected starting month equals 100.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Nominal and real terms</CardTitle></CardHeader><CardContent className="method-copy"><p>Home values and rents can be shown in nominal dollars or converted to constant dollars using CPI-U. Local views default to the Los Angeles–Long Beach–Anaheim index, which covers Los Angeles and Orange Counties. Cross-metro views use the U.S. city average as a single common deflator; mixing local CPIs would introduce differences in geographic coverage and publication frequency.</p><p>Real value in base month <em>b</em> equals nominal value in month <em>t</em> multiplied by CPI<sub>b</sub>/CPI<sub>t</sub>. The base month changes displayed dollar levels but not real growth. Real rent is a purchasing-power measure, not an affordability measure.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>CPI and inflation</CardTitle></CardHeader><CardContent className="method-copy"><p>The lab retrieves monthly CPI-U, All Items directly from the U.S. Bureau of Labor Statistics: <code>CUURS49ASA0</code> for the LA area and <code>CUUR0000SA0</code> for the U.S. city average. Both are not seasonally adjusted.</p><p>Inflation overlays use only official observations. Because BLS could not collect October 2025 data during the federal appropriations lapse, the official series remains missing for that month. Only derived real housing calculations fill that single gap with the geometric midpoint of September and November CPI, equivalent to log-linear interpolation. No other missing or trailing month is filled.</p><p><a href="https://www.bls.gov/cpi/additional-resources/2025-federal-government-shutdown-impact-cpi.htm" target="_blank" rel="noreferrer">Read the BLS explanation <ExternalLink /></a></p></CardContent></Card>
            <Card><CardHeader><CardTitle>Redfin activity measures</CardTitle></CardHeader><CardContent className="method-copy"><p>Redfin supplies months of supply, median days on market, the share sold above original list, the share of active listings with price reductions, and median sale price per square foot.</p><p>City and ZIP observations are rolling three-month windows. Share changes are shown in percentage points; days and months use absolute differences; price per square foot uses percent change.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Realtor.com inventory and demand</CardTitle></CardHeader><CardContent className="method-copy"><p>Realtor.com® Economic Research supplies monthly ZIP-level active and new listings, the pending-to-active ratio, listing viewers relative to the U.S., and its Market Hotness score.</p><p>Hotness equally weights relative demand and supply scores based on listing attention and market speed. It is a comparative index, not a probability of sale. Provider-flagged ZIP-months remain visible and are explicitly marked for review.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Building permits</CardTitle></CardHeader><CardContent className="method-copy"><p>The U.S. Census Bureau Building Permits Survey reports new privately owned housing units authorized by permit-issuing jurisdictions. The lab groups units into single-unit, 2–4-unit, and 5+-unit structures and shows annual history from 1980 and comparable local monthly history from 2022.</p><p>Current-year monthly observations are preliminary and may be revised or imputed. Annual data become final after the Census Bureau’s revision cycle. Permit authorization is an early production indicator, not a housing start or completion.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>ACS housing context</CardTitle></CardHeader><CardContent className="method-copy"><p>The housing-context layer retains six selected ACS five-year measures and their 90% margins of error. The latest cross-section covers every mapped city, Census-designated place, and ZCTA in the two counties; it does not expose a general ACS variable catalog.</p><p>Structural change compares non-overlapping five-year periods for cities and communities. Consecutive overlapping vintages are not treated as annual observations. Prior-period household income is converted to the latest vintage’s dollars using annual-average U.S. CPI-U.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Geographies</CardTitle></CardHeader><CardContent className="method-copy"><p>City/community maps retain every Census incorporated place and Census-designated place (CDP) assigned to Orange or Los Angeles County, whether or not a provider reports data. Zillow and Redfin observations are matched independently, and an unincorporated CDP is never reassigned to a neighboring city.</p><p>ZIP map boundaries are Census ZCTAs: useful approximations, but not identical to USPS delivery ZIPs. Census places and ZCTAs do not necessarily cover or classify land in the same way.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Reading the maps</CardTitle></CardHeader><CardContent className="method-copy"><p>The legend distinguishes three states: <strong>colored</strong> means the selected provider reports a current observation; <strong>gray</strong> means an official city/CDP or mapped ZCTA boundary exists but the selected observation is unavailable; <strong>unshaded</strong> means the land falls outside the displayed place geography. Maps open on a focused mainland view; offshore boundaries remain in the map geometry and can be reached by panning.</p><p>Unshaded county remainder, wilderness, and open space should not be interpreted as a missing housing market. For example, unshaded portions of Laguna Coast Wilderness Park are not a separate Census place. OpenStreetMap supplies the underlying geographic context.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Release design</CardTitle></CardHeader><CardContent className="method-copy"><p>Zillow, Redfin, Realtor.com, BLS CPI, ACS, Census building permits, and Census map geometry use independent versioned releases. Provider-published files are processed into the selected measures and local geographies used by the lab. Each family keeps the current validated release and one rollback.</p><p>When a new provider file omits older dates, the lab carries those dates forward from its prior compact extract. Overlapping dates use the newest provider release, including revisions and explicit missing values. A failed update leaves the prior validated release available and does not block another source.</p><p>The public brief archive contains approved editions, not every generated fact packet. When enough recurring questions receive newer evidence, a review process prepares a draft pull request; it cannot publish or merge the edition. Each approved edition preserves its publication or reconstruction status, observation cutoff, source releases, and evidence fingerprint. Corrections are labeled rather than silently rewriting the record.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Technical design</CardTitle></CardHeader><CardContent className="method-copy"><p>The site is a static export with no database, application server, paid API, or paid map service. Provider updates pass validation before release, and GitHub Pages serves the resulting files.</p><p>ACS follows its annual release cycle and stops after a lightweight vintage check when no new release exists. New ACS vintages request only selected variables, publish only local estimates and margins of error, and reuse the shared map geometry. County-level shards keep generated JSON files below 1 MB, and a storage limit prevents unbounded growth.</p></CardContent></Card>
          </section>
          <Card className="disclaimer-card">
            <CardHeader><CardTitle>Academic-use disclaimer</CardTitle></CardHeader>
            <CardContent className="method-copy">
              <p>This project is provided for instruction and academic research. It is not financial, investment, legal, valuation, or real-estate advice, and should not be relied on for transactions or commercial decision-making.</p>
              <p>Third-party data remain subject to their providers’ licenses and terms. This project does not grant commercial-use rights to Zillow, Redfin, Realtor.com, Census, or OpenStreetMap data.</p>
            </CardContent>
          </Card>
          <Card id="current-release-provenance" className="provenance-card">
            <CardHeader><CardTitle>Current release provenance</CardTitle></CardHeader>
            <CardContent>
              <p className="provenance-intro">Coverage identifies the newest observation in each source. Validation identifies when this site accepted the current snapshot.</p>
              <dl className="provenance-grid">
                <div><dt>Zillow prices &amp; rents</dt><dd>Through {shortDate(latestObservation(Object.values(manifest.latest_observations)) ?? manifest.release)}<small>Validated {validationDate(manifest.created_at)}</small></dd></div>
                <div><dt>Redfin market activity</dt><dd>{redfinManifest ? `Through ${shortDate(latestObservation(Object.values(redfinManifest.latest_observations)) ?? redfinManifest.release)}` : "Unavailable"}<small>{redfinManifest ? `Validated ${validationDate(redfinManifest.created_at)}` : ""}</small></dd></div>
                <div><dt>Realtor inventory</dt><dd>{realtorManifests.inventory ? `Through ${shortDate(latestObservation(Object.values(realtorManifests.inventory.latest_observations)) ?? realtorManifests.inventory.release)}` : "Unavailable"}<small>{realtorManifests.inventory ? `Validated ${validationDate(realtorManifests.inventory.created_at)}` : ""}</small></dd></div>
                <div><dt>Realtor Hotness</dt><dd>{realtorManifests.hotness ? `Through ${shortDate(latestObservation(Object.values(realtorManifests.hotness.latest_observations)) ?? realtorManifests.hotness.release)}` : "Unavailable"}<small>{realtorManifests.hotness ? `Validated ${validationDate(realtorManifests.hotness.created_at)}` : ""}</small></dd></div>
                <div><dt>BLS CPI</dt><dd>{cpiManifest ? `Through ${shortDate(latestObservation(Object.values(cpiManifest.series).map((item) => item.latest_observation)) ?? cpiManifest.release)}` : "Unavailable"}<small>{cpiManifest ? `Validated ${validationDate(cpiManifest.created_at)}` : ""}</small></dd></div>
                <div><dt>ACS housing context</dt><dd>{acsManifest ? `${acsManifest.periods[1]} five-year estimates` : "Unavailable"}<small>{acsManifest ? `Validated ${validationDate(acsManifest.created_at)}` : ""}</small></dd></div>
                <div><dt>Final permit history</dt><dd>{permitManifests ? `Annual and monthly through ${shortDate(permitManifests.history.latest_final_month ?? `${permitManifests.history.latest_final_year}-12`)}` : "Loading…"}<small>{permitManifests ? `Validated ${validationDate(permitManifests.history.created_at)}` : ""}</small></dd></div>
                <div><dt>Preliminary permits</dt><dd>{permitManifests?.provisional.latest_observation ? `Through ${shortDate(permitManifests.provisional.latest_observation)}` : "Loading…"}<small>{permitManifests ? `Validated ${validationDate(permitManifests.provisional.created_at)}` : ""}</small></dd></div>
                <div><dt>Geographic coverage</dt><dd>{manifest.counts.city} city/community · {manifest.counts.zip} ZIP · {manifest.counts.metro} metro · {permitManifests?.history.counts.jurisdictions ?? 124} permit jurisdictions</dd></div>
              </dl>
              <details className="provenance-technical">
                <summary>Technical release identifiers and fingerprints</summary>
                <p>Each fingerprint is the complete SHA-256 identifier for its validated data bundle.</p>
                <dl className="fingerprint-list">
                  <div><dt>Zillow</dt><dd><span>Release {manifest.release}</span><code>{manifest.bundle_sha256}</code></dd></div>
                  {redfinManifest && <div><dt>Redfin</dt><dd><span>Release {redfinManifest.release}</span><code>{redfinManifest.bundle_sha256}</code></dd></div>}
                  {realtorManifests.inventory && <div><dt>Realtor inventory</dt><dd><span>Release {realtorManifests.inventory.release}</span><code>{realtorManifests.inventory.bundle_sha256}</code></dd></div>}
                  {realtorManifests.hotness && <div><dt>Realtor Hotness</dt><dd><span>Release {realtorManifests.hotness.release}</span><code>{realtorManifests.hotness.bundle_sha256}</code></dd></div>}
                  {cpiManifest && <div><dt>BLS CPI</dt><dd><span>Release {cpiManifest.release}</span><code>{cpiManifest.bundle_sha256}</code></dd></div>}
                  {acsManifest && <div><dt>ACS context</dt><dd><span>Release {acsManifest.release}</span><code>{acsManifest.bundle_sha256}</code></dd></div>}
                  {permitManifests && <div><dt>Final permits</dt><dd><span>Release {permitManifests.history.release}</span><code>{permitManifests.history.bundle_sha256}</code></dd></div>}
                  {permitManifests && <div><dt>Preliminary permits</dt><dd><span>Release {permitManifests.provisional.release}</span><code>{permitManifests.provisional.bundle_sha256}</code></dd></div>}
                </dl>
              </details>
              <p className="attribution">{manifest.attribution}. {redfinManifest?.attribution} {realtorManifests.inventory?.attribution ?? realtorManifests.hotness?.attribution} {cpiManifest?.attribution} {acsManifest?.attribution} {permitManifests?.history.attribution} Map data © OpenStreetMap contributors. This independent academic visualization is not endorsed by Zillow Group, Redfin, Realtor.com, BLS, Census, HUD, or OpenStreetMap.</p>
              <div className="source-links">
                <a className="source-link" href={manifest.data_page} target="_blank" rel="noreferrer">View Zillow Research source data <ExternalLink /></a>
                <a className="source-link" href={redfinManifest?.data_page ?? "https://www.redfin.com/news/data-center/downloads/"} target="_blank" rel="noreferrer">View Redfin Data Center <ExternalLink /></a>
                <a className="source-link" href={redfinManifest?.methodology_page ?? "https://www.redfin.com/news/data-center/methodology/"} target="_blank" rel="noreferrer">View Redfin methodology <ExternalLink /></a>
                <a className="source-link" href={realtorManifests.inventory?.data_page ?? "https://www.realtor.com/research/data/"} target="_blank" rel="noreferrer">View Realtor.com Data Library <ExternalLink /></a>
                <a className="source-link" href={realtorManifests.hotness?.methodology_page ?? "https://www.realtor.com/research/reports/hottest-markets/"} target="_blank" rel="noreferrer">View Market Hotness methodology <ExternalLink /></a>
                <a className="source-link" href={cpiManifest?.data_page ?? "https://www.bls.gov/cpi/data.htm"} target="_blank" rel="noreferrer">View BLS CPI source data <ExternalLink /></a>
                <a className="source-link" href={acsManifest?.data_page ?? "https://www.census.gov/programs-surveys/acs/data.html"} target="_blank" rel="noreferrer">View Census ACS source data <ExternalLink /></a>
                <a className="source-link" href={permitManifests?.history.data_page ?? "https://www.census.gov/construction/bps/"} target="_blank" rel="noreferrer">View Census Building Permits Survey <ExternalLink /></a>
                <a className="source-link" href={permitManifests?.history.socds_page ?? "https://www.huduser.gov/socds/permits/"} target="_blank" rel="noreferrer">Verify permits in HUD SOCDS <ExternalLink /></a>
                <a className="source-link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">View OpenStreetMap attribution <ExternalLink /></a>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="about" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">About the project</p><h2>Housing evidence for learning, research, and public discussion.</h2></div>
            <p>The Housing Market Lab is an instructional and research-oriented platform that brings together selected public real estate and housing-market data from multiple sources in a consistent, locally focused interface. Its primary geographic focus is Los Angeles and Orange Counties, with city-, ZIP-code-, and metropolitan-level comparisons where the underlying data permit.</p>
          </section>

          <section className="about-objectives" aria-label="Project objectives">
            <Card>
              <CardHeader><p className="section-kicker">Students</p><CardTitle>Support instruction</CardTitle></CardHeader>
              <CardContent className="method-copy"><p>The Lab helps students connect real estate and urban-economic concepts with observed market conditions. Users can examine prices, rents, inventory, market activity, inflation-adjusted trends, and differences across local markets.</p></CardContent>
            </Card>
            <Card>
              <CardHeader><p className="section-kicker">Researchers</p><CardTitle>Facilitate research</CardTitle></CardHeader>
              <CardContent className="method-copy"><p>The project harmonizes selected measures from multiple data providers and documents their definitions, geographic coverage, release timing, and limitations. It is intended to make exploratory analysis and the development of research questions more efficient and transparent.</p></CardContent>
            </Card>
            <Card>
              <CardHeader><p className="section-kicker">Public users</p><CardTitle>Inform public discussion</CardTitle></CardHeader>
              <CardContent className="method-copy"><p>The Lab provides policymakers, practitioners, and community members with accessible, ready-to-use descriptive indicators for comparing markets, identifying emerging patterns, and evaluating questions that may warrant further investigation.</p></CardContent>
            </Card>
          </section>

          <Card className="about-principles">
            <CardHeader><CardTitle>Guiding principles</CardTitle></CardHeader>
            <CardContent className="method-copy"><p>The project emphasizes transparent definitions, clear source attribution, reproducible data processing, and responsible interpretation. Rather than presenting every available series, it prioritizes measures that provide distinct economic insight while keeping the published data lightweight and maintainable.</p></CardContent>
          </Card>

          <Card className="disclaimer-card">
            <CardHeader><CardTitle>Appropriate interpretation</CardTitle></CardHeader>
            <CardContent className="method-copy">
              <p>The Housing Market Lab is an independent academic project, not an official statistical product. Its visualizations are descriptive and do not, by themselves, establish causal relationships or constitute forecasts, valuations, policy recommendations, or financial advice. Data may be revised by their providers, and coverage can vary across locations and periods. Users should consult the original sources and project documentation before relying on a measure for formal research or decision-making.</p>
              <p>Any views, interpretations, and errors are those of the project author and do not necessarily reflect the positions of California State University, Fullerton, the College of Business and Economics, or the Department of Finance. Use of third-party data does not imply endorsement by the university or the respective data providers.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <footer>
        <div className="footer-project">
          <p>
            Created by{" "}
            <a className="footer-emphasis" href="https://desenlin.com/" target="_blank" rel="noreferrer">Desen Lin</a>,{" "}
            <a className="footer-emphasis" href="https://business.fullerton.edu/academics/finance" target="_blank" rel="noreferrer">Department of Finance</a>,{" "}
            <a className="footer-emphasis" href="https://www.fullerton.edu/" target="_blank" rel="noreferrer">California State University, Fullerton</a>.
          </p>
          <p className="footer-citation">
            <strong>Citation:</strong> Lin, D. (2026). <cite>Housing Market Lab</cite> [Computer software].{" "}
            <a href="https://desenlin.com/housing-market-lab/">https://desenlin.com/housing-market-lab/</a>
          </p>
          <p>For instruction and academic research · Not financial advice · Third-party data terms apply</p>
        </div>
        <nav className="footer-about" aria-label="About and contact">
          <strong>About &amp; contact</strong>
          <a href="https://desenlin.com/" target="_blank" rel="noreferrer">Faculty website</a>
          <a href="https://business.fullerton.edu/academics/finance" target="_blank" rel="noreferrer">Finance department</a>
        </nav>
      </footer>
    </main>
    </TooltipProvider>
  );
}
