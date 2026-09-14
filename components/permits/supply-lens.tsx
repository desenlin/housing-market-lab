"use client";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DefinitionHelp } from "@/components/definition-help";
export function SupplyLens({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="control-label"><span>Data lens<DefinitionHelp label="Supply data lens" definition="Permit activity uses Census BPS monthly and annual authorizations. Housing delivery uses California HCD annual permitted and completed units. The sources have different coverage and remain separate." /></span><NativeSelect aria-label="Supply data lens" value={value} onChange={e => onChange(e.target.value)}><NativeSelectOption value="activity">Permit activity</NativeSelectOption><NativeSelectOption value="delivery">Housing delivery</NativeSelectOption></NativeSelect></label>;
}
