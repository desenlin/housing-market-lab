export function DataThrough({ period }: { period: string }) {
  return <span className="metric-freshness">Data through {period}</span>;
}

export function MapPeriod({ latest, selected }: { latest: string; selected?: string }) {
  return (
    <div className="map-period" aria-live="polite">
      <DataThrough period={latest} />
      {selected && selected !== latest && <span className="map-period-selection">Showing {selected}</span>}
    </div>
  );
}
