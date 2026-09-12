export type FigureSource =
  | "zillow"
  | "redfin"
  | "realtor"
  | "bls"
  | "census-acs"
  | "census-bps";

const SOURCES: Record<FigureSource, { label: string; href: string }> = {
  zillow: {
    label: "Data provided by Zillow Group",
    href: "https://www.zillow.com/research/data/",
  },
  redfin: {
    label: "Data provided by Redfin",
    href: "https://www.redfin.com/news/data-center/downloads/",
  },
  realtor: {
    label: "Realtor.com® Economic Research",
    href: "https://www.realtor.com/research/data/",
  },
  bls: {
    label: "U.S. Bureau of Labor Statistics",
    href: "https://www.bls.gov/cpi/data.htm",
  },
  "census-acs": {
    label: "U.S. Census Bureau, American Community Survey",
    href: "https://www.census.gov/programs-surveys/acs/data.html",
  },
  "census-bps": {
    label: "U.S. Census Bureau, Building Permits Survey",
    href: "https://www.census.gov/construction/bps/",
  },
};

export function FigureAttribution({
  sources,
  boundaries = false,
  basemap = false,
}: {
  sources: FigureSource[];
  boundaries?: boolean;
  basemap?: boolean;
}) {
  return (
    <p className="figure-attribution">
      <strong>{sources.length === 1 ? "Source" : "Sources"}:</strong>{" "}
      {sources.map((source, index) => (
        <span key={source}>
          {index > 0 && "; "}
          <a href={SOURCES[source].href} target="_blank" rel="noreferrer">{SOURCES[source].label}</a>
        </span>
      ))}.
      {boundaries && (
        <> <strong>Boundaries:</strong> <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" target="_blank" rel="noreferrer">U.S. Census Bureau</a>.</>
      )}
      {basemap && (
        <> <strong>Basemap:</strong> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.</>
      )}
    </p>
  );
}
