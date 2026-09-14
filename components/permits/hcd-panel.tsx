"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DefinitionHelp } from "@/components/definition-help";
import { FigureAttribution } from "@/components/figure-attribution";
import { PermitMap, type MapData } from "@/components/permits/permit-panel";
import { MethodCard } from "@/components/method-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";


type Stage = { total: number | null; types: Record<string, number>; income: number[] | null; quality: Record<string, number> };
type Cell = { records: number; permits: Stage; completions: Stage };
type Region = { id: string; name: string; county: string; jurisdiction_type: string; housing_stock: number; housing_stock_vintage: number; annual: (Cell | null)[] };
type Dataset = { years: number[]; types: Record<string, string>; income_fields: string[]; regions: Region[] };
export type HcdManifest = { release: string; created_at: string; latest_year: number; bundle_sha256: string; data_page: string; source: { last_modified: string } };
const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--muted-foreground)", "var(--foreground)"];
const number = (value: number | null | undefined, decimals = 0) => value == null ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: decimals });
const tooltipStyle = { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8 };

const HCD_METRICS = {
  completions: { label: "Completed units", short_label: "Completed units", unit: "units" as const, decimals: 0, definition: "HCD-reported units reaching readiness for occupancy in the reporting year. This does not measure actual occupancy or net stock growth." },
  permits: { label: "HCD permitted units", short_label: "HCD permitted units", unit: "units" as const, decimals: 0, definition: "Units receiving building permits during the reporting year under HCD APR definitions. These are not the separate Census BPS observations." },
  units_per_1000_stock: { label: "Completions per 1,000 existing units", short_label: "Completions per 1,000", unit: "rate" as const, decimals: 1, definition: "Annual completed units divided by the fixed ACS five-year housing stock, multiplied by 1,000. A measure of production intensity, not stock growth." },
  adu: { label: "ADU completions", short_label: "ADU completions", unit: "units" as const, decimals: 0, definition: "Completed accessory dwelling units, counted once in their own structure category." },
  adu_share: { label: "ADU share of completions", short_label: "ADU share", unit: "share" as const, decimals: 1, definition: "Completed accessory dwelling units divided by all completed units. Unavailable when total completions are zero or missing." },
};
type MetricKey = keyof typeof HCD_METRICS;
function metricValue(r: Region, index: number, metric: MetricKey): number | null {
  const c = r.annual[index];
  if (metric === "permits") return c?.permits.total ?? null;
  const total = c?.completions.total;
  if (total == null) return null;
  if (metric === "completions") return total;
  if (metric === "units_per_1000_stock") return r.housing_stock > 0 ? total / r.housing_stock * 1000 : null;
  if (metric === "adu") return c?.completions.types.ADU ?? 0;
  return total > 0 ? (c?.completions.types.ADU ?? 0) / total : null;
}
function formatMetric(value: number | null, metric: MetricKey) {
  return value == null ? "Unavailable" : HCD_METRICS[metric].unit === "share" ? `${number(value * 100, 1)}%` : number(value, HCD_METRICS[metric].decimals);
}

function growthValue(r: Region, index: number, metric: MetricKey): number | null {
  if (index < 1) return null;
  const current = metricValue(r,index,metric), prior = metricValue(r,index-1,metric);
  if (current == null || prior == null) return null;
  if (metric === "adu_share") return (current-prior)*100;
  if (metric === "units_per_1000_stock") return current-prior;
  return prior === 0 ? null : (current/prior-1)*100;
}
function formatGrowth(value: number | null, metric: MetricKey) {
  return value == null ? "Unavailable" : `${number(value,1)}${metric === "adu_share" ? " pp" : metric === "units_per_1000_stock" ? "" : "%"}`;
}

export function HcdPanel({ mapData, lensControl }: { mapData: MapData; lensControl: React.ReactNode }) {
  const [data, setData] = useState<Dataset | null>(null);
  const [manifest, setManifest] = useState<HcdManifest | null>(null);
  const [error, setError] = useState(false);
  const [county, setCounty] = useState("Orange County");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addId, setAddId] = useState("");
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [figureView, setFigureView] = useState<"trend" | "type">("trend");
  const [rankBy, setRankBy] = useState<"level" | "growth">("level");
  const [metric, setMetric] = useState<MetricKey>("completions");
  useEffect(() => {
    const controller = new AbortController();
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/hcd`;
    const get = async (path: string) => { const response = await fetch(path, { signal: controller.signal }); if (!response.ok) throw new Error("HCD release unavailable"); return response.json(); };
    void (async () => {
      const pointer = await get(`${base}/latest.json`);
      const folder = `${base}/releases/${pointer.release}`;
      const [dataset, metadata]: [Dataset, HcdManifest] = await Promise.all([get(`${folder}/annual.json`), get(`${folder}/manifest.json`)]);
      setData(dataset); setManifest(metadata);
      const initial = dataset.regions.find(r => r.name === "Fullerton");
      setSelectedIds(initial ? [initial.id] : []);
    })().catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const regions = useMemo(() => data?.regions.filter(r => county === "Both" || r.county === county).sort((a,b) => a.name.localeCompare(b.name)) ?? [], [data, county]);
  const chosen = selectedIds.flatMap(id => { const r = regions.find(r => r.id === id); return r ? [r] : []; });
  const primary = chosen[0];
  const year = selectedYear ?? data?.years.at(-1) ?? 0;
  const index = data?.years.indexOf(year) ?? -1;
  function toggleCity(id: string) { setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : current.length < 5 ? [...current, id] : current); }
  function focusCity(id: string) { setSelectedIds(current => [id, ...current.filter(item => item !== id)].slice(0,5)); }
  if (error) return <div className="space-y-4">{lensControl}<p role="alert">HCD housing delivery is temporarily unavailable. Census permit activity remains available.</p></div>;
  if (!data || !manifest) return <div className="space-y-4">{lensControl}<p role="status">Loading annual housing delivery…</p></div>;
  const info = HCD_METRICS[metric];
  const rankValue = (r: Region) => rankBy === "growth" ? growthValue(r,index,metric) : metricValue(r,index,metric);
  const ranked = regions.filter(r => r.jurisdiction_type === "incorporated_city" && metricValue(r,index,metric) != null).sort((a,b) => {
    const av = rankValue(a), bv = rankValue(b);
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv-av || a.name.localeCompare(b.name);
  });
  const rank = primary && rankValue(primary) != null ? ranked.findIndex(r => r.id === primary.id) + 1 : 0;
  const levels = ranked.map(r => metricValue(r,index,metric)!).sort((a,b) => a-b);
  const midpoint = Math.floor(levels.length / 2);
  const median = !levels.length ? null : levels.length % 2 ? levels[midpoint] : (levels[midpoint-1]+levels[midpoint])/2;
  const value = primary ? metricValue(primary,index,metric) : null;
  const change = formatGrowth(primary ? growthValue(primary,index,metric) : null,metric);
  const chart = data.years.map((year,i) => Object.fromEntries([["year",year], ...chosen.map(r => [r.id,metricValue(r,i,metric)])]));
  const mapDataset = { dates: data.years.map(String), metrics: HCD_METRICS, regions: data.regions.map(r => ({ id:r.id, name:r.name, county:r.county, series: Object.fromEntries(Object.keys(HCD_METRICS).map(key => [key,r.annual.map((_,i) => metricValue(r,i,key as MetricKey))])) })) };
  const composition = Object.entries(data.types).map(([key,name]) => Object.fromEntries([["name",name], ...chosen.map(r => [r.id,r.annual[index]?.completions.total == null ? null : r.annual[index]?.completions.types[key] ?? 0])]));
  const sources = metric === "units_per_1000_stock" ? ["hcd", "census-acs"] as const : ["hcd"] as const;
  const figureControl = <label className="control-label hcd-figure-control"><span>Figure</span><NativeSelect aria-label="Housing delivery figure" value={figureView} onChange={e => setFigureView(e.target.value as "trend" | "type")}><NativeSelectOption value="trend">{info.label}</NativeSelectOption><NativeSelectOption value="type">Housing type</NativeSelectOption></NativeSelect></label>;
  const cityLegend = <ul className="hcd-city-legend" aria-label="Figure city legend">{chosen.map((r,n) => <li key={r.id}><i style={{background:colors[n]}} aria-hidden="true"/>{r.name}</li>)}</ul>;
  return <div className="permit-stack">
    <section className="control-deck" aria-label="Housing delivery controls">
      <div className="source-strip"><span className="source-badge census">Source: California HCD APR · Annual</span><span>Data through {manifest.latest_year}</span></div>
      <div className="control-grid hcd-controls">
        {lensControl}
        <label className="control-label"><span>County</span><NativeSelect aria-label="HCD county" value={county} onChange={e => { const next=e.target.value; setCounty(next); setAddId(""); setSelectedIds(current => current.filter(id => data.regions.some(r => r.id === id && (next === "Both" || r.county === next)))); }}>{["Orange County","Los Angeles County","Both"].map(c => <NativeSelectOption key={c}>{c}</NativeSelectOption>)}</NativeSelect></label>
        <label className="control-label"><span>Metric<DefinitionHelp label="Housing delivery metric" definition={info.definition} /></span><NativeSelect aria-label="HCD metric" value={metric} onChange={e => setMetric(e.target.value as MetricKey)}>{Object.entries(HCD_METRICS).map(([key,m]) => <NativeSelectOption key={key} value={key}>{m.label}</NativeSelectOption>)}</NativeSelect></label>
        <label className="control-label"><span>Map &amp; ranking year</span><NativeSelect aria-label="HCD reporting year" value={year} onChange={e => setSelectedYear(Number(e.target.value))}>{[...data.years].reverse().map(y => <NativeSelectOption key={y} value={y}>{y}</NativeSelectOption>)}</NativeSelect></label>
      </div>
      <div className="comparison-row"><label className="control-label comparison-select"><span>Add a comparison (up to five)</span><NativeSelect aria-label="HCD comparison jurisdiction" value={addId} onChange={e => setAddId(e.target.value)}><NativeSelectOption value="">Choose a housing jurisdiction…</NativeSelectOption>{regions.filter(r => !selectedIds.includes(r.id)).map(r => <NativeSelectOption key={r.id} value={r.id}>{r.name}</NativeSelectOption>)}</NativeSelect></label><button className="permit-add" type="button" disabled={!addId || chosen.length >= 5} onClick={() => { toggleCity(addId); setAddId(""); }}>Add</button></div>
      <div className="chips">{chosen.map((r,n) => <span className={n === 0 ? "chip primary" : "chip"} key={r.id}><button type="button" onClick={() => focusCity(r.id)} aria-label={`Focus ${r.name}`}><i style={{background:colors[n]}} />{r.name}</button><button type="button" onClick={() => toggleCity(r.id)} aria-label={`Remove ${r.name}`}>×</button></span>)}</div>
    </section>
    <section className="kpi-grid permit-kpis" aria-label="Housing delivery summary">
      {[[primary?.name ?? "Select a jurisdiction",formatMetric(value,metric),`${info.short_label} · ${year}`], ["Change from one year earlier",change,metric === "adu_share" ? "Percentage-point change" : metric === "units_per_1000_stock" ? "Change in units per 1,000" : "Percent change; unavailable from a zero base"], [county === "Orange County" ? "Orange rank" : county === "Los Angeles County" ? "Los Angeles rank" : "LA & Orange rank",rank > 0 ? `#${rank}` : "—",`By ${rankBy === "growth" ? "annual change" : "level"} · ${ranked.filter(r => rankValue(r) != null).length} cities`], [county === "Orange County" ? "Orange median" : county === "Los Angeles County" ? "Los Angeles median" : "LA & Orange median",metric === "adu_share" ? formatMetric(median,metric) : number(median,1),`Unweighted median · ${levels.length} reporting cities`]].map(([label,value,note]) => <Card className="kpi-card" key={label}><CardContent className="p-4"><p className="kpi-label">{label}</p><p className="kpi-value">{value}</p><p className="kpi-note">{note}</p></CardContent></Card>)}
    </section>
    {!chosen.length && <p role="status">Choose a jurisdiction above or click a city in the ranking to begin.</p>}
    <section className="analysis-grid hcd-analysis-grid">
      {figureView === "trend" ? <Card className="chart-card hcd-trend"><CardHeader className="chart-header hcd-chart-header">{figureControl}<CardTitle>{info.label}<DefinitionHelp label={info.label} definition={info.definition} /></CardTitle><span className="metric-freshness">{data.years[0]}–{data.years.at(-1)}</span></CardHeader><CardContent>
        {cityLegend}
        <div className="h-80" aria-label={`${info.label} trend`}><ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{top:10,right:12,left:0,bottom:5}}><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4"/><XAxis dataKey="year" tick={{fill:"var(--chart-label)",fontSize:10}}/><YAxis width={65} tick={{fill:"var(--chart-label)",fontSize:10}} tickFormatter={v => formatMetric(Number(v),metric)}/><Tooltip contentStyle={tooltipStyle} formatter={v => formatMetric(Number(v),metric)}/>{chosen.map((r,n) => <Line key={r.id} dataKey={r.id} name={r.name} stroke={colors[n]} strokeWidth={n === 0 ? 2.8 : 1.8} dot={false} connectNulls={false} isAnimationActive={false}/>)}</LineChart></ResponsiveContainer></div>
        <FigureAttribution sources={[...sources]}/><p className="data-note">{info.definition} Missing observations remain gaps.</p>
        <details><summary>View annual values</summary><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Year</th>{chosen.map(r => <th key={r.id}>{r.name}</th>)}</tr></thead><tbody>{data.years.map((y,i) => <tr key={y}><td>{y}</td>{chosen.map(r => <td className="p-2 text-right" key={r.id}>{formatMetric(metricValue(r,i,metric),metric)}</td>)}</tr>)}</tbody></table></div></details>
      </CardContent></Card> :
      <Card className="chart-card hcd-composition"><CardHeader className="chart-header hcd-chart-header">{figureControl}<CardTitle>Housing type<DefinitionHelp label="Housing types" definition="Completed units by reported structure type. ADUs are counted once in a separate category; unknown types remain Other / unspecified."/></CardTitle><span className="metric-freshness">Completed units · {year}</span></CardHeader><CardContent>
        {cityLegend}
        <div className="h-80" aria-label="Completed units by housing type"><ResponsiveContainer width="100%" height="100%"><BarChart data={composition} layout="vertical" margin={{right:12}}><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4"/><XAxis type="number" tick={{fill:"var(--chart-label)",fontSize:10}} tickFormatter={v => Intl.NumberFormat("en-US",{notation:"compact"}).format(v)}/><YAxis type="category" dataKey="name" width={125} tick={{fill:"var(--chart-label)",fontSize:10}}/><Tooltip contentStyle={tooltipStyle}/>{chosen.map((r,n) => <Bar key={r.id} dataKey={r.id} name={r.name} fill={colors[n]} isAnimationActive={false}/>)}</BarChart></ResponsiveContainer></div>
        <FigureAttribution sources={["hcd"]}/><p className="data-note">Structure mix always shows completed units for the selected year, regardless of the trend metric. ADUs are not counted again in other types.</p>
        <details><summary>Reported affordability of completed housing</summary><p className="data-note">Reported affordability is not household rent burden. Non-deed-restricted units need not be subsidized or permanently affordable.</p>{chosen.map(r => { const income=r.annual[index]?.completions.income; return <div key={r.id}><h3>{r.name}</h3>{income ? <table className="w-full text-sm"><thead><tr><th>Income category</th><th>Deed restricted</th><th>Not deed restricted</th></tr></thead><tbody>{[{label:"Very low and below",dr:[0,2,4],ndr:[1,3,5]},{label:"Low income",dr:[6],ndr:[7]},{label:"Moderate income",dr:[8],ndr:[9]}].map(g => <tr key={g.label}><td>{g.label}</td><td>{number(g.dr.reduce((sum,i)=>sum+income[i],0))}</td><td>{number(g.ndr.reduce((sum,i)=>sum+income[i],0))}</td></tr>)}<tr><td>Above moderate</td><td colSpan={2}>{number(income[10])} total</td></tr></tbody></table> : <p>Affordability detail unavailable.</p>}</div>;})}</details>
      </CardContent></Card>}
      <Card className="ranking-card hcd-ranking"><CardHeader>
        <div className="ranking-title"><div><p className="section-kicker">Place</p><CardTitle>City ranking</CardTitle></div><label className="control-label"><span>Sort by</span><NativeSelect aria-label="HCD ranking sort" value={rankBy} onChange={e => setRankBy(e.target.value as "level" | "growth")}><NativeSelectOption value="level">Current level</NativeSelectOption><NativeSelectOption value="growth">Change from one year earlier</NativeSelectOption></NativeSelect></label></div>
        <p className="permit-chart-window">{year} · Click to add or remove · up to five cities</p>
        <div className="rank-columns" aria-hidden="true"><span>#</span><span>City</span><span>{info.short_label}</span><span>Change from<br/>one year earlier</span></div>
      </CardHeader><CardContent className="ranking-list">
        {ranked.map((r,n) => { const growth = growthValue(r,index,metric); return <button type="button" aria-pressed={selectedIds.includes(r.id)} disabled={!selectedIds.includes(r.id) && chosen.length >= 5} className={`rank-row${r.id === primary?.id ? " active" : selectedIds.includes(r.id) ? " selected" : ""}`} key={r.id} onClick={() => toggleCity(r.id)}><span className="rank-number">{rankValue(r) == null ? "—" : n+1}</span><span className="rank-name">{r.name}<small>{r.county}</small></span><strong>{formatMetric(metricValue(r,index,metric),metric)}</strong><span className={growth == null ? "" : growth < 0 ? "negative" : "positive"}>{formatGrowth(growth,metric)}</span></button>; })}
      </CardContent><p className="hcd-rank-note">{metric === "adu_share" ? "Change is in percentage points." : metric === "units_per_1000_stock" ? "Change is in completed units per 1,000 existing units." : "Growth is percent change from the prior year; a zero prior-year value makes growth unavailable."} Missing changes sort last.</p></Card>

    </section>
    <PermitMap mapData={mapData} dataset={mapDataset} county={county} metric={metric} dateIndex={index} selectedId={primary?.id ?? ""} source="hcd" title="Map · Housing jurisdictions" onSelect={focusCity}/>
  </div>;
}

export function useHcdManifest() {
  const [manifest, setManifest] = useState<HcdManifest | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/hcd`;
    const get = async (url: string) => { const response = await fetch(url, { signal: controller.signal }); if (!response.ok) throw new Error("Unavailable"); return response.json(); };
    void (async () => { const pointer = await get(`${base}/latest.json`); setManifest(await get(`${base}/releases/${pointer.release}/manifest.json`)); })().catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return { manifest, error };
}

export function HcdMethods() {
  return <MethodCard title="HCD housing delivery">
    <p>California HCD Housing Element Annual Progress Reports, Table A2, provide annual permitted and completed units, housing types, ADUs and reported affordability for Los Angeles and Orange County jurisdictions. County jurisdictions cover unincorporated areas only; CDPs have no separate APR totals.</p>
    <p>Census BPS measures privately owned new residential construction authorizations. HCD also covers categories such as conversions and manufactured housing. The two permit series remain separate. Completions indicate readiness for occupancy, not actual occupancy or net housing-stock growth.</p>
    <p>Annual permits and completions represent different project cohorts, so their ratio is not a completion rate. No-row years remain unavailable. The trend, ranking, and map share the selected metric; the structure mix always shows completed units. Production intensity uses fixed ACS five-year housing-stock denominators.</p>
    <p>Historical activity dated outside the reporting year is excluded; undated activity is retained. Inconsistent totals or affordability components are withheld. Repeated projects across reporting years are not automatically treated as duplicates. Observed zeroes do not certify reporting completeness, and recent years may be revised.</p>
    <p>ADUs are counted once in a separate structure category. Reported affordability is not household rent burden; non-deed-restricted units need not be subsidized or permanently affordable.</p>
    <p><a className="source-link" href="https://data.ca.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year" target="_blank" rel="noreferrer">HCD data and dictionaries</a> · <a className="source-link" href="https://www.hcd.ca.gov/apr/forms" target="_blank" rel="noreferrer">Reporting instructions</a></p>
  </MethodCard>;
}
