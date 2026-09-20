"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DefinitionHelp } from "@/components/definition-help";
import { FigureAttribution } from "@/components/figure-attribution";
import { TimeRangeControl } from "@/components/time-range-control";
import { DataThrough } from "@/components/map-period";
import { timeAxisTicks, timeRangeStart, valueAxisDomain, type TimeRange } from "@/lib/chart-series";
import {
  CPI_AREAS, INFLATION_DEFINITIONS, INFLATION_STYLES, commonInflationMonths,
  inflationDate, inflationRate, inflationSeriesKey, inflationValues, toggleInflationCategory,
  type CpiArea, type CpiDataset, type InflationCategory, type InflationView,
} from "@/lib/inflation";

export function InflationPanel({ dataset, error, lensControl }: { dataset: CpiDataset | null; error: string; lensControl: ReactNode }) {
  if (!dataset?.categories?.length) return <section className="control-deck"><div className="inflation-controls">{lensControl}</div><p role="status">{error ? "Regional inflation is temporarily unavailable." : "Loading regional inflation…"}</p></section>;
  return <LoadedInflationPanel dataset={dataset} categories={dataset.categories} lensControl={lensControl} />;
}

function LoadedInflationPanel({ dataset, categories, lensControl }: { dataset: CpiDataset; categories: InflationCategory[]; lensControl: ReactNode }) {
  const [comparison, setComparison] = useState("categories");
  const [area, setArea] = useState<CpiArea>("la");
  const [category, setCategory] = useState("all");
  const [view, setView] = useState<InflationView>("yoy");
  const [range, setRange] = useState<TimeRange>("5y");
  const [requestedBase, setRequestedBase] = useState("2020-01");
  const [selected, setSelected] = useState(["all", "core", "food", "energy"]);
  const categoryMeta = categories.find(item => item.key === category) ?? categories[0];
  // A common observation month keeps snapshot comparisons aligned when releases differ.
  const months = useMemo(() => commonInflationMonths(Object.values(dataset.series)), [dataset]);
  const latest = months.at(-1) ?? "";
  const baseMonth = months.includes(requestedBase) ? requestedBase : months.find(month => month >= requestedBase) ?? latest;
  const transformed = useMemo(() => Object.fromEntries(Object.entries(dataset.series).map(([key, series]) => { const values = inflationValues(series, view, baseMonth); return [key, new Map(series.dates.map((date, index) => [date.slice(0, 7), values[index]]))]; })), [dataset, view, baseMonth]);
  const plotted = useMemo(() => comparison === "categories"
    ? categories.filter(item => selected.includes(item.key)).map(item => ({ id: inflationSeriesKey(area, item.key), label: item.label, ...INFLATION_STYLES[item.key] }))
    : (["la", "us"] as CpiArea[]).map(item => ({ id: inflationSeriesKey(item, category), label: CPI_AREAS[item], color: item === "la" ? "var(--chart-2)" : "var(--chart-1)", dash: item === "us" ? "6 3" : undefined })),
  [area, categories, category, comparison, selected]);
  const chart = useMemo(() => {
    const dates = [...new Set(Object.values(dataset.series).flatMap(series => series.dates.map(date => date.slice(0, 7))))].sort().filter(month => month <= latest && (view === "yoy" ? month >= "2001-01" : month >= baseMonth));
    const rows = dates.map(date => Object.fromEntries([["date", date], ...plotted.map(series => [series.id, transformed[series.id]?.get(date) ?? null])]) as Record<string, string | number | null>);
    return rows.slice(timeRangeStart(rows.length, range));
  }, [dataset, latest, view, baseMonth, plotted, transformed, range]);
  const snapshotValue = (key: string, chosenArea: CpiArea) => transformed[inflationSeriesKey(chosenArea, key)]?.get(latest) ?? null;
  const chooseCategory = (key: string) => comparison === "areas" ? setCategory(key) : setSelected(current => toggleInflationCategory(current, key));
  const ticks = timeAxisTicks(chart.map(row => String(row.date)));
  const description = INFLATION_DEFINITIONS[view];

  return <>
    <section className="regional-intro">
      <div><p className="section-kicker">Regional inflation</p><h2>How are consumer prices changing?</h2></div>
      <p>Compare inflation across spending categories in Los Angeles and Orange counties, or compare the LA area with the United States.</p>
    </section>
    <section className="control-deck" aria-label="Regional inflation controls">
      <div className="source-strip"><span className="source-badge bls">Source: BLS CPI-U · Monthly</span><span>Consumer prices · Through {inflationDate(latest)}</span></div>
      <div className="inflation-controls">
        {lensControl}
        <label className="control-label"><span>Comparison <DefinitionHelp label="Inflation comparison" definition={INFLATION_DEFINITIONS.categories} /></span><NativeSelect aria-label="Inflation comparison" value={comparison} onChange={event => setComparison(event.target.value)}><NativeSelectOption value="categories">Spending categories</NativeSelectOption><NativeSelectOption value="areas">LA area vs. U.S.</NativeSelectOption></NativeSelect></label>
        {comparison === "categories" ? <label className="control-label"><span>Area <DefinitionHelp label="CPI geography" definition={INFLATION_DEFINITIONS.geography} /></span><NativeSelect aria-label="Inflation area" value={area} onChange={event => setArea(event.target.value as CpiArea)}>{Object.entries(CPI_AREAS).map(([key, label]) => <NativeSelectOption value={key} key={key}>{label}</NativeSelectOption>)}</NativeSelect></label>
          : <label className="control-label"><span>Category <DefinitionHelp label={categoryMeta.label} definition={categoryMeta.description} /></span><NativeSelect aria-label="Inflation category" value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <NativeSelectOption key={item.key} value={item.key}>{item.label}</NativeSelectOption>)}</NativeSelect></label>}
        <label className="control-label"><span>View <DefinitionHelp label="Inflation view" definition={description} /></span><NativeSelect aria-label="Inflation view" value={view} onChange={event => setView(event.target.value as InflationView)}><NativeSelectOption value="yoy">Year-over-year inflation</NativeSelectOption><NativeSelectOption value="cumulative">Cumulative price change</NativeSelectOption></NativeSelect></label>
      </div>
    </section>
    <section className="analysis-grid inflation-analysis-grid">
      <Card className="chart-card">
        <CardHeader className="chart-header">
          <div><p className="section-kicker">Time</p><div className="metric-title-row"><CardTitle><span className="metric-heading">{comparison === "areas" ? categoryMeta.label : view === "yoy" ? "Consumer price inflation" : "Consumer price growth"}<DefinitionHelp label="Consumer price change" definition={description} /></span></CardTitle><DataThrough period={inflationDate(latest)} /></div></div>
          <div className="chart-options">
            <TimeRangeControl value={range} onChange={setRange} />
            {view === "cumulative" && <label className="index-base"><span>Starting month</span><NativeSelect aria-label="Inflation starting month" value={baseMonth} onChange={event => setRequestedBase(event.target.value)}>{months.map(month => <NativeSelectOption key={month} value={month}>{inflationDate(month)}</NativeSelectOption>)}</NativeSelect></label>}
            <p>{view === "yoy" ? "Percent change from one year earlier" : `Percent change since ${inflationDate(baseMonth)}`}</p>
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0 sm:p-5 sm:pt-0">
          {!plotted.length ? <div className="chart-empty" role="status">Select a spending category to display the chart.</div> : <div className="h-[360px] min-w-0 w-full" aria-label="Regional consumer price inflation chart">
            <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 12, right: 12, left: 8, bottom: 8 }}>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={date => chart.length <= 18 ? inflationDate(String(date)) : String(date).slice(0, 4)} tick={{ fill: "var(--chart-label)", fontSize: 12 }} axisLine={{ stroke: "var(--chart-axis)" }} tickLine={false} />
              <YAxis width={78} domain={valueAxisDomain(chart, plotted.map(series => series.id), "yoy")} tickFormatter={value => `${Math.round(Number(value) * 1000) / 10}%`} tick={{ fill: "var(--chart-label)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <ChartTooltip labelFormatter={date => inflationDate(String(date))} formatter={(value, name) => [inflationRate(Number(value)), plotted.find(series => series.id === String(name))?.label ?? String(name)]} contentStyle={{ borderRadius: 8, borderColor: "var(--chart-tooltip-border)", background: "var(--chart-tooltip-bg)", color: "var(--chart-tooltip-text)", boxShadow: "var(--chart-tooltip-shadow)" }} />
              <Legend wrapperStyle={{ paddingTop: 16 }} formatter={id => plotted.find(series => series.id === String(id))?.label ?? String(id)} />
              {plotted.map(series => <Line key={series.id} dataKey={series.id} type="monotone" stroke={series.color} strokeDasharray={series.dash} strokeWidth={series.id === "la" || series.id === "us" ? 3 : 2} dot={false} connectNulls={false} isAnimationActive={false} />)}
            </LineChart></ResponsiveContainer>
          </div>}
          <FigureAttribution sources={["bls"]} />
        </CardContent>
      </Card>
      <Card className="ranking-card inflation-snapshot">
        <CardHeader><p className="section-kicker">{inflationDate(latest)}</p><CardTitle><span className="metric-heading">{view === "yoy" ? "Latest inflation rates" : "Cumulative change"}<DefinitionHelp label="Category comparison" definition={INFLATION_DEFINITIONS.categories} /></span></CardTitle><p className="inflation-snapshot-note">{comparison === "areas" ? "LA area and United States" : CPI_AREAS[area]}{view === "cumulative" ? ` · Since ${inflationDate(baseMonth)}` : ""}</p>
          <div className={`inflation-columns ${comparison === "areas" ? "two-areas" : ""}`} aria-hidden="true"><span>Category</span>{comparison === "areas" ? <><span>LA area</span><span>U.S.</span></> : <span>Change</span>}<span /></div>
        </CardHeader>
        <CardContent className="inflation-rows">
          {categories.map(item => {
            const active = comparison === "areas" ? item.key === category : selected.includes(item.key);
            const disabled = comparison === "categories" && !active && selected.length >= 5;
            return <div key={item.key} className={`inflation-row ${active ? "selected" : ""}`}>
              <button type="button" data-inflation-category={item.key} className={`inflation-category-button ${comparison === "areas" ? "two-areas" : ""}`} aria-pressed={active} disabled={disabled} onClick={() => chooseCategory(item.key)} aria-label={`${comparison === "areas" ? "Compare" : active ? "Hide" : "Show"} ${item.label}`}>
                <span><i style={{ background: INFLATION_STYLES[item.key]?.color }} />{item.label}</span>
                {comparison === "areas" ? <><strong>{inflationRate(snapshotValue(item.key, "la"))}</strong><strong>{inflationRate(snapshotValue(item.key, "us"))}</strong></> : <strong>{inflationRate(snapshotValue(item.key, area))}</strong>}
              </button><DefinitionHelp label={item.label} definition={item.description} />
            </div>;
          })}
          <p className="inflation-selection" aria-live="polite">{comparison === "areas" ? "Select a category to compare both areas." : `${selected.length} of 5 categories selected. Click to select or deselect.`}</p>
        </CardContent>
      </Card>
    </section>
  </>;
}
