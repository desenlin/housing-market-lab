"use client";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
export function SupplyLens({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="control-label"><span>Data lens</span><NativeSelect aria-label="Supply data lens" value={value} onChange={e => onChange(e.target.value)}><NativeSelectOption value="activity">Permit activity — Census BPS</NativeSelectOption><NativeSelectOption value="delivery">Housing delivery — HCD</NativeSelectOption></NativeSelect></label>;
}
