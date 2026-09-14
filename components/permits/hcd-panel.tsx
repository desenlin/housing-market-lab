"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

export function HcdPanel() {
  const [data, setData] = useState<Dataset | null>(null);
  const [manifest, setManifest] = useState<HcdManifest | null>(null);
  const [error, setError] = useState(false);
  const [county, setCounty] = useState("Orange County");
  const [selected, setSelected] = useState("Fullerton");
  const [comparison, setComparison] = useState("");
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [average, setAverage] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/hcd`;
    const get = async (path: string) => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error("HCD release unavailable");
      return response.json();
    };
    void (async () => {
      const pointer = await get(`${base}/latest.json`);
      const folder = `${base}/releases/${pointer.release}`;
      const [dataset, metadata] = await Promise.all([get(`${folder}/annual.json`), get(`${folder}/manifest.json`)]);
      setData(dataset); setManifest(metadata);
    })().catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const regions = useMemo(() => data?.regions.filter(r => r.county === county).sort((a, b) => a.name.localeCompare(b.name)) ?? [], [data, county]);
  const region = regions.find(r => r.name === selected) ?? regions[0];
  const second = data?.regions.find(r => r.id === comparison && r.id !== region?.id);
  const chosen = region ? [region, ...(second ? [second] : [])] : [];
  const year = selectedYear ?? data?.years.at(-1);
  const index = data?.years.indexOf(year ?? 0) ?? -1;
  const cell = region?.annual[index];
  const chart = data && region ? data.years.map((year, i) => {
    const row: Record<string, number | null> = { year };
    chosen.forEach((r, n) => {
      for (const stage of ["permits", "completions"] as const) {
        const window = r.annual.slice(Math.max(0, i - 2), i + 1).map(c => c?.[stage].total);
        row[`${stage}${n}`] = average
          ? window.length === 3 && window.every(v => v != null) ? window.reduce<number>((s, v) => s + (v ?? 0), 0) / 3 : null
          : r.annual[i]?.[stage].total ?? null;
      }
    });
    return row;
  }) : [];
  if (error) return <p role="alert">HCD housing delivery data are temporarily unavailable. Census permit activity remains available in its own view.</p>;
  if (!data || !manifest || !region) return <p role="status">Loading annual housing delivery…</p>;
  const total = cell?.completions.total;
  const adu = total != null ? cell?.completions.types.ADU : null;
  const composition = Object.entries(data.types).map(([key, name]) => {
    const row: Record<string, string | number | null> = { name };
    chosen.forEach((r, n) => { const stage = r.annual[index]?.completions; row[`units${n}`] = stage?.total == null ? null : stage.types[key] ?? 0; });
    return row;
  });
  const incomeGroups = [
    { label: "Very low and below", dr: [0, 2, 4], ndr: [1, 3, 5] },
    { label: "Low income", dr: [6], ndr: [7] },
    { label: "Moderate income", dr: [8], ndr: [9] },
  ];
  return <div className="space-y-5">
    <section className="control-deck" aria-label="Housing delivery controls">
      <div className="source-strip">
        <span className="source-badge census">Source: California HCD APR · Annual</span>
        <span>Data through {manifest.latest_year}</span>
      </div>
      <div className="control-grid hcd-controls">
        <label className="control-label"><span>County</span><NativeSelect aria-label="HCD county" value={county} onChange={e => { setCounty(e.target.value); setSelected(""); }}>
          {["Orange County", "Los Angeles County"].map(c => <NativeSelectOption key={c}>{c}</NativeSelectOption>)}
        </NativeSelect></label>
        <label className="control-label"><span>Jurisdiction</span><NativeSelect aria-label="HCD jurisdiction" value={region.name} onChange={e => setSelected(e.target.value)}>
          {regions.map(r => <NativeSelectOption key={r.id} value={r.name}>{r.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label className="control-label"><span>Reporting year</span><NativeSelect aria-label="HCD reporting year" value={year} onChange={e => setSelectedYear(Number(e.target.value))}>
          {[...data.years].reverse().map(y => <NativeSelectOption key={y} value={y}>{y}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      <div className="comparison-row">
        <label className="control-label comparison-select"><span>Compare with (optional)</span><NativeSelect aria-label="HCD comparison jurisdiction" value={second?.id ?? ""} onChange={e => setComparison(e.target.value)}>
          <NativeSelectOption value="">None — show one jurisdiction</NativeSelectOption>
          {["Orange County", "Los Angeles County"].map(c => <optgroup key={c} label={c}>{data.regions.filter(r => r.county === c && r.id !== region.id).sort((a,b) => a.name.localeCompare(b.name)).map(r => <NativeSelectOption key={r.id} value={r.id}>{r.name}</NativeSelectOption>)}</optgroup>)}
        </NativeSelect></label>
      </div>
    </section>
    <div className="grid gap-4 sm:grid-cols-3">
      {[ ["Units completed", number(total)], ["Completions per 1,000 existing units", number(total == null || !region.housing_stock ? null : total / region.housing_stock * 1000, 1)], ["ADU share of completions", total && adu != null ? `${number(adu / total * 100, 1)}%` : "Unavailable"] ].map(([label, value]) =>
        <Card key={label}><CardHeader><CardTitle className="text-base">{label}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{value}</p><p className="text-sm text-muted-foreground">{region.name} · {year}</p></CardContent></Card>)}
    </div>
    <p className="text-sm text-muted-foreground">The rate uses the fixed {region.housing_stock_vintage} ACS five-year housing stock ({number(region.housing_stock)} units). It measures production intensity, not annual stock growth.</p>
    {!cell && <p role="status">No Table A2 records were found for this jurisdiction and year. This does not establish zero construction or a missing APR submission.</p>}
    {second && <p className="text-sm text-muted-foreground">Summary cards describe {region.name}. Both figures compare {region.name} with {second.name} using the same reporting years. Counts are not adjusted for city size.</p>}
    {chosen.filter(r => !r.annual[index] || r.annual[index]?.completions.total == null).map(r => <p key={r.id} role="status">{r.name}: completed units are unavailable for {year}; missing values are not zero.</p>)}
    <div className="grid items-start gap-4 lg:grid-cols-2">
    <Card className="min-w-0"><CardHeader><CardTitle>Housing authorizations and delivery</CardTitle></CardHeader><CardContent>
      <label className="flex items-center gap-2 mb-4"><input type="checkbox" checked={average} onChange={e => setAverage(e.target.checked)} /> Show three-year annual averages</label>
      <div className="h-80" role="img" aria-label={`HCD permits and completions over time for ${region.name}`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="year" stroke="var(--muted-foreground)" /><YAxis stroke="var(--muted-foreground)" width={65} />
          <Tooltip contentStyle={tooltipStyle} /><Legend verticalAlign="top" height={second ? 76 : 48} wrapperStyle={{ fontSize: 12 }} />
          {chosen.flatMap((r, n) => [
            <Line key={`p${n}`} dataKey={`permits${n}`} name={`${r.name} · permits`} stroke={colors[n]} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />,
            <Line key={`c${n}`} dataKey={`completions${n}`} name={`${r.name} · completions`} stroke={colors[n]} strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} />,
          ])}
        </LineChart></ResponsiveContainer>
      </div>
      <p className="text-sm">Dashed: permitted units. Solid: completed units. These annual flows represent different project cohorts. Their ratio is not a completion rate, and their difference is not a measured backlog. Three-year averages require three consecutive available years.</p>
      <details className="mt-3"><summary>View annual values</summary><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Year</th>{chosen.map(r => <th key={r.id} colSpan={2}>{r.name}</th>)}</tr><tr><th />{chosen.flatMap(r => [<th key={`${r.id}p`}>Permitted</th>, <th key={`${r.id}c`}>Completed</th>])}</tr></thead><tbody>{chart.map(row => <tr key={row.year} className="border-t"><td className="p-2">{row.year}</td>{chosen.flatMap((r,n) => [<td key={`${r.id}p`} className="p-2 text-right">{number(row[`permits${n}`], average ? 1 : 0)}</td>, <td key={`${r.id}c`} className="p-2 text-right">{number(row[`completions${n}`], average ? 1 : 0)}</td>])}</tr>)}</tbody></table></div></details>
    </CardContent></Card>
    <Card className="min-w-0"><CardHeader><CardTitle>What types of housing are being delivered?</CardTitle></CardHeader><CardContent>
      <>
        <p className="mb-3">Completed units · {year}</p>
        <div className="h-80" role="img" aria-label="Completed housing units by structure type"><ResponsiveContainer width="100%" height="100%"><BarChart data={composition} layout="vertical" margin={{ right: 25 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis type="number" stroke="var(--muted-foreground)" minTickGap={25} tickFormatter={v => Intl.NumberFormat("en-US", { notation: "compact" }).format(v)} /><YAxis type="category" dataKey="name" width={145} stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} /><Tooltip contentStyle={tooltipStyle} /><Legend verticalAlign="top" height={48} wrapperStyle={{ fontSize: 12 }} />{chosen.map((r,n) => <Bar key={r.id} dataKey={`units${n}`} name={r.name} fill={colors[n]} isAnimationActive={false} />)}
        </BarChart></ResponsiveContainer></div>
        <p className="text-sm">ADUs have their own category and are not added again to other structure types. Unknown source classifications remain in Other / unspecified.</p>
      </>
      <details className="mt-4"><summary>Reported affordability of completed housing</summary>
        <p className="my-3 text-sm">These categories describe reported affordability, not residents’ measured rent burden. Non-deed-restricted units are not necessarily subsidized or permanently affordable. Very low and below combines the newer acutely and extremely low categories for comparison across reporting years.</p>
        {chosen.map(r => { const income = r.annual[index]?.completions.income; return <div key={r.id} className="mt-3"><h3>{r.name}</h3>{income ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Income category</th><th className="text-right p-2">Deed restricted</th><th className="text-right p-2">Not deed restricted</th></tr></thead><tbody>{incomeGroups.map(g => <tr key={g.label} className="border-t"><td className="p-2">{g.label}</td><td className="text-right p-2">{number(g.dr.reduce((s, i) => s + income[i], 0))}</td><td className="text-right p-2">{number(g.ndr.reduce((s, i) => s + income[i], 0))}</td></tr>)}<tr className="border-t"><td className="p-2">Above moderate</td><td colSpan={2} className="text-right p-2">{number(income[10])} total</td></tr></tbody></table></div> : <p>Affordability detail is unavailable or does not reconcile with reported completion totals.</p>}</div>; })}
      </details>
    </CardContent></Card>
    </div>
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
    <p>Annual permits and completions represent different project cohorts, so their ratio is not a completion rate. No-row years remain unavailable. Three-year averages require three consecutive available years. Production intensity uses fixed ACS five-year housing-stock denominators.</p>
    <p>Historical activity dated outside the reporting year is excluded; undated activity is retained. Inconsistent totals or affordability components are withheld. Repeated projects across reporting years are not automatically treated as duplicates. Observed zeroes do not certify reporting completeness, and recent years may be revised.</p>
    <p>ADUs are counted once in a separate structure category. Reported affordability is not household rent burden; non-deed-restricted units need not be subsidized or permanently affordable.</p>
    <p><a className="source-link" href="https://data.ca.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year" target="_blank" rel="noreferrer">HCD data and dictionaries</a> · <a className="source-link" href="https://www.hcd.ca.gov/apr/forms" target="_blank" rel="noreferrer">Reporting instructions</a></p>
  </MethodCard>;
}
