"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RotateCcw, X } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FigureAttribution } from "@/components/figure-attribution";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DEFAULT_MAP_FIT_OPTIONS, focusedMapBounds } from "@/lib/map-view";

type PermitMetricKey =
  | "total_units"
  | "single_unit"
  | "small_multifamily"
  | "large_multifamily"
  | "large_multifamily_share"
  | "units_per_1000_stock";
type Frequency = "annual" | "monthly";
type AnnualChartRange = "10y" | "20y" | "30y" | "max";
type MonthlyChartRange = "1y" | "3y" | "max";
type Value = number | null;

type PermitMetric = {
  label: string;
  short_label: string;
  unit: "units" | "share" | "rate";
  decimals: number;
  definition: string;
};

type PermitRegion = {
  id: string;
  bps_id: string;
  name: string;
  county: string;
  county_fips: string;
  fips_place: string | null;
  jurisdiction_type: "incorporated_city" | "county_unincorporated";
  housing_stock: number;
  housing_stock_vintage: number;
  series: Record<PermitMetricKey, Value[]>;
  quality: {
    imputed: number[];
    source_codes: Record<string, number[]>;
    months_reported: Array<number | null>;
  };
};

type PermitDataset = {
  schema_version: number;
  geography: "permit_jurisdiction";
  frequency: "Annual" | "Monthly";
  status: "Final" | "Preliminary";
  dates: string[];
  metrics: Record<PermitMetricKey, PermitMetric>;
  regions: PermitRegion[];
};

export type PermitManifest = {
  release: string;
  created_at: string;
  provider: string;
  attribution: string;
  data_page: string;
  socds_page: string;
  methodology_page: string;
  documentation_page: string;
  bundle_sha256: string;
  latest_final_year: number;
  latest_final_month?: string;
  latest_observation?: string;
  acs_vintage: number;
  counts: { jurisdictions: number; cities: number; county_unincorporated: number };
};

type MapData = {
  counties: Record<string, {
    bounds: [[number, number], [number, number]];
    regions: Array<{
      id: string;
      name: string;
      county?: string;
      geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
    }>;
  }>;
};

const COUNTY_OPTIONS = ["Orange County", "Los Angeles County", "Both"];
const METRIC_OPTIONS: Array<{ key: PermitMetricKey; label: string }> = [
  { key: "total_units", label: "All units authorized" },
  { key: "single_unit", label: "Single-unit housing" },
  { key: "small_multifamily", label: "Units in 2–4-unit buildings" },
  { key: "large_multifamily", label: "Units in 5+-unit buildings" },
  { key: "large_multifamily_share", label: "5+-unit share" },
  { key: "units_per_1000_stock", label: "Units per 1,000 existing units" },
];
const COLORS = ["#ff7a1a", "#12355b", "#2f7d6d", "#9b4f96", "#c7a227"];
const MAP_COLORS = ["#fff0e4", "#ffd1ad", "#ffa866", "#ed6b10", "#9d3f00"];

function formatDate(value: string) {
  if (/^\d{4}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}-01T00:00:00Z`));
}

function formatValue(value: Value, metric: PermitMetric) {
  if (value == null || !Number.isFinite(value)) return "Not reported";
  if (metric.unit === "share") return `${(value * 100).toFixed(1)}%`;
  if (metric.unit === "rate") return value.toFixed(metric.decimals);
  return Math.round(value).toLocaleString("en-US");
}

function joinMonthly(finalData: PermitDataset, provisional: PermitDataset): PermitDataset {
  const regionsById = new Map(provisional.regions.map((region) => [region.id, region]));
  const offset = finalData.dates.length;
  return {
    ...finalData,
    status: "Preliminary",
    dates: [...finalData.dates, ...provisional.dates],
    regions: finalData.regions.map((region) => {
      const open = regionsById.get(region.id);
      return {
        ...region,
        series: Object.fromEntries(Object.keys(region.series).map((key) => [
          key,
          [...region.series[key as PermitMetricKey], ...(open?.series[key as PermitMetricKey] ?? provisional.dates.map(() => null))],
        ])) as Record<PermitMetricKey, Value[]>,
        quality: {
          imputed: [...region.quality.imputed, ...(open?.quality.imputed.map((index) => index + offset) ?? [])],
          source_codes: open?.quality.source_codes ?? {},
          months_reported: [...region.quality.months_reported, ...(open?.quality.months_reported ?? provisional.dates.map(() => null))],
        },
      };
    }),
  };
}

function countyAggregate(dataset: PermitDataset, county: string, metric: PermitMetricKey, index: number) {
  const rows = dataset.regions.filter((region) => region.county === county);
  const total = rows.reduce((sum, region) => sum + (region.series.total_units[index] ?? 0), 0);
  if (metric === "large_multifamily_share") {
    const large = rows.reduce((sum, region) => sum + (region.series.large_multifamily[index] ?? 0), 0);
    return total ? large / total : null;
  }
  if (metric === "units_per_1000_stock") {
    const stock = rows.reduce((sum, region) => sum + (region.housing_stock ?? 0), 0);
    return stock ? total * 1000 / stock : null;
  }
  return rows.reduce((sum, region) => sum + (region.series[metric][index] ?? 0), 0);
}

function LabelledSelect({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="control-label">
      <span>{label}</span>
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)}>{children}</NativeSelect>
    </label>
  );
}

function PermitMap({ mapData, dataset, county, metric, dateIndex, selectedId, onSelect }: {
  mapData: MapData;
  dataset: PermitDataset;
  county: string;
  metric: PermitMetricKey;
  dateIndex: number;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [ready, setReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  const lastFit = useRef("");
  const metricInfo = dataset.metrics[metric];
  const shapes = useMemo(() => {
    const countyNames = county === "Both" ? ["Orange County", "Los Angeles County"] : [county];
    const groups = countyNames.map((name) => mapData.counties[name]);
    return {
      bounds: [
        [Math.min(...groups.map((group) => group.bounds[0][0])), Math.min(...groups.map((group) => group.bounds[0][1]))],
        [Math.max(...groups.map((group) => group.bounds[1][0])), Math.max(...groups.map((group) => group.bounds[1][1]))],
      ] as [[number, number], [number, number]],
      regions: groups.flatMap((group, index) => group.regions.map((region) => ({ ...region, county: region.county ?? countyNames[index] }))),
    };
  }, [county, mapData]);
  const dataById = useMemo(() => new Map(dataset.regions.map((region) => [region.id, region])), [dataset]);
  const values = shapes.regions.map((shape) => ({
    shape,
    region: dataById.get(shape.id),
    value: dataById.get(shape.id)?.series[metric][dateIndex] ?? null,
  }));
  const finite = values.flatMap((item) => item.value == null ? [] : [item.value]);
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 0;

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      if (!containerRef.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, { minZoom: 7, maxZoom: 18, scrollWheelZoom: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(map);
      mapRef.current = map;
      setReady(true);
    }
    initialize();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    layerRef.current?.remove();
    const valueById = new Map(values.map((item) => [item.shape.id, item]));
    const collection = {
      type: "FeatureCollection" as const,
      features: shapes.regions.map((shape) => ({ type: "Feature" as const, properties: { id: shape.id, name: shape.name }, geometry: shape.geometry })),
    };
    layerRef.current = L.geoJSON(collection as GeoJSON.FeatureCollection, {
      style: (feature) => {
        const item = valueById.get(String(feature?.properties?.id ?? ""));
        const ratio = item?.value == null ? 0 : high === low ? 0.5 : (item.value - low) / (high - low);
        const colorIndex = Math.min(MAP_COLORS.length - 1, Math.max(0, Math.floor(ratio * MAP_COLORS.length)));
        const selected = item?.region?.id === selectedId;
        return {
          color: selected ? "#12355b" : "#ffffff",
          weight: selected ? 3 : 1.2,
          dashArray: item?.region ? undefined : "4 3",
          fillColor: item?.region ? MAP_COLORS[colorIndex] : "#e8edf0",
          fillOpacity: item?.region ? 0.78 : 0.52,
        };
      },
      onEachFeature: (feature, layer) => {
        const item = valueById.get(String(feature.properties?.id ?? ""));
        const wrapper = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = item?.shape.name ?? String(feature.properties?.name ?? "");
        const countyLine = document.createElement("span");
        countyLine.textContent = item?.shape.county ?? "";
        const measure = document.createElement("span");
        measure.textContent = item?.region
          ? `${metricInfo.short_label}: ${formatValue(item.value, metricInfo)}`
          : `Included in ${item?.shape.county} Unincorporated Area total; not separately reported`;
        wrapper.append(name, countyLine, measure);
        layer.bindTooltip(wrapper, { sticky: true, direction: "top" });
        if (item?.region) layer.on("click", () => onSelectRef.current(item.region!.id));
      },
    }).addTo(map);
    const fitKey = county;
    if (lastFit.current !== fitKey) {
      map.fitBounds(L.latLngBounds(focusedMapBounds(county, shapes.bounds)), DEFAULT_MAP_FIT_OPTIONS);
      lastFit.current = fitKey;
    }
    map.invalidateSize({ pan: false });
  }, [county, dateIndex, dataset.dates, high, low, metricInfo, ready, selectedId, shapes, values]);

  function resetMap() {
    const L = leafletRef.current;
    if (L && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(focusedMapBounds(county, shapes.bounds)), DEFAULT_MAP_FIT_OPTIONS);
  }

  const reported = values.filter((item) => item.region && item.value != null).length;
  const cdpCount = values.filter((item) => !item.region).length;
  return (
    <div className="map-panel permit-map-panel">
      <div className="map-heading">
        <div>
          <p className="section-kicker">Permit jurisdiction map</p>
          <h3>{county === "Both" ? "Orange and Los Angeles Counties" : county}</h3>
          <p><strong>{metricInfo.label}</strong> · {formatDate(dataset.dates[dateIndex])}</p>
        </div>
        <div className="map-tools">
          <button type="button" className="map-reset" onClick={resetMap}><RotateCcw /> Reset map</button>
          <div className="map-legend">
            <span className="map-legend-item map-legend-scale">{formatValue(low, metricInfo)}<i className="map-gradient" style={{ background: `linear-gradient(90deg, ${MAP_COLORS.join(",")})` }} />{formatValue(high, metricInfo)}</span>
            <span className="map-legend-item"><i className="map-swatch permit-cdp" />CDP · in unincorporated total</span>
          </div>
        </div>
      </div>
      <div ref={containerRef} className="leaflet-map" role="region" aria-label={`Building permits map for ${county}`} />
      <p className="map-coverage">{reported} incorporated-city boundaries report this observation. {cdpCount} Census-designated place boundaries are geographic context only and belong to the county unincorporated aggregate. Unshaded land outside place boundaries may also be part of that aggregate.</p>
      <FigureAttribution sources={metric === "units_per_1000" ? ["census-bps", "census-acs"] : ["census-bps"]} boundaries basemap />
    </div>
  );
}

export function PermitPanel({ mapData, onManifest }: { mapData: MapData; onManifest?: (history: PermitManifest, provisional: PermitManifest) => void }) {
  const [annual, setAnnual] = useState<PermitDataset | null>(null);
  const [monthly, setMonthly] = useState<PermitDataset | null>(null);
  const [historyManifest, setHistoryManifest] = useState<PermitManifest | null>(null);
  const [provisionalManifest, setProvisionalManifest] = useState<PermitManifest | null>(null);
  const [error, setError] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [county, setCounty] = useState("Orange County");
  const [metric, setMetric] = useState<PermitMetricKey>("total_units");
  const [date, setDate] = useState("");
  const [annualChartRange, setAnnualChartRange] = useState<AnnualChartRange>("max");
  const [monthlyChartRange, setMonthlyChartRange] = useState<MonthlyChartRange>("max");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addId, setAddId] = useState("");
  const onManifestRef = useRef(onManifest);
  useEffect(() => { onManifestRef.current = onManifest; }, [onManifest]);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    async function load() {
      try {
        const [historyPointer, provisionalPointer] = await Promise.all([
          fetch(`${base}/data/permits/history/latest.json`).then((response) => response.json() as Promise<{ release: string }>),
          fetch(`${base}/data/permits/provisional/latest.json`).then((response) => response.json() as Promise<{ release: string }>),
        ]);
        const historyBase = `${base}/data/permits/history/releases/${historyPointer.release}`;
        const provisionalBase = `${base}/data/permits/provisional/releases/${provisionalPointer.release}`;
        const [annualData, finalMonthly, openMonthly, finalManifest, openManifest] = await Promise.all([
          fetch(`${historyBase}/annual.json`).then((response) => response.json() as Promise<PermitDataset>),
          fetch(`${historyBase}/monthly.json`).then((response) => response.json() as Promise<PermitDataset>),
          fetch(`${provisionalBase}/monthly.json`).then((response) => response.json() as Promise<PermitDataset>),
          fetch(`${historyBase}/manifest.json`).then((response) => response.json() as Promise<PermitManifest>),
          fetch(`${provisionalBase}/manifest.json`).then((response) => response.json() as Promise<PermitManifest>),
        ]);
        const combined = joinMonthly(finalMonthly, openMonthly);
        setAnnual(annualData);
        setMonthly(combined);
        setHistoryManifest(finalManifest);
        setProvisionalManifest(openManifest);
        setDate(combined.dates.at(-1) ?? "");
        const orange = combined.regions.filter((region) => region.county === "Orange County" && region.jurisdiction_type === "incorporated_city");
        const defaults = ["Fullerton", "Irvine", "Anaheim"].map((name) => orange.find((region) => region.name === name)?.id).filter((id): id is string => Boolean(id));
        setSelectedIds(defaults.length ? defaults : orange.slice(0, 3).map((region) => region.id));
        onManifestRef.current?.(finalManifest, openManifest);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Building permit data could not be loaded.");
      }
    }
    load();
  }, []);

  const dataset = frequency === "annual" ? annual : monthly;
  const eligible = useMemo(() => dataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [], [county, dataset]);
  const selectedDate = dataset?.dates.includes(date) ? date : dataset?.dates.at(-1) ?? "";
  const dateIndex = dataset ? Math.max(0, dataset.dates.indexOf(selectedDate)) : 0;
  const metricInfo = dataset?.metrics[metric];
  const selected = selectedIds.map((id) => eligible.find((region) => region.id === id)).filter((region): region is PermitRegion => Boolean(region));
  const primary = selected[0];
  const primaryValue = primary?.series[metric][dateIndex] ?? null;
  const isImputed = Boolean(primary?.quality.imputed.includes(dateIndex));
  const ranked = useMemo(() => {
    if (!dataset) return [];
    return eligible
      .filter((region) => region.jurisdiction_type === "incorporated_city" && region.series[metric][dateIndex] != null)
      .sort((a, b) => (b.series[metric][dateIndex] ?? -Infinity) - (a.series[metric][dateIndex] ?? -Infinity));
  }, [dataset, dateIndex, eligible, metric]);
  const primaryRank = primary ? ranked.findIndex((region) => region.id === primary.id) + 1 : 0;
  const chartRange = frequency === "annual" ? annualChartRange : monthlyChartRange;
  const chartPointLimit = chartRange === "max"
    ? dataset?.dates.length ?? 0
    : Number.parseInt(chartRange, 10) * (frequency === "monthly" ? 12 : 1);
  const chartStartIndex = dataset ? Math.max(0, dataset.dates.length - chartPointLimit) : 0;
  const chartData = dataset?.dates.slice(chartStartIndex).map((chartDate, offset) => Object.fromEntries([
    ["date", chartDate],
    ...selected.map((region) => [region.id, region.series[metric][chartStartIndex + offset]]),
  ])) ?? [];

  if (error) return <div className="permit-status permit-error"><strong>Building permits are temporarily unavailable.</strong><span>{error}</span></div>;
  if (!dataset || !metricInfo || !historyManifest || !provisionalManifest) return <div className="permit-status"><span className="loader" />Loading building permits…</div>;

  const currentIsPreliminary = frequency === "monthly" && selectedDate > `${historyManifest.latest_final_year}-12`;
  const counties = county === "Both" ? ["Orange County", "Los Angeles County"] : [county];
  const chartStartDate = dataset.dates[chartStartIndex];
  const chartEndDate = dataset.dates.at(-1)!;
  return (
    <div className="permit-stack">
      <section className="regional-intro permit-intro">
        <div><p className="section-kicker">Housing production pipeline</p><h2>Where new homes are being authorized.</h2></div>
        <p>Building permits are an early indicator of intended construction, not completed homes. Compare the structure mix and permitting intensity across 122 incorporated cities and two county unincorporated aggregates.</p>
      </section>

      <section className="control-deck" aria-label="Building permit controls">
        <div className="source-strip">
          <span className="source-badge census">Source: U.S. Census Bureau BPS · {frequency === "annual" ? "Annual" : "Monthly"}</span>
          <span className={currentIsPreliminary ? "permit-status-chip preliminary" : "permit-status-chip final"}>{currentIsPreliminary ? "Preliminary · subject to revision" : "Final annual history"}</span>
          <span>Final through {historyManifest.latest_final_year}; preliminary through {formatDate(provisionalManifest.latest_observation ?? "")}</span>
        </div>
        <div className="control-grid permit-controls">
          <LabelledSelect label="County" value={county} onChange={setCounty}>{COUNTY_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}</LabelledSelect>
          <LabelledSelect label="Frequency" value={frequency} onChange={(value) => setFrequency(value as Frequency)}><NativeSelectOption value="monthly">Monthly · 2022–present</NativeSelectOption><NativeSelectOption value="annual">Annual · 1980–present</NativeSelectOption></LabelledSelect>
          <LabelledSelect label="Metric" value={metric} onChange={(value) => setMetric(value as PermitMetricKey)}>{METRIC_OPTIONS.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}</LabelledSelect>
          <LabelledSelect label="Map & ranking date" value={selectedDate} onChange={setDate}>{[...dataset.dates].reverse().map((value) => <NativeSelectOption key={value} value={value}>{formatDate(value)}{frequency === "monthly" && value > `${historyManifest.latest_final_year}-12` ? " · preliminary" : ""}</NativeSelectOption>)}</LabelledSelect>
        </div>
        <div className="comparison-row">
          <LabelledSelect label="Add a comparison (up to five)" value={addId} onChange={setAddId}><NativeSelectOption value="">Choose a permit jurisdiction…</NativeSelectOption>{eligible.filter((region) => !selectedIds.includes(region.id)).map((region) => <NativeSelectOption key={region.id} value={region.id}>{region.name}</NativeSelectOption>)}</LabelledSelect>
          <button className="permit-add" type="button" disabled={!addId || selectedIds.length >= 5} onClick={() => { if (addId && !selectedIds.includes(addId)) setSelectedIds((current) => [...current, addId].slice(0, 5)); setAddId(""); }}>Add</button>
        </div>
        <div className="chips">
          {selected.map((region, index) => <button type="button" key={region.id} className={index === 0 ? "chip primary" : "chip"} onClick={() => setSelectedIds((current) => [region.id, ...current.filter((id) => id !== region.id)])}><i style={{ background: COLORS[index] }} />{region.name}<X onClick={(event) => { event.stopPropagation(); setSelectedIds((current) => current.filter((id) => id !== region.id)); }} /></button>)}
        </div>
      </section>

      <section className="kpi-grid permit-kpis">
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">{primary?.name ?? "Focus jurisdiction"}</p><p className="kpi-value">{formatValue(primaryValue, metricInfo)}</p><p className="kpi-note">{metricInfo.short_label} · {formatDate(selectedDate)}</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">Structure mix</p><p className="kpi-value">{formatValue(primary?.series.large_multifamily_share[dateIndex] ?? null, dataset.metrics.large_multifamily_share)}</p><p className="kpi-note">Share of authorized units in 5+-unit buildings</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">City rank</p><p className="kpi-value">{primaryRank > 0 ? `#${primaryRank}` : "—"}</p><p className="kpi-note">Of {ranked.length} reporting cities in selected county view</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">Observation status</p><p className="kpi-value permit-quality-value">{isImputed ? "Imputed" : currentIsPreliminary ? "Preliminary" : "Final"}</p><p className="kpi-note">{isImputed ? "Census estimate; use with added caution" : currentIsPreliminary ? "May be revised or imputed" : "Final annual benchmark"}</p></CardContent></Card>
      </section>

      <section className="analysis-grid permit-analysis-grid">
        <Card className="chart-card">
          <CardHeader className="chart-header permit-chart-header">
            <div><p className="section-kicker">Trend comparison</p><CardTitle>{metricInfo.label}</CardTitle></div>
            <div className="permit-chart-options">
              <p className="permit-definition">{metricInfo.definition}</p>
              <LabelledSelect
                label="Chart range"
                value={chartRange}
                onChange={(value) => frequency === "annual"
                  ? setAnnualChartRange(value as AnnualChartRange)
                  : setMonthlyChartRange(value as MonthlyChartRange)}
              >
                {frequency === "annual" ? (
                  <>
                    <NativeSelectOption value="10y">Last 10 years</NativeSelectOption>
                    <NativeSelectOption value="20y">Last 20 years</NativeSelectOption>
                    <NativeSelectOption value="30y">Last 30 years</NativeSelectOption>
                    <NativeSelectOption value="max">Full series · since 1980</NativeSelectOption>
                  </>
                ) : (
                  <>
                    <NativeSelectOption value="1y">Last 12 months</NativeSelectOption>
                    <NativeSelectOption value="3y">Last 3 years</NativeSelectOption>
                    <NativeSelectOption value="max">Full series · since 2022</NativeSelectOption>
                  </>
                )}
              </LabelledSelect>
            </div>
          </CardHeader>
          <CardContent className="permit-chart-wrap">
            <p className="permit-chart-window">Showing {formatDate(chartStartDate)}–{formatDate(chartEndDate)}</p>
            <div className="permit-chart" aria-label={`${metricInfo.label} trend`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 14, right: 16, bottom: 5, left: 4 }}>
                  <CartesianGrid stroke="#dbe3e8" strokeDasharray="3 4" />
                  <XAxis dataKey="date" minTickGap={frequency === "monthly" ? 45 : 24} tickFormatter={formatDate} tick={{ fill: "#627180", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(value) => formatValue(Number(value), metricInfo)} width={66} tick={{ fill: "#627180", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <ChartTooltip labelFormatter={(value) => formatDate(String(value))} formatter={(value, name) => [formatValue(Number(value), metricInfo), selected.find((region) => region.id === name)?.name ?? name]} />
                  {selected.map((region, index) => <Line key={region.id} type="monotone" dataKey={region.id} name={region.name} stroke={COLORS[index]} strokeWidth={index === 0 ? 2.8 : 1.8} dot={false} connectNulls={false} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <FigureAttribution sources={metric === "units_per_1000" ? ["census-bps", "census-acs"] : ["census-bps"]} />
            <p className="data-note">Annual data are final after the Census Bureau’s yearly revision cycle. Current-year monthly observations are preliminary; observations identified as imputed remain included and are disclosed in the status card.</p>
          </CardContent>
        </Card>
        <Card className="ranking-card permit-ranking">
          <CardHeader><p className="section-kicker">Cross-section</p><CardTitle>City ranking</CardTitle><div className="permit-rank-columns"><span>#</span><span>City</span><span>{metricInfo.short_label}</span></div></CardHeader>
          <CardContent className="ranking-list">
            {ranked.map((region, index) => <button type="button" className={region.id === primary?.id ? "permit-rank-row active" : "permit-rank-row"} key={region.id} onClick={() => setSelectedIds((current) => [region.id, ...current.filter((id) => id !== region.id)].slice(0, 5))}><span className="rank-number">{index + 1}</span><span className="rank-name">{region.name}<small>{region.county}</small></span><strong>{formatValue(region.series[metric][dateIndex], metricInfo)}</strong></button>)}
          </CardContent>
        </Card>
      </section>

      <section className="permit-county-summary" aria-label="County totals">
        {counties.map((countyName) => {
          const uninc = dataset.regions.find((region) => region.county === countyName && region.jurisdiction_type === "county_unincorporated");
          return <Card key={countyName}><CardHeader><p className="section-kicker">County accounting</p><CardTitle>{countyName}</CardTitle></CardHeader><CardContent><dl><div><dt>All permit jurisdictions</dt><dd>{formatValue(countyAggregate(dataset, countyName, metric, dateIndex), metricInfo)}</dd></div><div><dt>County unincorporated area</dt><dd>{formatValue(uninc?.series[metric][dateIndex] ?? null, metricInfo)}</dd></div></dl><p>County total sums incorporated cities and the county unincorporated aggregate; it does not double-count CDPs.</p></CardContent></Card>;
        })}
      </section>

      <PermitMap mapData={mapData} dataset={dataset} county={county} metric={metric} dateIndex={dateIndex} selectedId={primary?.id ?? ""} onSelect={(id) => setSelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5))} />

      <Card className="disclaimer-card permit-method-note"><CardContent className="method-copy">
        <p><strong>How to read this tab.</strong> A permit authorizes construction; it is not a housing start or completion. Units are classified by the number of units in the building, not tenure. “Units per 1,000” uses the {historyManifest.acs_vintage} ACS five-year housing-stock estimate as a fixed comparison denominator.</p>
        <p>HUD’s SOCDS interface offers jurisdiction lookups; this lab ingests the same Census Building Permits Survey place files directly for reproducible bulk updates. <a href={historyManifest.socds_page} target="_blank" rel="noreferrer">Verify in HUD SOCDS <ExternalLink /></a> <a href={historyManifest.methodology_page} target="_blank" rel="noreferrer">Census methodology <ExternalLink /></a></p>
      </CardContent></Card>
    </div>
  );
}
