"use client";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export function DefinitionHelp({ label, definition }: { label: string; definition: string }) {
  return <Tooltip><TooltipTrigger aria-label={`Definition of ${label}`} className="definition-help" type="button">?</TooltipTrigger><TooltipContent className="definition-tooltip" sideOffset={6}>{definition}</TooltipContent></Tooltip>;
}
