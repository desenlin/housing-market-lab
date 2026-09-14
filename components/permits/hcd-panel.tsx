"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { FigureAttribution } from "@/components/figure-attribution";

type Stage = { total: number | null; types: Record<string, number>; income: number[] | null; quality: Record<string, number> };
type Cell = { records: number; permits: Stage; completions: Stage };
type Region = { id: string; name: string; county: string; jurisdiction_type: string; housing_stock: number; housing_stock_vintage: number; annual: (Cell | null)[] };
type Dataset = { years: number[]; types: Record<string, string>; income_fields: string[]; regions: Region[] };
type Manifest = { release: string; created_at: string; latest_year: number; bundle_sha256: string; data_page: string; source: { last_modified: string } };
const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--muted-foreground)", "var(--foreground)"];
const number = (value: number | null | undefined, decimals = 0) => value == null ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: decimals });
const tooltipStyle = { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8 };

export function HcdPanel() {
  const [data, setData] = useState<Dataset | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState(false);
  const [county, setCounty] = useState("Orange County");
  const [selected, setSelected] = useState("Fullerton");
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
  const year = selectedYear ?? data?.years.at(-1);
  const index = data?.years.indexOf(year ?? 0) ?? -1;
  const cell = region?.annual[index];
  const chart = useMemo(() => data && region ? data.years.map((year, i) => {
    const value = (key: "permits" | "completions") => {
      if (!average) return region.annual[i]?.[key].total ?? null;
      const window = region.annual.slice(Math.max(0, i - 2), i + 1).map(c => c?.[key].total);
      return window.length === 3 && window.every(v => v != null) ? window.reduce<number>((s, v) => s + (v ?? 0), 0) / 3 : null;
    };
    return { year, permits: value("permits"), completions: value("completions") };
  }) : [], [data, region, average]);
  if (error) return <p role="alert">HCD housing delivery data are temporarily unavailable. Census permit activity remains available in its own view.</p>;
  if (!data || !manifest || !region) return <p role="status">Loading annual housing delivery…</p>;
  const total = cell?.completions.total;
  const adu = total != null ? cell?.completions.types.ADU : null;
  const issues = cell ? Object.entries(cell.completions.quality).filter(([, count]) => count > 0) : [];
  const composition = total != null ? Object.entries(data.types).map(([key, name]) => ({ name, units: cell?.completions.types[key] ?? 0 })) : [];
  const income = cell?.completions.income;
  const incomeGroups = [
    { label: "Very low and below", dr: [0, 2, 4], ndr: [1, 3, 5] },
    { label: "Low income", dr: [6], ndr: [7] },
    { label: "Moderate income", dr: [8], ndr: [9] },
  ];
  return <div className="space-y-5">
    <section className="regional-intro">
      <h2>How much housing is reaching completion?</h2>
      <p>Annual housing delivery in Los Angeles and Orange Counties, reported to California HCD. Completions record readiness for occupancy; they do not measure actual occupancy or net growth in the housing stock.</p>
    </section>
    <Card><CardContent className="pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <label>County<NativeSelect aria-label="HCD county" value={county} onChange={e => { setCounty(e.target.value); setSelected(""); }}>
          {["Orange County", "Los Angeles County"].map(c => <NativeSelectOption key={c}>{c}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Jurisdiction<NativeSelect aria-label="HCD jurisdiction" value={region.name} onChange={e => setSelected(e.target.value)}>
          {regions.map(r => <NativeSelectOption key={r.id} value={r.name}>{r.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Reporting year<NativeSelect aria-label="HCD reporting year" value={year} onChange={e => setSelectedYear(Number(e.target.value))}>
          {[...data.years].reverse().map(y => <NativeSelectOption key={y} value={y}>{y}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">Annual observations through {manifest.latest_year}; source updated {manifest.source.last_modified?.slice(0, 10)}. County jurisdictions cover unincorporated areas, not the entire county. CDPs do not have separate APR totals here.</p>
    </CardContent></Card>
    <div className="grid gap-4 sm:grid-cols-3">
      {[ ["Units completed", number(total)], ["Completions per 1,000 existing units", number(total == null || !region.housing_stock ? null : total / region.housing_stock * 1000, 1)], ["ADU share of completions", total && adu != null ? `${number(adu / total * 100, 1)}%` : "Unavailable"] ].map(([label, value]) =>
        <Card key={label}><CardHeader><CardTitle className="text-base">{label}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{value}</p><p className="text-sm text-muted-foreground">{region.name} · {year}</p></CardContent></Card>)}
    </div>
    <p className="text-sm text-muted-foreground">The rate uses the fixed {region.housing_stock_vintage} ACS five-year housing stock ({number(region.housing_stock)} units). It measures production intensity, not annual stock growth.</p>
    {!cell && <p role="status">No Table A2 records were found for this jurisdiction and year. This does not establish zero construction or a missing APR submission.</p>}
    {issues.some(([key]) => key !== "outside_year") && <p className="text-sm">Some source records need interpretation: missing dates retain reported units, while inconsistent totals or affordability detail are withheld. See observation checks below.</p>}
    <Card><CardHeader><CardTitle>Housing authorizations and delivery</CardTitle></CardHeader><CardContent>
      <label className="flex items-center gap-2 mb-4"><input type="checkbox" checked={average} onChange={e => setAverage(e.target.checked)} /> Show three-year annual averages</label>
      <div className="h-80" role="img" aria-label={`HCD permits and completions over time for ${region.name}`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="year" stroke="var(--muted-foreground)" /><YAxis stroke="var(--muted-foreground)" width={65} />
          <Tooltip contentStyle={tooltipStyle} /><Legend verticalAlign="top" height={48} wrapperStyle={{ fontSize: 12 }} />
          <Line dataKey="permits" name="HCD permitted units" stroke={colors[1]} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="completions" name="HCD completed units" stroke={colors[0]} strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer>
      </div>
      <p className="text-sm">Dashed: permitted units. Solid: completed units. These annual flows represent different project cohorts. Their ratio is not a completion rate, and their difference is not a measured backlog. Three-year averages require three consecutive available years.</p>
      <FigureAttribution sources={["hcd"]} />
      <details className="mt-3"><summary>View annual values</summary><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Year</th><th className="text-right p-2">Permitted units</th><th className="text-right p-2">Completed units</th></tr></thead><tbody>{chart.map(row => <tr key={row.year} className="border-t"><td className="p-2">{row.year}</td><td className="text-right p-2">{number(row.permits, average ? 1 : 0)}</td><td className="text-right p-2">{number(row.completions, average ? 1 : 0)}</td></tr>)}</tbody></table></div></details>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>What types of housing are being delivered?</CardTitle></CardHeader><CardContent>
      {total == null ? <p>Completion composition is unavailable for this jurisdiction-year.</p> : <>
        <p className="mb-3">{region.name} · {year} · {number(total)} completed units</p>
        <div className="h-80" role="img" aria-label="Completed housing units by structure type"><ResponsiveContainer width="100%" height="100%"><BarChart data={composition} layout="vertical" margin={{ right: 25 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis type="number" stroke="var(--muted-foreground)" minTickGap={25} tickFormatter={v => Intl.NumberFormat("en-US", { notation: "compact" }).format(v)} /><YAxis type="category" dataKey="name" width={145} stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="units" name="Completed units" fill={colors[0]} isAnimationActive={false} />
        </BarChart></ResponsiveContainer></div>
        <p className="text-sm">ADUs have their own category and are not added again to other structure types. Unknown source classifications remain in Other / unspecified.</p>
      </>}
      <FigureAttribution sources={["hcd"]} />
      <details className="mt-4"><summary>Reported affordability of completed housing</summary>
        <p className="my-3 text-sm">These categories describe reported affordability, not residents’ measured rent burden. Non-deed-restricted units are not necessarily subsidized or permanently affordable. Very low and below combines the newer acutely and extremely low categories for comparison across reporting years.</p>
        {income ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Income category</th><th className="text-right p-2">Deed restricted</th><th className="text-right p-2">Not deed restricted</th></tr></thead><tbody>{incomeGroups.map(g => <tr key={g.label} className="border-t"><td className="p-2">{g.label}</td><td className="text-right p-2">{number(g.dr.reduce((s, i) => s + income[i], 0))}</td><td className="text-right p-2">{number(g.ndr.reduce((s, i) => s + income[i], 0))}</td></tr>)}<tr className="border-t"><td className="p-2">Above moderate</td><td colSpan={2} className="text-right p-2">{number(income[10])} total</td></tr></tbody></table></div> : <p>Affordability detail is unavailable or does not reconcile with reported completion totals.</p>}
      </details>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Sources, coverage and interpretation</CardTitle></CardHeader><CardContent className="method-copy">
      <p>BPS measures privately owned new residential construction authorizations. HCD APR reporting also covers categories such as conversions and manufactured housing. HCD permits are shown with HCD completions; they do not replace the separate Census series.</p>
      <p>Only reported annual activity is aggregated. No-row years remain unavailable, and observed zeroes are zeroes in the available records, not an independent certification of reporting completeness. Published values may be revised. The latest year remains subject to local reporting delays.</p>
      <p>New units are reported separately from demolished units. These figures are not net additions. Repeated projects across phases and years are not automatically removed as duplicates.</p>
      <details><summary>Observation checks for {region.name}, {year}</summary><p>{!cell ? "No records available." : issues.length === 0 ? "Reported completion totals and affordability components reconcile; no completion date exceptions were found." : issues.map(([key, count]) => `${number(count)} ${key.replaceAll("_", " ")} ${key === "missing_total" ? "record(s)" : "group(s)"}`).join("; ") + "."}</p><p>Historical activity carried in another year’s report is excluded from that report’s annual total. Missing dates retain reported units with a flag. These checks do not certify completeness of local reporting.</p></details>
      <p><a href={manifest.data_page} target="_blank" rel="noreferrer">HCD data and dictionaries</a> · <a href="https://www.hcd.ca.gov/apr/forms" target="_blank" rel="noreferrer">Reporting instructions</a></p>
      <details><summary>Release provenance</summary><p>Release: {manifest.release}<br />Published: {manifest.created_at.slice(0, 10)}<br /><span className="break-all">SHA-256: {manifest.bundle_sha256}</span></p></details>
    </CardContent></Card>
  </div>;
}
