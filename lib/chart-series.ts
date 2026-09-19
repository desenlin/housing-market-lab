export type TimeRange = "1y" | "3y" | "5y" | "max";

export const TIME_RANGES: { key: TimeRange; label: string; months: number | null }[] = [
  { key: "1y", label: "1 year", months: 12 },
  { key: "3y", label: "3 years", months: 36 },
  { key: "5y", label: "5 years", months: 60 },
  { key: "max", label: "Max", months: null },
];

export function timeRangeStart(length: number, range: TimeRange) {
  const months = TIME_RANGES.find((item) => item.key === range)?.months;
  return months == null ? 0 : Math.max(0, length - months);
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
