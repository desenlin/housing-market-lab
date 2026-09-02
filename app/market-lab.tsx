"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Check, Copy, ExternalLink, Info, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Value = number | null;
type MetricKey =
  | "zhvi"
  | "zori"
  | "price_rent"
  | "inventory"
  | "days_pending"
  | "price_cut_share"
  | "sale_to_list";
type ViewKey = "level" | "yoy" | "index";

type Metric = {
  dates: string[];
  label: string;
  short_label: string;
  unit: string;
  decimals: number;
  definition: string;
};

type Region = {
  id: string;
  name: string;
  county: string | null;
  context: string | null;
  series: Record<string, Value[]>;
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
      viewBox: string;
      mapped: number;
      available: number;
      regions: { id: string; name: string; path: string }[];
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
  latest_observations: Record<string, string>;
  counts: Record<string, number>;
  map_coverage: Record<string, Record<string, { mapped: number; available: number }>>;
  sources: Record<
    string,
    { url: string; bytes: number; latest_observation: string; regions: number }
  >;
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
const COLORS = ["#ff7a1a", "#12355b", "#2f7d6d", "#9b4f96", "#c7a227"];

function lastValue(values: Value[]) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null) return { value: values[index] as number, index };
  }
  return null;
}

function metricSeries(dataset: Dataset, region: Region, metric: MetricKey) {
  if (metric !== "price_rent") {
    return {
      dates: dataset.metrics[metric]?.dates ?? [],
      values: region.series[metric] ?? [],
      unit: dataset.metrics[metric]?.unit ?? "number",
    };
  }
  const rent = dataset.metrics.zori;
  const value = dataset.metrics.zhvi;
  if (!rent || !value) return { dates: [], values: [], unit: "multiple" };
  const valueByDate = new Map(value.dates.map((date, index) => [date, region.series.zhvi?.[index]]));
  return {
    dates: rent.dates,
    values: rent.dates.map((date, index) => {
      const homeValue = valueByDate.get(date);
      const monthlyRent = region.series.zori?.[index];
      return homeValue != null && monthlyRent != null && monthlyRent > 0
        ? homeValue / (monthlyRent * 12)
        : null;
    }),
    unit: "multiple",
  };
}

function transformValues(values: Value[], view: ViewKey): Value[] {
  if (view === "level") return values;
  if (view === "yoy") {
    return values.map((value, index) => {
      const prior = values[index - 12];
      return value != null && prior != null && prior !== 0
        ? value / prior - 1
        : null;
    });
  }
  const base = values.find((value): value is number => value != null);
  return values.map((value) =>
    value != null && base != null && base !== 0 ? (value / base) * 100 : null,
  );
}

function formatValue(value: number | null, unit: string, view: ViewKey, compact = false) {
  if (value == null || Number.isNaN(value)) return "—";
  if (view === "yoy") return `${(value * 100).toFixed(1)}%`;
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
  if (unit === "share") return `${(value * 100).toFixed(1)}%`;
  if (unit === "ratio") return value.toFixed(3);
  if (unit === "multiple") return `${value.toFixed(1)}×`;
  if (unit === "days") return `${value.toFixed(0)} days`;
  return Math.round(value).toLocaleString();
}

function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
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

function SeriesChart({
  dataset,
  regions,
  metric,
  view,
}: {
  dataset: Dataset;
  regions: Region[];
  metric: MetricKey;
  view: ViewKey;
}) {
  const chart = useMemo(() => {
    if (!regions.length) return { rows: [], unit: "number" };
    const first = metricSeries(dataset, regions[0], metric);
    const series = regions.map((region) => {
      const current = metricSeries(dataset, region, metric);
      const byDate = new Map(
        current.dates.map((date, index) => [date, transformValues(current.values, view)[index]]),
      );
      return { region, byDate };
    });
    return {
      unit: first.unit,
      rows: first.dates.map((date) => ({
        date,
        ...Object.fromEntries(series.map(({ region, byDate }) => [region.id, byDate.get(date) ?? null])),
      })),
    };
  }, [dataset, regions, metric, view]);

  return (
    <div className="h-[360px] w-full" aria-label="Housing market time-series chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chart.rows} margin={{ top: 12, right: 12, left: 8, bottom: 8 }}>
          <CartesianGrid stroke="#dbe3e8" strokeDasharray="3 4" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(date) => String(date).slice(0, 4)}
            minTickGap={42}
            tick={{ fill: "#627180", fontSize: 12 }}
            axisLine={{ stroke: "#b9c6cf" }}
            tickLine={false}
          />
          <YAxis
            width={78}
            tickFormatter={(value) => formatValue(Number(value), chart.unit, view, true)}
            tick={{ fill: "#627180", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            labelFormatter={(date) => shortDate(String(date))}
            formatter={(value, name) => [
              formatValue(Number(value), chart.unit, view),
              regions.find((region) => region.id === String(name))?.name ?? String(name),
            ]}
            contentStyle={{ borderRadius: 8, borderColor: "#cbd6dc", boxShadow: "0 12px 30px #12355b20" }}
          />
          <Legend formatter={(id) => regions.find((region) => region.id === String(id))?.name ?? String(id)} />
          {regions.map((region, index) => (
            <Line
              key={region.id}
              type="monotone"
              dataKey={region.id}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={index === 0 ? 3 : 2}
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

function CountyMap({
  county,
  mapData,
  dataset,
  metric,
  view,
  selectedId,
  onSelect,
}: {
  county: string;
  mapData: MapData;
  dataset: Dataset;
  metric: MetricKey;
  view: ViewKey;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const shapes = mapData.counties[county];
  const values = shapes.regions.map((shape) => {
    const region = dataset.regions.find((item) => item.id === shape.id);
    const raw = region ? metricSeries(dataset, region, metric).values : [];
    const displayView = view === "index" ? "level" : view;
    return { id: shape.id, value: lastValue(transformValues(raw, displayView))?.value ?? null };
  });
  const finite = values.map((item) => item.value).filter((value): value is number => value != null);
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const color = (id: string) => {
    const value = values.find((item) => item.id === id)?.value;
    if (value == null || !Number.isFinite(low) || !Number.isFinite(high)) return "#e6ecef";
    const ratio = high === low ? 0.5 : (value - low) / (high - low);
    const start = [216, 231, 236];
    const end = [18, 53, 91];
    return `rgb(${start.map((part, index) => Math.round(part + (end[index] - part) * ratio)).join(",")})`;
  };

  return (
    <div className="map-panel">
      <div className="map-heading">
        <div>
          <h3>{county.replace(" County", "")}</h3>
          <p>{shapes.mapped} mapped of {shapes.available} data regions</p>
        </div>
        <span>Lower <i className="map-gradient" /> Higher</span>
      </div>
      <svg viewBox={shapes.viewBox} role="img" aria-label={`${county} housing metric map`}>
        {shapes.regions.map((shape) => (
          <path
            key={shape.id}
            d={shape.path}
            fill={color(shape.id)}
            className={shape.id === selectedId ? "map-region selected" : "map-region"}
            onClick={() => onSelect(shape.id)}
            tabIndex={0}
            role="button"
            aria-label={`Select ${shape.name}`}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(shape.id);
            }}
          >
            <title>{shape.name}</title>
          </path>
        ))}
      </svg>
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="kpi-card">
      <CardContent className="p-4">
        <p className="kpi-label">{label}</p>
        <p className="kpi-value">{value}</p>
        <p className="kpi-note">{note}</p>
      </CardContent>
    </Card>
  );
}

export default function MarketLab() {
  const [datasets, setDatasets] = useState<Record<string, Dataset> | null>(null);
  const [maps, setMaps] = useState<Record<string, MapData> | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const [geography, setGeography] = useState<"city" | "zip">("city");
  const [county, setCounty] = useState("Orange County");
  const [metric, setMetric] = useState<MetricKey>("zhvi");
  const [view, setView] = useState<ViewKey>("level");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addId, setAddId] = useState("");
  const [regionalMetric, setRegionalMetric] = useState<MetricKey>("zhvi");
  const [regionalView, setRegionalView] = useState<ViewKey>("index");
  const [regionalIds, setRegionalIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    async function load() {
      try {
        const pointer = await fetch(`${base}/data/latest.json`).then((response) => {
          if (!response.ok) throw new Error("No published data release was found.");
          return response.json() as Promise<{ release: string }>;
        });
        const releaseBase = `${base}/data/releases/${pointer.release}`;
        const [city, zip, metro, mapCity, mapZip, releaseManifest] = await Promise.all([
          fetch(`${releaseBase}/city.json`).then((response) => response.json()),
          fetch(`${releaseBase}/zip.json`).then((response) => response.json()),
          fetch(`${releaseBase}/metro.json`).then((response) => response.json()),
          fetch(`${releaseBase}/map-city.json`).then((response) => response.json()),
          fetch(`${releaseBase}/map-zip.json`).then((response) => response.json()),
          fetch(`${releaseBase}/manifest.json`).then((response) => response.json()),
        ]);
        setDatasets({ city, zip, metro });
        setMaps({ city: mapCity, zip: mapZip });
        setManifest(releaseManifest);
        const orangeCities = (city as Dataset).regions.filter((region) => region.county === "Orange County");
        const defaults = ["Fullerton", "Irvine", "Anaheim"]
          .map((name) => orangeCities.find((region) => region.name === name)?.id)
          .filter((id): id is string => Boolean(id));
        setSelectedIds(defaults.length ? defaults : orangeCities.slice(0, 3).map((region) => region.id));
        const metros = (metro as Dataset).regions;
        setRegionalIds(
          ["Los Angeles", "Riverside", "San Diego"]
            .map((name) => metros.find((region) => region.name === name)?.id)
            .filter((id): id is string => Boolean(id)),
        );
        const query = new URLSearchParams(window.location.search);
        const queryGeo = query.get("geo");
        const queryCounty = query.get("county");
        const queryMetric = query.get("metric");
        const queryView = query.get("view");
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
        if (restoredIds.length) setSelectedIds(restoredIds);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The data release could not be loaded.");
      }
    }
    load();
  }, []);

  const dataset = datasets?.[geography];
  const eligible = useMemo(
    () =>
      dataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [],
    [dataset, county],
  );

  const selectedRegions = selectedIds
    .map((id) => eligible.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(region));
  const primary = selectedRegions[0];
  const primarySeries = dataset && primary ? metricSeries(dataset, primary, metric) : null;
  const primaryLast = primarySeries ? lastValue(primarySeries.values) : null;
  const primaryYoy = primarySeries ? lastValue(transformValues(primarySeries.values, "yoy")) : null;
  const fiveYear = (() => {
    if (!primarySeries || !primaryLast) return null;
    const prior = primarySeries.values[primaryLast.index - 60];
    return prior != null && prior !== 0 ? primaryLast.value / prior - 1 : null;
  })();
  const ranked = useMemo(() => {
    if (!dataset) return [];
    return eligible
      .map((region) => {
        const series = metricSeries(dataset, region, metric);
        const level = lastValue(series.values)?.value ?? null;
        const yoy = lastValue(transformValues(series.values, "yoy"))?.value ?? null;
        return { region, level, yoy, unit: series.unit };
      })
      .filter((item) => item.level != null)
      .sort((a, b) => (b.level ?? -Infinity) - (a.level ?? -Infinity));
  }, [dataset, eligible, metric]);
  const rank = primary ? ranked.findIndex((item) => item.region.id === primary.id) + 1 : 0;
  const unit = primarySeries?.unit ?? "number";

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
  }

  function addRegion() {
    if (!addId || selectedIds.includes(addId) || selectedIds.length >= 5) return;
    setSelectedIds((current) => [...current, addId]);
    setAddId("");
  }

  function selectPrimary(id: string) {
    setSelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
  }

  async function copyLink() {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("geo", geography);
    url.searchParams.set("county", county);
    url.searchParams.set("metric", metric);
    url.searchParams.set("view", view);
    url.searchParams.set("regions", selectedIds.join(","));
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (error) {
    return <main className="status-screen"><Info /><h1>Housing Market Lab</h1><p>{error}</p></main>;
  }
  if (!datasets || !maps || !manifest || !dataset) {
    return <main className="status-screen"><div className="loader" /><h1>Housing Market Lab</h1><p>Loading the latest validated release…</p></main>;
  }

  const currentMetricLabel = LOCAL_METRICS.find((item) => item.key === metric)?.label ?? metric;
  const regionalRegions = regionalIds
    .map((id) => datasets.metro.regions.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(region));

  return (
    <main>
      <header className="site-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Desen Lin · Academic data project</p>
            <h1>Housing Market Lab</h1>
            <p className="deck">A focused view of Southern California’s housing market—and the cycles around it.</p>
          </div>
          <div className="release-stamp">
            <span>Latest validated release</span>
            <strong>{manifest.release}</strong>
            <small>Data through {shortDate(Object.values(manifest.latest_observations).sort().at(-1) ?? manifest.release)}</small>
          </div>
        </div>
      </header>

      <Tabs defaultValue="local" className="page-shell">
        <TabsList variant="line" className="main-tabs" aria-label="Dashboard sections">
          <TabsTrigger value="local">Local explorer</TabsTrigger>
          <TabsTrigger value="regional">Regional cycle</TabsTrigger>
          <TabsTrigger value="methods">Data &amp; methods</TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="space-y-5">
          <section className="control-deck" aria-label="Local market controls">
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
            <Kpi label={currentMetricLabel} value={formatValue(primaryLast?.value ?? null, unit, "level")} note={primaryLast ? `As of ${shortDate(primarySeries!.dates[primaryLast.index])}` : "No observation"} />
            <Kpi label="Year over year" value={formatValue(primaryYoy?.value ?? null, unit, "yoy")} note="Versus the same month one year ago" />
            <Kpi label="Five-year change" value={formatValue(fiveYear, unit, "yoy")} note="Longer view of the recent cycle" />
            <Kpi label={`${county === "Both" ? "Two-county" : county.replace(" County", "")} rank`} value={rank ? `${rank} of ${ranked.length}` : "—"} note={`Ranked by current ${currentMetricLabel.toLowerCase()}`} />
          </section>

          <section className="analysis-grid">
            <Card className="chart-card">
              <CardHeader className="chart-header">
                <div><p className="section-kicker">Time</p><CardTitle>{currentMetricLabel}</CardTitle></div>
                <p>{view === "level" ? "Monthly level" : view === "yoy" ? "Percent change from one year earlier" : "Each series begins at 100"}</p>
              </CardHeader>
              <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
                <SeriesChart dataset={dataset} regions={selectedRegions} metric={metric} view={view} />
                {metric !== "zhvi" && selectedRegions.some((region) => metricSeries(dataset, region, metric).values.every((value) => value == null)) && (
                  <p className="data-note">Some regions are omitted where Zillow does not publish a usable rent history.</p>
                )}
              </CardContent>
            </Card>

            <Card className="ranking-card">
              <CardHeader><p className="section-kicker">Place</p><CardTitle>Current ranking</CardTitle></CardHeader>
              <CardContent className="ranking-list">
                {ranked.slice(0, 12).map((item, index) => (
                  <button key={item.region.id} onClick={() => selectPrimary(item.region.id)} className={item.region.id === primary?.id ? "rank-row active" : "rank-row"}>
                    <span className="rank-number">{index + 1}</span>
                    <span className="rank-name">{item.region.name}<small>{item.region.context}</small></span>
                    <strong>{formatValue(item.level, item.unit, "level", true)}</strong>
                    <span className={(item.yoy ?? 0) < 0 ? "negative" : "positive"}>{formatValue(item.yoy, item.unit, "yoy")}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className={county === "Both" ? "maps-grid two" : "maps-grid"}>
            {(county === "Both" ? ["Orange County", "Los Angeles County"] : [county]).map((currentCounty) => (
              <CountyMap key={currentCounty} county={currentCounty} mapData={maps[geography]} dataset={dataset} metric={metric} view={view} selectedId={primary?.id ?? ""} onSelect={selectPrimary} />
            ))}
          </section>
        </TabsContent>

        <TabsContent value="regional" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Context</p><h2>How does Los Angeles fit into the housing cycle?</h2></div>
            <p>Compare a consistent set of Western and high-growth metros. These metro-level measures add market liquidity and competition signals that are not consistently available for every city or ZIP.</p>
          </section>
          <section className="control-deck">
            <div className="control-grid regional-controls">
              <LabelledSelect label="Metric" value={regionalMetric} onChange={(next) => setRegionalMetric(next as MetricKey)}>
                {REGIONAL_METRICS.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}
              </LabelledSelect>
              <LabelledSelect label="View" value={regionalView} onChange={(next) => setRegionalView(next as ViewKey)}>
                <NativeSelectOption value="level">Level</NativeSelectOption>
                <NativeSelectOption value="yoy">Year-over-year change</NativeSelectOption>
                <NativeSelectOption value="index">Indexed to 100</NativeSelectOption>
              </LabelledSelect>
            </div>
            <div className="metro-checks">
              {datasets.metro.regions.map((region) => {
                const checked = regionalIds.includes(region.id);
                return <button key={region.id} className={checked ? "metro-toggle active" : "metro-toggle"} onClick={() => setRegionalIds((ids) => checked ? ids.filter((id) => id !== region.id) : ids.length < 5 ? [...ids, region.id] : ids)}><i />{region.name}</button>;
              })}
            </div>
          </section>
          <Card className="chart-card regional-chart">
            <CardHeader className="chart-header"><div><p className="section-kicker">Metro comparison</p><CardTitle>{REGIONAL_METRICS.find((item) => item.key === regionalMetric)?.label}</CardTitle></div><p>Choose up to five metros</p></CardHeader>
            <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0"><SeriesChart dataset={datasets.metro} regions={regionalRegions} metric={regionalMetric} view={regionalView} /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="methods" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Reproducibility</p><h2>A small, inspectable data product.</h2></div>
            <p>The project favors a curated teaching dataset over a mirror of every provider variable. Each release can be cited, reproduced, and retained if a future download fails.</p>
          </section>
          <section className="method-grid">
            <Card><CardHeader><CardTitle>Measures</CardTitle></CardHeader><CardContent className="method-copy"><p><strong>ZHVI</strong> estimates the typical mid-tier home value. <strong>ZORI</strong> tracks typical observed asking rent. The price–rent multiple is ZHVI divided by twelve months of ZORI.</p><p>Year-over-year change uses the observation from twelve months earlier. Indexed views set the first available observation to 100.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Geographies</CardTitle></CardHeader><CardContent className="method-copy"><p>City/community and ZIP views retain Zillow’s market labels for Orange and Los Angeles counties. ZIP map boundaries are Census ZCTAs: useful approximations, but not identical to USPS delivery ZIPs.</p><p>Clicking the map changes the focus series; the chart and ranking use the provider’s data geography.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Release design</CardTitle></CardHeader><CardContent className="method-copy"><p>Automation downloads source files into temporary storage, checks dates and minimum coverage, creates compact JSON, then advances a small <code>latest.json</code> pointer only after every validation succeeds.</p><p>If an update fails, the published site continues using the prior validated release.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Cost &amp; portability</CardTitle></CardHeader><CardContent className="method-copy"><p>The site is a static export: no database, server, paid API, account, or map-tile service. GitHub Actions performs periodic updates and GitHub Pages serves the files.</p><p>A 50 MB processed-data guardrail catches accidental growth before release.</p></CardContent></Card>
          </section>
          <Card className="provenance-card">
            <CardHeader><CardTitle>Current release provenance</CardTitle></CardHeader>
            <CardContent>
              <dl className="provenance-grid"><div><dt>Release</dt><dd>{manifest.release}</dd></div><div><dt>Created</dt><dd>{new Date(manifest.created_at).toLocaleString()}</dd></div><div><dt>Coverage</dt><dd>{manifest.counts.city} city/community · {manifest.counts.zip} ZIP · {manifest.counts.metro} metro</dd></div><div><dt>Bundle fingerprint</dt><dd><code>{manifest.bundle_sha256.slice(0, 16)}…</code></dd></div></dl>
              <p className="attribution">{manifest.attribution}. This independent academic visualization is not endorsed by Zillow Group.</p>
              <a className="source-link" href={manifest.data_page} target="_blank" rel="noreferrer">View Zillow Research source data <ExternalLink /></a>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <footer><p>Housing Market Lab · Built for transparent, exploratory teaching and research.</p><p>{manifest.attribution}</p></footer>
    </main>
  );
}
