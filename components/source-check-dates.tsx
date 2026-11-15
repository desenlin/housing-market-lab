export type ProviderCheck = {
  last_success_at?: string;
  last_attempt_at?: string;
  last_exit_code?: number;
};

function checkDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(value));
}

export function SourceCheckDates({ validatedAt, check }: {
  validatedAt?: string;
  check?: ProviderCheck;
}) {
  if (!validatedAt) return null;
  return <>
    <small>Snapshot validated {checkDate(validatedAt)}</small>
    {check?.last_success_at && <small>Source last checked {checkDate(check.last_success_at)}</small>}
    {check?.last_attempt_at && typeof check.last_exit_code === "number" && check.last_exit_code !== 0 &&
      <small>Refresh failed {checkDate(check.last_attempt_at)}; prior snapshot retained.</small>}
  </>;
}
