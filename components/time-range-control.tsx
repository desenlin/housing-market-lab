"use client";

import { TIME_RANGES, type TimeRange } from "@/lib/chart-series";

export function TimeRangeControl({
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
