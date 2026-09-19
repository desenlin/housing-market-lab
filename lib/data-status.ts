export const PERMIT_LABELS = {
  monthly: {
    label: "Monthly estimates",
    definition: "Official Census estimates of monthly permit activity. Current-year figures are preliminary and may change as late reports and corrections arrive. Estimates may include Census-imputed activity.",
  },
  historical: {
    label: "Historical monthly estimates",
    definition: "Local monthly observations retained from the cumulative Census file available when annual totals were released. Local monthly figures are not benchmarked to final annual totals and may not sum to them.",
  },
  annual: {
    label: "Final annual totals",
    definition: "Annual Census totals after the yearly revision cycle. These can include imputed activity and may differ from the sum of local monthly observations.",
  },
} as const;

export const DATA_CHECKS_DEFINITION = "The Lab checked the source files, data structure, dates, coverage, and calculation inputs before accepting this snapshot. These processing checks apply to every provider, including monthly permits; they do not certify statistical accuracy or prevent later source revisions.";
