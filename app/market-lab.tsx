"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Check, Copy, ExternalLink, Info, Plus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  | "median_sale_ppsf";
type ViewKey = "level" | "yoy" | "index";
type ChangeMode = "percent" | "difference" | "percentage_point";
type TimeRange = "1y" | "3y" | "5y" | "max";
type RankKey = "growth" | "level";
type MapPaletteKey = "navy" | "orange";

type Metric = {
  dates: string[];
  label: string;
  short_label: string;
  unit: string;
  decimals: number;
  definition: string;
  provider?: string;
  frequency?: string;
  change_mode?: ChangeMode;
};

type Region = {
  id: string;
  name: string;
  county: string | null;
  context: string | null;
  series: Record<string, Value[] | { o: number; v: Value[] }>;
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

function metricSeries(dataset: Dataset, region: Region, metric: MetricKey) {
  if (metric !== "price_rent") {
    const metadata = dataset.metrics[metric];
    const dates = metadata?.dates ?? [];
    return {
      dates,
      values: expandedSeries(region.series[metric], dates.length),
      unit: metadata?.unit ?? "number",
      changeMode: metadata?.change_mode ??
        (metadata?.unit === "share" ? "percentage_point" : metadata?.unit === "ratio" ? "difference" : "percent"),
    };
  }
  const rent = dataset.metrics.zori;
  const value = dataset.metrics.zhvi;
  if (!rent || !value) return { dates: [], values: [], unit: "multiple", changeMode: "percent" as ChangeMode };
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
    unit: "multiple",
    changeMode: "percent" as ChangeMode,
  };
}

function transformValues(
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
  if (unit === "days") return `${value.toFixed(0)} days`;
  if (unit === "months") return `${value.toFixed(1)} months`;
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

function SeriesChart({
  dataset,
  regions,
  metric,
  view,
  timeRange,
  indexBaseMonth,
}: {
  dataset: Dataset;
  regions: Region[];
  metric: MetricKey;
  view: ViewKey;
  timeRange: TimeRange;
  indexBaseMonth: string;
}) {
  const chart = useMemo(() => {
    if (!regions.length) return { rows: [], unit: "number", changeMode: "percent" as ChangeMode };
    const first = metricSeries(dataset, regions[0], metric);
    const series = regions.map((region) => {
      const current = metricSeries(dataset, region, metric);
      const byDate = new Map(
        current.dates.map((date, index) => [
          date,
          transformValues(current.values, view, current.dates, indexBaseMonth, current.changeMode)[index],
        ]),
      );
      return { region, byDate };
    });
    const rows = first.dates.map((date) => ({
      date,
      ...Object.fromEntries(series.map(({ region, byDate }) => [region.id, byDate.get(date) ?? null])),
    }));
    const rangeStart = timeRangeStart(rows.length, timeRange);
    const indexStart = view === "index"
      ? Math.max(0, rows.findIndex((row) => row.date.startsWith(indexBaseMonth)))
      : 0;
    return {
      unit: first.unit,
      changeMode: first.changeMode,
      rows: rows.slice(Math.max(rangeStart, indexStart)),
    };
  }, [dataset, regions, metric, view, timeRange, indexBaseMonth]);

  return (
    <div className="h-[360px] min-w-0 w-full" aria-label="Housing market time-series chart">
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
            tickFormatter={(value) => formatValue(Number(value), chart.unit, view, true, chart.changeMode)}
            tick={{ fill: "#627180", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <ChartTooltip
            labelFormatter={(date) => shortDate(String(date))}
            formatter={(value, name) => [
              formatValue(Number(value), chart.unit, view, false, chart.changeMode),
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
  metricLabel,
  view,
  indexBaseMonth,
  selectedId,
  onSelect,
  paletteKey,
  onPaletteChange,
  provider,
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
        const series = region ? metricSeries(dataset, region, metric) : null;
        const transformed = series
          ? transformValues(series.values, view, series.dates, indexBaseMonth, series.changeMode)
          : [];
        const yoy = series
          ? lastValue(transformValues(series.values, "yoy", series.dates, "", series.changeMode))?.value ?? null
          : null;
        return {
          id: shape.id,
          dataId: region?.id ?? null,
          name: shape.name,
          county: shape.county ?? region?.county ?? "",
          value: lastValue(transformed)?.value ?? null,
          yoy,
          unit: series?.unit ?? "number",
          changeMode: series?.changeMode ?? "percent",
        };
      }),
    [dataset, datasetByPlace, indexBaseMonth, metric, shapes.regions, view],
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
          color: isSelected ? "#ff7a1a" : "#ffffff",
          weight: isSelected ? 3 : 1.2,
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
        const location = document.createElement("span");
        location.textContent = item?.county ?? "";
        tooltip.append(name, location, measure, growth);
        layer.bindTooltip(tooltip, { sticky: true, direction: "top" });
        if (item?.dataId) layer.on("click", () => onSelectRef.current(item.dataId!));
      },
    }).addTo(map);
    layerRef.current = overlay;
    const fitKey = `${county}:${dataset.geography}`;
    if (lastFitKey.current !== fitKey) {
      map.fitBounds(L.latLngBounds(shapes.bounds), { padding: [18, 18], maxZoom: 11 });
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
      mapRef.current.fitBounds(L.latLngBounds(shapes.bounds), { padding: [18, 18], maxZoom: 11 });
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
        </div>
      )}
      <div
        ref={containerRef}
        className="leaflet-map"
        role="region"
        aria-label={`${countyLabel} ${geographyLabel.toLowerCase()} map of ${metricLabel.toLowerCase()}`}
      />
      <p className="map-coverage">{observed} of {shapes.regions.length} boundaries have a current {provider} observation for this measure. Gray boundaries have no data; unshaded map areas are outside the displayed {dataset.geography === "city" ? "city/CDP" : "ZCTA"} geography. Hover or tap a boundary for details; click a data region to update the focus series.</p>
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
  return <span className={`source-badge ${provider.toLowerCase()}`}>Source: {provider}{frequency ? ` · ${frequency}` : ""}</span>;
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
  const [maps, setMaps] = useState<Record<string, MapData> | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [redfinManifest, setRedfinManifest] = useState<RedfinManifest | null>(null);
  const [activityError, setActivityError] = useState("");
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
  const [regionalMetric, setRegionalMetric] = useState<MetricKey>("zhvi");
  const [regionalView, setRegionalView] = useState<ViewKey>("index");
  const [regionalTimeRange, setRegionalTimeRange] = useState<TimeRange>("max");
  const [regionalIndexBaseRequest, setRegionalIndexBaseRequest] = useState("2015-01");
  const [regionalIds, setRegionalIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [activityMetric, setActivityMetric] = useState<MetricKey>("months_supply");
  const [activityView, setActivityView] = useState<Exclude<ViewKey, "index">>("level");
  const [activityTimeRange, setActivityTimeRange] = useState<TimeRange>("5y");
  const [activityRankBy, setActivityRankBy] = useState<RankKey>("growth");

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
        try {
          const redfinPointer = await fetch(`${base}/data/redfin/latest.json`).then((response) => {
            if (!response.ok) throw new Error("No validated Redfin release was found.");
            return response.json() as Promise<{ release: string }>;
          });
          const redfinBase = `${base}/data/redfin/releases/${redfinPointer.release}`;
          const [redfinCity, redfinZip, redfinReleaseManifest] = await Promise.all([
            fetch(`${redfinBase}/city.json`).then((response) => response.json()),
            fetch(`${redfinBase}/zip.json`).then((response) => response.json()),
            fetch(`${redfinBase}/manifest.json`).then((response) => response.json()),
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
        const queryRange = query.get("range");
        const queryBase = query.get("base");
        const queryPalette = query.get("palette");
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
        if (restoredIds.length) setSelectedIds(restoredIds);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The data release could not be loaded.");
      }
    }
    load();
  }, []);

  const dataset = datasets?.[geography];
  const localDates = dataset ? metricDates(dataset, metric) : [];
  const indexBaseMonth = normalizedBaseMonth(localDates, indexBaseRequest);
  const regionalDates = datasets ? metricDates(datasets.metro, regionalMetric) : [];
  const regionalIndexBaseMonth = normalizedBaseMonth(regionalDates, regionalIndexBaseRequest);
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
  const primaryYoy = primarySeries
    ? lastValue(transformValues(primarySeries.values, "yoy", primarySeries.dates))
    : null;
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
        const yoy = lastValue(transformValues(series.values, "yoy", series.dates))?.value ?? null;
        return { region, level, yoy, unit: series.unit };
      })
      .filter((item) => item.level != null)
      .sort((a, b) =>
        rankBy === "growth"
          ? (b.yoy ?? -Infinity) - (a.yoy ?? -Infinity)
          : (b.level ?? -Infinity) - (a.level ?? -Infinity),
      );
  }, [dataset, eligible, metric, rankBy]);
  const rank = primary ? ranked.findIndex((item) => item.region.id === primary.id) + 1 : 0;
  const unit = primarySeries?.unit ?? "number";

  const activityDataset = activityDatasets?.[geography];
  const activityDates = activityDataset ? metricDates(activityDataset, activityMetric) : [];
  const activityEligible = useMemo(
    () => activityDataset?.regions.filter((region) => county === "Both" || region.county === county) ?? [],
    [activityDataset, county],
  );
  const activitySelectedRegions = (() => {
    const selected = activitySelectedIds
      .map((id) => activityEligible.find((region) => region.id === id))
      .filter((region): region is Region => Boolean(region));
    return selected.length ? selected : activityEligible.slice(0, 1);
  })();
  const activityPrimary = activitySelectedRegions[0];
  const activityPrimarySeries = activityDataset && activityPrimary
    ? metricSeries(activityDataset, activityPrimary, activityMetric)
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
        const series = metricSeries(activityDataset, region, activityMetric);
        const level = lastValue(series.values)?.value ?? null;
        const yoy = lastValue(transformValues(series.values, "yoy", series.dates, "", series.changeMode))?.value ?? null;
        return { region, level, yoy, unit: series.unit, changeMode: series.changeMode };
      })
      .filter((item) => item.level != null)
      .sort((a, b) => activityRankBy === "growth"
        ? (b.yoy ?? -Infinity) - (a.yoy ?? -Infinity)
        : (b.level ?? -Infinity) - (a.level ?? -Infinity));
  }, [activityDataset, activityEligible, activityMetric, activityRankBy]);
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
    const nextActivityRegions = activityDataset?.regions.filter(
      (region) => next === "Both" || region.county === next,
    ) ?? [];
    const activityFirst = nextActivityRegions.find((region) => region.name === preferred)
      ?? nextActivityRegions[0];
    setActivitySelectedIds(activityFirst ? [activityFirst.id] : []);
  }

  function addRegion() {
    if (!addId || selectedIds.includes(addId) || selectedIds.length >= 5) return;
    setSelectedIds((current) => [...current, addId]);
    setAddId("");
  }

  function selectPrimary(id: string) {
    setSelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
  }

  function addActivityRegion() {
    if (!activityAddId || activitySelectedIds.includes(activityAddId) || activitySelectedIds.length >= 5) return;
    setActivitySelectedIds((current) => [...current, activityAddId]);
    setActivityAddId("");
  }

  function selectActivityPrimary(id: string) {
    setActivitySelectedIds((current) => [id, ...current.filter((item) => item !== id)].slice(0, 5));
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
    url.searchParams.set("palette", mapPalette);
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
    : dataset.metrics[metric];
  const activityMetricMetadata = activityDataset?.metrics[activityMetric];
  const regionalMetricMetadata = datasets.metro.metrics[regionalMetric];
  const regionalRegions = regionalIds
    .map((id) => datasets.metro.regions.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(region));

  return (
    <TooltipProvider delayDuration={120}>
    <main>
      <header className="site-header">
        <div className="header-inner">
          <div>
            <p className="eyebrow">Real Estate Analytics</p>
            <h1>Housing Market Lab</h1>
            <p className="byline">Created by Desen Lin, California State University, Fullerton.</p>
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
          <TabsTrigger value="activity">Local market activity</TabsTrigger>
          <TabsTrigger value="regional">Regional cycle</TabsTrigger>
          <TabsTrigger value="methods">Data &amp; methods</TabsTrigger>
        </TabsList>

        <TabsContent value="local" className="space-y-5">
          <section className="control-deck" aria-label="Local market controls">
            <div className="source-strip"><SourceBadge provider={currentMetricMetadata.provider ?? "Zillow"} frequency={currentMetricMetadata.frequency ?? "Monthly"} /><span>Values and rents</span></div>
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
            <Kpi label={currentMetricLabel} definition={currentMetricMetadata.definition} value={formatValue(primaryLast?.value ?? null, unit, "level")} note={primaryLast ? `As of ${shortDate(primarySeries!.dates[primaryLast.index])}` : "No observation"} />
            <Kpi label="Year over year" value={formatValue(primaryYoy?.value ?? null, unit, "yoy")} note="Versus the same month one year ago" />
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
                  <p>{view === "level" ? "Monthly level" : view === "yoy" ? "Percent change from one year earlier" : `${shortDate(`${indexBaseMonth}-01`)} = 100`}</p>
                </div>
              </CardHeader>
              <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
                <SeriesChart dataset={dataset} regions={selectedRegions} metric={metric} view={view} timeRange={timeRange} indexBaseMonth={indexBaseMonth} />
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
                  <button key={item.region.id} onClick={() => selectPrimary(item.region.id)} className={item.region.id === primary?.id ? "rank-row active" : "rank-row"}>
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
            <CountyMap county={county} mapData={maps[geography]} dataset={dataset} metric={metric} metricLabel={currentMetricLabel} view={view} indexBaseMonth={indexBaseMonth} selectedId={primary?.id ?? ""} onSelect={selectPrimary} paletteKey={mapPalette} onPaletteChange={setMapPalette} provider="Zillow" />
          </section>
        </TabsContent>

        <TabsContent value="activity" className="space-y-5">
          {activityError || !activityDataset || !redfinManifest || !activityMetricMetadata ? (
            <Card className="disclaimer-card">
              <CardHeader><CardTitle>Market activity is temporarily unavailable</CardTitle></CardHeader>
              <CardContent className="method-copy"><p>{activityError || "The latest Redfin release has not finished loading."} Zillow value and rent views remain available.</p></CardContent>
            </Card>
          ) : (
            <>
              <section className="regional-intro activity-intro">
                <div><p className="section-kicker">Listings and transactions</p><h2>How quickly is the local market moving?</h2></div>
                <p>Redfin adds city- and ZIP-level supply, speed, competition, repricing, and sale-price signals. Each observation is a rolling three-month window, so the change view compares it with the same three-month window one year earlier.</p>
              </section>
              <section className="control-deck" aria-label="Local market activity controls">
                <div className="source-strip"><SourceBadge provider="Redfin" frequency={redfinManifest.frequency} /><span>Data through {shortDate(activityDates.at(-1) ?? redfinManifest.release)}</span></div>
                <div className="control-grid activity-controls">
                  <LabelledSelect label="County" value={county} onChange={changeCounty}>
                    {COUNTY_OPTIONS.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
                  </LabelledSelect>
                  <LabelledSelect label="Geography" value={geography} onChange={changeGeography}>
                    <NativeSelectOption value="city">Cities &amp; communities</NativeSelectOption>
                    <NativeSelectOption value="zip">ZIP codes</NativeSelectOption>
                  </LabelledSelect>
                  <LabelledSelect label="Metric" value={activityMetric} onChange={(next) => setActivityMetric(next as MetricKey)}>
                    {ACTIVITY_METRICS.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}
                  </LabelledSelect>
                  <LabelledSelect label="View" value={activityView} onChange={(next) => setActivityView(next as Exclude<ViewKey, "index">)}>
                    <NativeSelectOption value="level">Level</NativeSelectOption>
                    <NativeSelectOption value="yoy">Change from one year earlier</NativeSelectOption>
                  </LabelledSelect>
                </div>
                <div className="comparison-row">
                  <label className="control-label comparison-select">
                    <span>Add a comparison (up to five)</span>
                    <NativeSelect value={activityAddId} onChange={(event) => setActivityAddId(event.target.value)} className="w-full">
                      <NativeSelectOption value="">Choose a region…</NativeSelectOption>
                      {activityEligible.filter((region) => !activitySelectedIds.includes(region.id)).map((region) => (
                        <NativeSelectOption key={region.id} value={region.id}>{region.name}{region.context ? ` · ${region.context}` : ""}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <Button variant="outline" onClick={addActivityRegion} disabled={!activityAddId || activitySelectedIds.length >= 5}><Plus /> Add</Button>
                </div>
                <div className="chips" aria-label="Selected activity regions">
                  {activitySelectedRegions.map((region, index) => (
                    <button key={region.id} className={index === 0 ? "chip primary" : "chip"} onClick={() => selectActivityPrimary(region.id)}>
                      <i style={{ background: COLORS[index % COLORS.length] }} />
                      {region.name}{index === 0 ? " · focus" : ""}
                      {index > 0 && <X onClick={(event) => { event.stopPropagation(); setActivitySelectedIds((ids) => ids.filter((id) => id !== region.id)); }} />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="kpi-grid" aria-label="Current local market activity summary">
                <Kpi
                  label={activityMetricMetadata.label}
                  definition={activityMetricMetadata.definition}
                  value={formatValue(activityLast?.value ?? null, activityPrimarySeries?.unit ?? "number", "level")}
                  note={activityLast ? `Rolling window ending ${shortDate(activityPrimarySeries!.dates[activityLast.index])}` : "No observation"}
                />
                <Kpi
                  label="Change from one year earlier"
                  value={formatValue(activityYoy?.value ?? null, activityPrimarySeries?.unit ?? "number", "yoy", false, activityPrimarySeries?.changeMode)}
                  note="Versus the same rolling three-month window"
                />
                <Kpi
                  label="Five-year change"
                  value={formatValue(activityFiveYear, activityPrimarySeries?.unit ?? "number", "yoy", false, activityPrimarySeries?.changeMode)}
                  note="Pre- and post-pandemic market context"
                />
                <Kpi
                  label={`${county === "Both" ? "Two-county" : county.replace(" County", "")} rank`}
                  value={activityRank ? `${activityRank} of ${activityRanked.length}` : "—"}
                  note={activityRankBy === "growth" ? "Ranked by change from one year earlier" : `Ranked by current ${activityMetricMetadata.label.toLowerCase()}`}
                />
              </section>

              <section className="analysis-grid">
                <Card className="chart-card">
                  <CardHeader className="chart-header">
                    <div><p className="section-kicker">Local activity</p><CardTitle><MetricHeading metric={activityMetricMetadata} fallback={activityMetricMetadata.label} /></CardTitle></div>
                    <div className="chart-options">
                      <TimeRangeControl value={activityTimeRange} onChange={setActivityTimeRange} />
                      <p>{activityView === "level" ? "Rolling three-month level" : "Change from the same window one year earlier"}</p>
                    </div>
                  </CardHeader>
                  <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
                    <SeriesChart dataset={activityDataset} regions={activitySelectedRegions} metric={activityMetric} view={activityView} timeRange={activityTimeRange} indexBaseMonth="" />
                    <p className="data-note">Redfin may revise recent observations. Thin local markets can be volatile even after three-month smoothing.</p>
                  </CardContent>
                </Card>

                <Card className="ranking-card">
                  <CardHeader>
                    <div className="ranking-title">
                      <div><p className="section-kicker">Place</p><CardTitle>Market activity ranking</CardTitle></div>
                      <LabelledSelect label="Sort by" value={activityRankBy} onChange={(next) => setActivityRankBy(next as RankKey)}>
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
                      <button key={item.region.id} onClick={() => selectActivityPrimary(item.region.id)} className={item.region.id === activityPrimary?.id ? "rank-row active" : "rank-row"}>
                        <span className="rank-number">{index + 1}</span>
                        <span className="rank-name">{item.region.name}<small>{item.region.context}</small></span>
                        <strong>{formatValue(item.level, item.unit, "level")}</strong>
                        <span className={(item.yoy ?? 0) < 0 ? "negative" : "positive"}>{formatValue(item.yoy, item.unit, "yoy", false, item.changeMode)}</span>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              </section>

              <section className="maps-grid">
                <CountyMap county={county} mapData={maps[geography]} dataset={activityDataset} metric={activityMetric} metricLabel={activityMetricMetadata.label} view={activityView} indexBaseMonth="" selectedId={activityPrimary?.id ?? ""} onSelect={selectActivityPrimary} paletteKey={mapPalette} onPaletteChange={setMapPalette} provider="Redfin" />
              </section>
            </>
          )}
        </TabsContent>

        <TabsContent value="regional" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Context</p><h2>How does Los Angeles fit into the housing cycle?</h2></div>
            <p>Compare a consistent set of Western and high-growth metros. These metro-level measures add market liquidity and competition signals that are not consistently available for every city or ZIP.</p>
          </section>
          <section className="control-deck">
            <div className="source-strip"><SourceBadge provider="Zillow" frequency="Monthly" /><span>Metro comparison</span></div>
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
            <TimeRangeControl value={regionalTimeRange} onChange={setRegionalTimeRange} />
            <div className="metro-checks">
              {datasets.metro.regions.map((region) => {
                const checked = regionalIds.includes(region.id);
                return <button key={region.id} className={checked ? "metro-toggle active" : "metro-toggle"} onClick={() => setRegionalIds((ids) => checked ? ids.filter((id) => id !== region.id) : ids.length < 5 ? [...ids, region.id] : ids)}><i />{region.name}</button>;
              })}
            </div>
          </section>
          <Card className="chart-card regional-chart">
            <CardHeader className="chart-header"><div><p className="section-kicker">Metro comparison</p><CardTitle><MetricHeading metric={regionalMetricMetadata} fallback={REGIONAL_METRICS.find((item) => item.key === regionalMetric)?.label ?? regionalMetric} /></CardTitle></div><p>{regionalView === "index" ? `${shortDate(`${regionalIndexBaseMonth}-01`)} = 100` : "Choose up to five metros"}</p></CardHeader>
            <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0"><SeriesChart dataset={datasets.metro} regions={regionalRegions} metric={regionalMetric} view={regionalView} timeRange={regionalTimeRange} indexBaseMonth={regionalIndexBaseMonth} /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="methods" className="space-y-5">
          <section className="regional-intro">
            <div><p className="section-kicker">Reproducibility</p><h2>A small, inspectable data product.</h2></div>
            <p>The project favors a curated teaching dataset over a mirror of every provider variable. Each release can be cited, reproduced, and retained if a future download fails.</p>
          </section>
          <section className="method-grid">
            <Card><CardHeader><CardTitle>Zillow measures</CardTitle></CardHeader><CardContent className="method-copy"><p><strong>ZHVI</strong> estimates the typical mid-tier home value. <strong>ZORI</strong> tracks typical observed asking rent. The price–rent multiple is ZHVI divided by twelve months of ZORI.</p><p>Monthly year-over-year change compares each observation with the same month one year earlier. In indexed views, the user-selected starting month equals 100.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Redfin activity measures</CardTitle></CardHeader><CardContent className="method-copy"><p>Redfin supplies months of supply, median days on market, the share sold above original list, the share of active listings with price reductions, and median sale price per square foot.</p><p>City and ZIP observations are rolling three-month windows. Share changes are shown in percentage points; days and months use absolute differences; price per square foot uses percent change.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Geographies</CardTitle></CardHeader><CardContent className="method-copy"><p>City/community maps retain every Census incorporated place and Census-designated place (CDP) assigned to Orange or Los Angeles County, whether or not a provider reports data. Zillow and Redfin observations are matched independently, and an unincorporated CDP is never reassigned to a neighboring city.</p><p>ZIP map boundaries are Census ZCTAs: useful approximations, but not identical to USPS delivery ZIPs. Census places and ZCTAs do not necessarily cover or classify land in the same way.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Reading the maps</CardTitle></CardHeader><CardContent className="method-copy"><p>The legend distinguishes three states: <strong>colored</strong> means the selected provider reports a current observation; <strong>gray</strong> means an official city/CDP or mapped ZCTA boundary exists but the selected observation is unavailable; <strong>unshaded</strong> means the land falls outside the displayed place geography.</p><p>Unshaded county remainder, wilderness, and open space should not be interpreted as a missing housing market. For example, unshaded portions of Laguna Coast Wilderness Park are not a separate Census place. OpenStreetMap supplies the underlying geographic context.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Release design</CardTitle></CardHeader><CardContent className="method-copy"><p>Zillow and Redfin are refreshed into independent versioned releases. Each pipeline checks schemas, dates, coverage, and size before advancing its own <code>latest.json</code> pointer.</p><p>If either provider update fails, its prior validated release remains available and does not block the other source.</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Cost &amp; portability</CardTitle></CardHeader><CardContent className="method-copy"><p>The site is a static export with no database, application server, paid API, or paid map service. GitHub Actions performs periodic updates and GitHub Pages serves the files.</p><p>OpenStreetMap tiles are requested only for the map a visitor is viewing. A 50 MB processed-data guardrail catches accidental growth before release.</p></CardContent></Card>
          </section>
          <Card className="disclaimer-card">
            <CardHeader><CardTitle>Academic-use disclaimer</CardTitle></CardHeader>
            <CardContent className="method-copy">
              <p>This project is provided for instruction and academic research. It is not financial, investment, legal, valuation, or real-estate advice, and should not be relied on for transactions or commercial decision-making.</p>
              <p>Third-party data remain subject to their providers’ licenses and terms. This project does not grant commercial-use rights to Zillow, Redfin, Census, or OpenStreetMap data.</p>
            </CardContent>
          </Card>
          <Card className="provenance-card">
            <CardHeader><CardTitle>Current release provenance</CardTitle></CardHeader>
            <CardContent>
              <dl className="provenance-grid"><div><dt>Zillow release</dt><dd>{manifest.release}</dd></div><div><dt>Redfin release</dt><dd>{redfinManifest?.release ?? "Unavailable"}</dd></div><div><dt>Coverage</dt><dd>{manifest.counts.city} city/community · {manifest.counts.zip} ZIP · {manifest.counts.metro} metro</dd></div><div><dt>Bundle fingerprints</dt><dd><code>{manifest.bundle_sha256.slice(0, 10)}…{redfinManifest ? ` · ${redfinManifest.bundle_sha256.slice(0, 10)}…` : ""}</code></dd></div></dl>
              <p className="attribution">{manifest.attribution}. {redfinManifest?.attribution} Map data © OpenStreetMap contributors. This independent academic visualization is not endorsed by Zillow Group, Redfin, or OpenStreetMap.</p>
              <div className="source-links">
                <a className="source-link" href={manifest.data_page} target="_blank" rel="noreferrer">View Zillow Research source data <ExternalLink /></a>
                <a className="source-link" href={redfinManifest?.data_page ?? "https://www.redfin.com/news/data-center/downloads/"} target="_blank" rel="noreferrer">View Redfin Data Center <ExternalLink /></a>
                <a className="source-link" href={redfinManifest?.methodology_page ?? "https://www.redfin.com/news/data-center/methodology/"} target="_blank" rel="noreferrer">View Redfin methodology <ExternalLink /></a>
                <a className="source-link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">View OpenStreetMap attribution <ExternalLink /></a>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <footer>
        <p>Created by Desen Lin, California State University, Fullerton.</p>
        <p>For instruction and academic research · Not financial advice · Third-party data terms apply</p>
      </footer>
    </main>
    </TooltipProvider>
  );
}
