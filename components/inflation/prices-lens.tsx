"use client";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
export function PricesLens({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="control-label"><span>Data lens</span><NativeSelect aria-label="Prices and rents data lens" value={value} onChange={event => onChange(event.target.value)}><NativeSelectOption value="housing">Values &amp; rents — Zillow</NativeSelectOption><NativeSelectOption value="inflation">Regional inflation — BLS</NativeSelectOption></NativeSelect></label>;
}
