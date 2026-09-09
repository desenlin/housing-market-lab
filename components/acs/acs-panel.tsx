"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Cell,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  ZAxis,
  ResponsiveContainer,
} from "recharts";
import { ExternalLink, RotateCcw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_MAP_FIT_OPTIONS, focusedMapBounds } from "@/lib/map-view";

type Value = number | null;
type Geography = "city" | "zip";
type County = "Orange County" | "Los Angeles County" | "Both";
type AcsView = "level" | "change";
type Relationship = "income_value" | "burden_rent";

type AcsMetric = {
  label: string;
  short_label: string;
  unit: "currency" | "share" | "people" | "years";
  decimals: number;
  change_mode: "percent" | "percentage_point" | "difference";
  source_table: string;
  universe: string;
  definition: string;
};

type AcsRegion = {
  id: string;
  name: string;
  county: string;
  series: Record<string, Value[]>;
  moe: Record<string, Value[]>;
};

type AcsDataset = {
  geography: Geography;
  periods: string[];
  metrics: Record<string, AcsMetric>;
  regions: AcsRegion[];
};

export type AcsManifestSummary = {
  release: string;
  created_at: string;
  provider: string;
  attribution: string;
  data_page: string;
  comparison_guidance: string;
  geography_guidance: string;
  bundle_sha256: string;
  latest_year: number;
  comparison_year: number;
  periods: string[];
  counts: Record<Geography, number>;
};

type MapData = {
  geography: Geography;
  counties: Record<string, {
    bounds: [[number, number], [number, number]];
    mapped: number;
    available: number;
    boundaries?: number;
    regions: {
      id: string;
      name: string;
      county?: string;
      geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
    }[];
  }>;
};

type MarketDataset = {
  geography: Geography | "metro";
  metrics: Record<string, { dates: string[] }>;
  regions: {
    id: string;
    name: string;
    county: string | null;
    series: Record<string, Value[] | { o: number; v: Value[] }>;
  }[];
};

const COUNTY_OPTIONS: County[] = ["Orange County", "Los Angeles County", "Both"];
const METRIC_ORDER = [
  "median_household_income",
  "renter_share",
  "rent_burden_share",
  "average_household_size",
  "median_age",
  "multifamily_share",
];
const LEVEL_COLORS = ["#fff3e9", "#ffd9bc", "#ffbb88", "#f58a3a", "#c9530a", "#793004"];
const CHANGE_COLORS = ["#194f78", "#75a8c6", "#dce8ee", "#f8e2d0", "#ed9859", "#ad4308"];

function metricDisplayLabel(key: string, metric: AcsMetric) {
  return key === "median_household_income" ? metric.label : metric.short_label;
}

function LabelledSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label className="control-label">
      <span>{label}</span>
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)} className="w-full">
        {children}
      </NativeSelect>
    </label>
  );
}

function DefinitionHelp({ label, definition }: { label: string; definition: string }) {
  return (
    <Tooltip>
      <TooltipTrigger aria-label={`Definition of ${label}`} className="definition-help" type="button">?</TooltipTrigger>
      <TooltipContent className="definition-tooltip" sideOffset={6}>{definition}</TooltipContent>
    </Tooltip>
  );
}

function formatEstimate(value: Value, metric: AcsMetric, change = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (change && metric.change_mode === "percent") return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
  if (metric.unit === "currency") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  if (metric.unit === "share") return `${value.toFixed(metric.decimals)}${change ? " pp" : "%"}`;
  const suffix = metric.unit === "years" ? " years" : metric.unit === "people" ? " people" : "";
  return `${change && value > 0 ? "+" : ""}${value.toFixed(metric.decimals)}${suffix}`;
}

function formatMargin(value: Value, metric: AcsMetric) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (metric.unit === "share") return `${value.toFixed(metric.decimals)} pp`;
  return formatEstimate(value, metric);
}

function changeValue(region: AcsRegion, key: string, metric: AcsMetric): Value {
  const [prior, current] = region.series[key] ?? [];
  if (prior == null || current == null) return null;
  if (metric.change_mode === "percent") return prior === 0 ? null : (current / prior - 1) * 100;
  return current - prior;
}

function changeSignificant(region: AcsRegion, key: string) {
  const [prior, current] = region.series[key] ?? [];
  const [priorMoe, currentMoe] = region.moe[key] ?? [];
  if ([prior, current, priorMoe, currentMoe].some((value) => value == null)) return null;
  return Math.abs(current! - prior!) > Math.sqrt(priorMoe! ** 2 + currentMoe! ** 2);
}

function relativeUncertainty(value: Value, moe: Value) {
  return value != null && moe != null && value !== 0 ? Math.abs(moe / value) : null;
}

function paddedDomain(values: number[], lowerBound = -Infinity, upperBound = Infinity): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const span = high - low;
  const padding = span > 0 ? span * 0.08 : Math.max(Math.abs(high) * 0.08, 1);
  return [Math.max(lowerBound, low - padding), Math.min(upperBound, high + padding)];
}

function expandSeries(series: Value[] | { o: number; v: Value[] } | undefined, length: number) {
  if (!series) return Array<Value>(length).fill(null);
  if (Array.isArray(series)) return [...series, ...Array<Value>(Math.max(0, length - series.length)).fill(null)].slice(0, length);
  const values = Array<Value>(length).fill(null);
  series.v.forEach((value, index) => {
    if (series.o + index < length) values[series.o + index] = value;
  });
  return values;
}

function normalizedName(value: string) {
  return value.toLowerCase().replace(/^city of\s+/, "").replace(/[^a-z0-9]/g, "");
}

function AcsMap({ county, mapData, dataset, metricKey, view, selectedId, onSelect }: {
  county: County;
  mapData: MapData;
  dataset: AcsDataset;
  metricKey: string;
  view: AcsView;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const onSelectRef = useRef(onSelect);
  const lastFitKey = useRef("");
  const [ready, setReady] = useState(false);
  const metric = dataset.metrics[metricKey];
  const regions = useMemo(() => new Map(dataset.regions.map((region) => [region.id, region])), [dataset]);
  const groups = county === "Both"
    ? [mapData.counties["Orange County"], mapData.counties["Los Angeles County"]].filter(Boolean)
    : [mapData.counties[county]].filter(Boolean);
  const shapes = groups.flatMap((group) => group.regions);
  const bounds = useMemo(() => groups.length === 1
    ? groups[0].bounds
    : ([
        [Math.min(...groups.map((group) => group.bounds[0][0])), Math.min(...groups.map((group) => group.bounds[0][1]))],
        [Math.max(...groups.map((group) => group.bounds[1][0])), Math.max(...groups.map((group) => group.bounds[1][1]))],
      ] as [[number, number], [number, number]]), [groups]);
  const plotted = useMemo(() => shapes.map((shape) => {
    const region = regions.get(shape.id);
    return {
      ...shape,
      region,
      value: region ? (view === "level" ? region.series[metricKey]?.[1] ?? null : changeValue(region, metricKey, metric)) : null,
      moe: region?.moe[metricKey]?.[1] ?? null,
    };
  }), [metric, metricKey, regions, shapes, view]);
  const finite = plotted.map((item) => item.value).filter((value): value is number => value != null && Number.isFinite(value));
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 0;

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!containerRef.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: true, minZoom: 7, maxZoom: 18 });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(map);
      mapRef.current = map;
      setReady(true);
    }
    start();
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
    if (!ready || !L || !map) return;
    layerRef.current?.remove();
    const byId = new Map(plotted.map((item) => [item.id, item]));
    const palette = view === "change" ? CHANGE_COLORS : LEVEL_COLORS;
    const span = view === "change" ? Math.max(Math.abs(low), Math.abs(high), 0.001) : null;
    const collection = {
      type: "FeatureCollection" as const,
      features: plotted.map((shape) => ({ type: "Feature" as const, properties: { id: shape.id, name: shape.name }, geometry: shape.geometry })),
    };
    layerRef.current = L.geoJSON(collection as GeoJSON.FeatureCollection, {
      style: (feature) => {
        const item = byId.get(String(feature?.properties?.id ?? ""));
        const value = item?.value;
        const ratio = value == null ? 0 : view === "change" ? (value + span!) / (2 * span!) : high === low ? 0.5 : (value - low) / (high - low);
        const color = value == null ? "#dce3e6" : palette[Math.min(palette.length - 1, Math.max(0, Math.floor(ratio * palette.length)))];
        return { color: item?.id === selectedId ? "#12355b" : "#ffffff", weight: item?.id === selectedId ? 3 : 1.1, fillColor: color, fillOpacity: item?.id === selectedId ? 0.9 : 0.75 };
      },
      onEachFeature: (feature, layer) => {
        const item = byId.get(String(feature.properties?.id ?? ""));
        const tooltip = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item?.name ?? "";
        const value = document.createElement("span");
        value.textContent = item?.value == null ? "ACS estimate unavailable" : `${metricDisplayLabel(metricKey, metric)}: ${formatEstimate(item.value, metric, view === "change")}`;
        const uncertainty = document.createElement("span");
        uncertainty.textContent = view === "level" && item?.moe != null ? `90% margin of error: ±${formatMargin(item.moe, metric)}` : "";
        tooltip.append(title, value);
        if (uncertainty.textContent) tooltip.append(uncertainty);
        layer.bindTooltip(tooltip, { sticky: true, direction: "top" });
        if (item?.region) layer.on("click", () => onSelectRef.current(item.id));
      },
    }).addTo(map);
    const fitKey = `${county}:${dataset.geography}`;
    if (lastFitKey.current !== fitKey) {
      map.fitBounds(L.latLngBounds(focusedMapBounds(county, bounds)), DEFAULT_MAP_FIT_OPTIONS);
      lastFitKey.current = fitKey;
    }
    map.invalidateSize({ pan: false });
  }, [bounds, county, dataset, high, low, metric, metricKey, plotted, ready, selectedId, view]);

  function reset() {
    const L = leafletRef.current;
    if (L && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(focusedMapBounds(county, bounds)), DEFAULT_MAP_FIT_OPTIONS);
  }

  return (
    <div className="map-panel acs-map-panel">
      <div className="map-heading">
        <div>
          <p className="section-kicker">Geographic pattern</p>
          <h3 className="metric-heading">
            {metric.label}
            <DefinitionHelp label={metric.label} definition={`${metric.definition} ACS table ${metric.source_table}; universe: ${metric.universe}.`} />
          </h3>
          <p>{view === "level" ? dataset.periods[1] : `${dataset.periods[0]} to ${dataset.periods[1]}`}</p>
        </div>
        <div className="map-tools">
          <button type="button" className="map-reset" onClick={reset}><RotateCcw /> Reset map</button>
          <div className="map-legend" aria-label="ACS map legend">
            <span className="map-legend-item map-legend-scale">{formatEstimate(low, metric, view === "change")}<i className="map-gradient" style={{ background: `linear-gradient(90deg, ${(view === "change" ? CHANGE_COLORS : LEVEL_COLORS).join(",")})` }} />{formatEstimate(high, metric, view === "change")}</span>
            <span className="map-legend-item"><i className="map-swatch no-data" />No estimate</span>
          </div>
        </div>
      </div>
      <div ref={containerRef} className="leaflet-map" role="region" aria-label={`${metric.label} ACS map`} />
      <p className="map-coverage">Estimates describe the full ACS period. Map colors are descriptive; hover for estimates and 90% margins of error.</p>
    </div>
  );
}

function RelationshipTooltip({ active, payload, relationship }: { active?: boolean; payload?: { payload: RelationshipPoint }[]; relationship: Relationship }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="acs-chart-tooltip">
      <strong>{point.name}</strong>
      <span>{point.county}</span>
      <span>{relationship === "income_value" ? `Median household income: ${point.xLabel}` : `Rent burden: ${point.xLabel}`}</span>
      <span>{relationship === "income_value" ? `Typical home value: ${point.yLabel}` : `Typical asking rent: ${point.yLabel}`}</span>
    </div>
  );
}

type RelationshipPoint = { id: string; name: string; county: string; x: number; y: number; xLabel: string; yLabel: string };
type RelationshipDomains = { x: [number, number]; y: [number, number] };

function RelationshipChart({ relationship, points, domains, selectedId }: {
  relationship: Relationship;
  points: RelationshipPoint[];
  domains: RelationshipDomains;
  selectedId: string;
}) {
  const incomeValue = relationship === "income_value";
  return (
    <div className="min-w-0">
      <div className="px-1">
        <p className="kpi-label">{incomeValue ? "Purchasing capacity" : "Rental affordability"}</p>
        <h3 className="metric-heading">{incomeValue ? "Median income vs. home value" : "Rent burden vs. asking rent"}</h3>
      </div>
      <div className="acs-relationship-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 14, right: 12, bottom: 26, left: 6 }}>
            <CartesianGrid stroke="#dfe6ea" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="ACS measure"
              domain={domains.x}
              allowDataOverflow
              allowDecimals={false}
              tickCount={5}
              tick={{ fontSize: 11 }}
              tickFormatter={(value) => incomeValue ? `$${Math.round(Number(value) / 1000)}k` : `${Math.round(Number(value))}%`}
              label={{ value: incomeValue ? "Median household income" : "Rent-burdened households", position: "insideBottom", offset: -16, fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Market measure"
              domain={domains.y}
              allowDataOverflow
              allowDecimals={false}
              tickCount={5}
              tick={{ fontSize: 11 }}
              tickFormatter={(value) => incomeValue ? `$${Math.round(Number(value) / 1000)}k` : `$${Math.round(Number(value))}`}
              width={58}
              label={{ value: incomeValue ? "Typical home value" : "Typical asking rent", angle: -90, position: "insideLeft", fontSize: 11 }}
            />
            <ZAxis range={[42, 42]} />
            <ChartTooltip content={<RelationshipTooltip relationship={relationship} />} />
            <Scatter data={points} fill="#12355b" fillOpacity={0.55}>
              {points.map((point) => <Cell key={point.id} fill={point.id === selectedId ? "#ff7a1a" : "#12355b"} fillOpacity={point.id === selectedId ? 1 : 0.52} stroke={point.id === selectedId ? "#7e3100" : "none"} />)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="data-note">{incomeValue
        ? "Ask: When similarly valued communities have different household incomes, what roles might wealth, access, expectations, or housing supply play? The relationship is descriptive, not causal."
        : "Ask: Why can communities with similar asking rents have different rent-burden rates? Consider household income, household composition, and the difference between asking rents and rents paid by existing tenants."}</p>
    </div>
  );
}

export function AcsPanel({ basePath, maps, marketDatasets, onManifest }: {
  basePath: string;
  maps: Record<string, MapData>;
  marketDatasets: Record<string, MarketDataset>;
  onManifest?: (manifest: AcsManifestSummary) => void;
}) {
  const [datasets, setDatasets] = useState<Record<Geography, AcsDataset> | null>(null);
  const [manifest, setManifest] = useState<AcsManifestSummary | null>(null);
  const [error, setError] = useState("");
  const [geography, setGeography] = useState<Geography>("city");
  const [county, setCounty] = useState<County>("Orange County");
  const [metricKey, setMetricKey] = useState("median_household_income");
  const [view, setView] = useState<AcsView>("level");
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const pointer = await fetch(`${basePath}/data/acs/latest.json`).then((response) => {
          if (!response.ok) throw new Error("No validated ACS release was found.");
          return response.json() as Promise<{ release: string }>;
        });
        const root = `${basePath}/data/acs/releases/${pointer.release}`;
        const [releaseManifest, city, zip] = await Promise.all([
          fetch(`${root}/manifest.json`).then((response) => response.json() as Promise<AcsManifestSummary>),
          fetch(`${root}/city.json`).then((response) => response.json() as Promise<AcsDataset>),
          fetch(`${root}/zip.json`).then((response) => response.json() as Promise<AcsDataset>),
        ]);
        if (cancelled) return;
        setDatasets({ city, zip });
        setManifest(releaseManifest);
        onManifest?.(releaseManifest);
        setSelectedId(city.regions.find((region) => region.name === "Fullerton")?.id ?? city.regions[0]?.id ?? "");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "The ACS context layer could not be loaded.");
      }
    }
    load();
    return () => { cancelled = true; };
  }, [basePath, onManifest]);

  const dataset = datasets?.[geography];
  const metric = dataset?.metrics[metricKey];
  const eligible = useMemo(() => dataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [], [county, dataset]);
  const selected = eligible.find((region) => region.id === selectedId) ?? eligible[0];

  const ranked = useMemo(() => {
    if (!metric) return [];
    return eligible.map((region) => ({
      region,
      level: region.series[metricKey]?.[1] ?? null,
      change: changeValue(region, metricKey, metric),
    })).filter((item) => (view === "level" ? item.level : item.change) != null)
      .sort((a, b) => ((view === "level" ? b.level : b.change) ?? -Infinity) - ((view === "level" ? a.level : a.change) ?? -Infinity));
  }, [eligible, metric, metricKey, view]);

  const relationshipPoints = useMemo((): Record<Relationship, RelationshipPoint[]> => {
    if (!dataset) return { income_value: [], burden_rent: [] };
    const market = marketDatasets[geography];
    const marketByName = new Map(market.regions.map((region) => [`${region.county ?? ""}:${normalizedName(region.name)}`, region]));

    function buildPoints(relationship: Relationship) {
      const marketMetric = relationship === "income_value" ? "zhvi" : "zori";
      const dates = market.metrics[marketMetric]?.dates ?? [];
      const xKey = relationship === "income_value" ? "median_household_income" : "rent_burden_share";
      return eligible.flatMap((region): RelationshipPoint[] => {
        const marketRegion = marketByName.get(`${region.county}:${normalizedName(region.name)}`);
        const values = expandSeries(marketRegion?.series[marketMetric], dates.length);
        const y = [...values].reverse().find((value): value is number => value != null) ?? null;
        const x = region.series[xKey]?.[1] ?? null;
        if (x == null || y == null) return [];
        const xMetric = dataset.metrics[xKey];
        return [{
          id: region.id,
          name: region.name,
          county: region.county,
          x,
          y,
          xLabel: formatEstimate(x, xMetric),
          yLabel: relationship === "income_value" ? `$${Math.round(y).toLocaleString()}` : `$${Math.round(y).toLocaleString()}/month`,
        }];
      });
    }

    return {
      income_value: buildPoints("income_value"),
      burden_rent: buildPoints("burden_rent"),
    };
  }, [dataset, eligible, geography, marketDatasets]);

  const relationshipDomains = useMemo((): Record<Relationship, RelationshipDomains> => ({
    income_value: {
      x: paddedDomain(relationshipPoints.income_value.map((point) => point.x), 0),
      y: paddedDomain(relationshipPoints.income_value.map((point) => point.y), 0),
    },
    burden_rent: {
      x: paddedDomain(relationshipPoints.burden_rent.map((point) => point.x), 0, 100),
      y: paddedDomain(relationshipPoints.burden_rent.map((point) => point.y), 0),
    },
  }), [relationshipPoints]);

  if (error) return <Card className="disclaimer-card"><CardHeader><CardTitle>ACS context is temporarily unavailable</CardTitle></CardHeader><CardContent className="method-copy"><p>{error}</p></CardContent></Card>;
  if (!dataset || !metric || !manifest) return <div className="permit-status"><span className="loader" aria-hidden="true" /><span>Loading housing context…</span></div>;

  const current = selected?.series[metricKey]?.[1] ?? null;
  const currentMoe = selected?.moe[metricKey]?.[1] ?? null;
  const selectedChange = selected ? changeValue(selected, metricKey, metric) : null;
  const rank = selected ? ranked.findIndex((item) => item.region.id === selected.id) + 1 : 0;

  function changeGeography(next: string) {
    const value = next as Geography;
    setGeography(value);
    if (value === "zip") setView("level");
    const preferred = value === "city" ? "Fullerton" : "92831";
    const nextDataset = datasets?.[value];
    const nextEligible = nextDataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [];
    setSelectedId(nextEligible.find((region) => region.name === preferred)?.id ?? nextEligible[0]?.id ?? "");
  }

  return (
    <div className="acs-stack">
      <section className="regional-intro acs-intro">
        <div><p className="section-kicker">Housing economics lens</p><h2>How do households and housing stock differ across local markets?</h2></div>
        <p>Six selected ACS measures connect market outcomes to purchasing capacity, tenure, affordability, household structure, age, and the existing housing stock. This is a focused interpretive layer—not a general demographic catalog.</p>
      </section>

      <section className="control-deck" aria-label="Housing context controls">
        <div className="source-strip">
          <span className="source-badge census">Source: Census ACS · 5-year estimates</span>
          <span>Latest period {dataset.periods[1]}</span>
          <span>90% margins of error retained</span>
        </div>
        <div className="control-grid acs-controls">
          <LabelledSelect label="County" value={county} onChange={(next) => setCounty(next as County)}>
            {COUNTY_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
          </LabelledSelect>
          <LabelledSelect label="Geography" value={geography} onChange={changeGeography}>
            <NativeSelectOption value="city">Cities &amp; communities</NativeSelectOption>
            <NativeSelectOption value="zip">ZIP Code Tabulation Areas</NativeSelectOption>
          </LabelledSelect>
          <LabelledSelect label="Measure" value={metricKey} onChange={setMetricKey}>
            {METRIC_ORDER.map((key) => <NativeSelectOption key={key} value={key}>{metricDisplayLabel(key, dataset.metrics[key])}</NativeSelectOption>)}
          </LabelledSelect>
          <LabelledSelect label="View" value={view} onChange={(next) => setView(next as AcsView)}>
            <NativeSelectOption value="level">Latest five-year estimate</NativeSelectOption>
            <NativeSelectOption value="change" disabled={geography === "zip"}>Non-overlapping change</NativeSelectOption>
          </LabelledSelect>
        </div>
        <p className="acs-control-note">{geography === "zip"
          ? "Historical change is limited to cities and communities because ZCTA boundary vintages are not sufficiently stable for a clean local comparison."
          : `Change compares ${dataset.periods[0]} with ${dataset.periods[1]}; consecutive overlapping ACS releases are intentionally omitted.`}</p>
      </section>

      <section className="kpi-grid acs-kpis" aria-label="Selected ACS estimate">
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">{selected?.name ?? "Selected place"}</p><p className="kpi-value">{formatEstimate(current, metric)}</p><p className="kpi-note">{metric.label} · {dataset.periods[1]}</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">90% margin of error</p><p className="kpi-value">{currentMoe == null ? "—" : `±${formatMargin(currentMoe, metric)}`}</p><p className="kpi-note">Sampling uncertainty around the estimate</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">Non-overlapping change</p><p className="kpi-value">{geography === "city" ? formatEstimate(selectedChange, metric, true) : "Not shown"}</p><p className="kpi-note">{geography === "city" && selected ? (changeSignificant(selected, metricKey) ? "Statistically distinguishable at 90%" : "Not distinguishable at 90%") : "Current ZCTA estimate only"}</p></CardContent></Card>
        <Card className="kpi-card"><CardContent className="p-4"><p className="kpi-label">Local rank</p><p className="kpi-value">{rank > 0 ? `${rank} of ${ranked.length}` : "—"}</p><p className="kpi-note">Ranked by the displayed {view === "level" ? "estimate" : "change"}</p></CardContent></Card>
      </section>

      <section className="analysis-grid acs-analysis-grid">
        <AcsMap county={county} mapData={maps[geography]} dataset={dataset} metricKey={metricKey} view={view} selectedId={selected?.id ?? ""} onSelect={setSelectedId} />
        <Card className="ranking-card acs-ranking">
          <CardHeader>
            <div className="ranking-title"><div><p className="section-kicker">Comparison</p><CardTitle>Local ranking</CardTitle></div></div>
            <div className="acs-rank-columns" aria-hidden="true"><span>#</span><span>Place</span><span>{view === "level" ? "Estimate" : "Change"}</span><span>{view === "level" ? "MOE" : "90% test"}</span></div>
          </CardHeader>
          <CardContent className="ranking-list">
            {ranked.map((item, index) => {
              const value = view === "level" ? item.level : item.change;
              const moe = item.region.moe[metricKey]?.[1] ?? null;
              const uncertain = relativeUncertainty(item.level, moe);
              return (
                <button key={item.region.id} type="button" onClick={() => setSelectedId(item.region.id)} className={`acs-rank-row${item.region.id === selected?.id ? " active" : ""}`}>
                  <span className="rank-number">{index + 1}</span>
                  <span className="rank-name">{item.region.name}<small>{item.region.county}{uncertain != null && uncertain > 0.3 ? " · high uncertainty" : ""}</small></span>
                  <strong>{formatEstimate(value, metric, view === "change")}</strong>
                  <span>{view === "level" ? (moe == null ? "—" : `±${formatMargin(moe, metric)}`) : (changeSignificant(item.region, metricKey) ? "Distinct" : "Not distinct")}</span>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section className="acs-profile-section">
        <div className="acs-section-heading"><div><p className="section-kicker">Selected community</p><h3>{selected?.name} housing context</h3></div><p>Each figure is an estimate for {dataset.periods[1]}, not a single-year observation.</p></div>
        <div className="acs-profile-grid">
          {METRIC_ORDER.map((key) => {
            const item = dataset.metrics[key];
            const value = selected?.series[key]?.[1] ?? null;
            const moe = selected?.moe[key]?.[1] ?? null;
            return <Card key={key} className="acs-profile-card"><CardContent className="p-4"><p className="kpi-label">{metricDisplayLabel(key, item)}</p><p className="acs-profile-value">{formatEstimate(value, item)}</p><p>90% MOE {moe == null ? "—" : `±${formatMargin(moe, item)}`}</p></CardContent></Card>;
          })}
        </div>
      </section>

      <Card className="chart-card acs-relationship-card">
        <CardHeader className="chart-header">
          <div><p className="section-kicker">Housing relationship</p><CardTitle>Household resources and housing-market outcomes</CardTitle></div>
        </CardHeader>
        <CardContent className="acs-relationship-wrap">
          <div className="grid gap-4 lg:grid-cols-2">
            <RelationshipChart
              relationship="income_value"
              points={relationshipPoints.income_value}
              domains={relationshipDomains.income_value}
              selectedId={selected?.id ?? ""}
            />
            <RelationshipChart
              relationship="burden_rent"
              points={relationshipPoints.burden_rent}
              domains={relationshipDomains.burden_rent}
              selectedId={selected?.id ?? ""}
            />
          </div>
        </CardContent>
      </Card>

      <p className="acs-method-note">ACS estimates are sample-based period estimates. Prior-period income is converted to {manifest.latest_year} dollars using annual-average U.S. CPI-U. <a href={manifest.comparison_guidance} target="_blank" rel="noreferrer">Read Census comparison guidance <ExternalLink /></a></p>
    </div>
  );
}
