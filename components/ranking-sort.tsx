"use client";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type RankBy = "level" | "growth";

export type SupplyRankBy = RankBy | "trailing";

export function RankingSort<T extends SupplyRankBy>({ value, onChange, label, changeDisabled = false, trailing = false }: {
  value: T;
  onChange: (value: T) => void;
  label: string;
  changeDisabled?: boolean;
  trailing?: boolean;
}) {
  return (
    <label className="control-label">
      <span>Sort by</span>
      <NativeSelect aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
        <NativeSelectOption value="level">Level</NativeSelectOption>
        <NativeSelectOption value="growth" disabled={changeDisabled}>Change</NativeSelectOption>
        {trailing && <NativeSelectOption value="trailing">Last 12 months</NativeSelectOption>}
      </NativeSelect>
    </label>
  );
}
