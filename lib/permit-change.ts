// Compare the same calendar month or annual total one year earlier. Never use
// the previous row as a substitute for a missing comparison period.
export function permitChange(values: (number | null)[], dates: string[], index: number, unit: string): number | null {
  const date = dates[index];
  if (!date) return null;
  const priorDate = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
  const priorIndex = dates.indexOf(priorDate);
  const current = values[index];
  const prior = priorIndex < 0 ? null : values[priorIndex];
  if (current == null || prior == null || !Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (unit === "share") return (current - prior) * 100;
  return current - prior;
}

export function formatPermitChange(value: number | null, unit: string): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: unit === "units" ? 0 : 1 })}${unit === "share" ? " pp" : ""}`;
}

type PermitWindowRegion = {
  housing_stock: number;
  series: Record<string, (number | null)[]>;
};

// A rolling year requires every calendar month; missing reports are not zeros.
export function trailingPermitValue(region: PermitWindowRegion, dates: string[], index: number, metric: string): number | null {
  const end = dates[index];
  if (!end || !/^\d{4}-\d{2}$/.test(end)) return null;
  const indices = Array.from({ length: 12 }, (_, offset) => {
    const month = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1 - offset, 1));
    return dates.indexOf(month.toISOString().slice(0, 7));
  });
  function sum(key: string): number | null {
    const values = indices.map((i) => i < 0 ? null : region.series[key]?.[i] ?? null);
    if (values.some((value) => value == null || !Number.isFinite(value))) return null;
    return values.reduce<number>((total, value) => total + value!, 0);
  }
  if (metric === "large_multifamily_share") {
    const total = sum("total_units"), large = sum("large_multifamily");
    return total != null && total > 0 && large != null ? large / total : null;
  }
  if (metric === "units_per_1000_stock") {
    const total = sum("total_units");
    return total != null && region.housing_stock > 0 ? total / region.housing_stock * 1000 : null;
  }
  return sum(metric);
}

export function trailingPermitChange(region: PermitWindowRegion, dates: string[], index: number, metric: string, unit: string): number | null {
  const date = dates[index];
  if (!date) return null;
  const priorIndex = dates.indexOf(`${Number(date.slice(0, 4)) - 1}${date.slice(4)}`);
  const current = trailingPermitValue(region, dates, index, metric);
  const prior = trailingPermitValue(region, dates, priorIndex, metric);
  return current == null || prior == null ? null : (current - prior) * (unit === "share" ? 100 : 1);
}
