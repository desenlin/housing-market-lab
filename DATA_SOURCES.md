# Data sources and methods

## Zillow Research

The pipeline discovers links on the official [Zillow Research housing data page](https://www.zillow.com/research/data/) and retains a last-known URL for each required file. A URL change can therefore be absorbed when the filename still identifies the same geography, metric, home type, tier, and adjustment.

Selected series:

| Display measure | Provider series | Local geography | Metro geography |
|---|---|---:|---:|
| Typical home value | ZHVI, mid-tier, all homes, seasonally adjusted | City, ZIP | Yes |
| Typical observed rent | ZORI, all homes plus multifamily, smoothed | City, ZIP | Yes |
| Price–rent multiple | ZHVI ÷ (12 × ZORI) | Derived | — |
| For-sale inventory | Listings active during the month | — | Yes |
| Median days to pending | First listing to pending status | — | Yes |
| Listings with a price cut | Share of active listings | — | Yes |
| Mean sale-to-list ratio | Sale price ÷ final list price | — | Yes |

Local filtering retains California observations whose `CountyName` is Orange County or Los Angeles County. The metro comparison uses the 20 largest U.S. metropolitan statistical areas ranked by the Census Bureau's July 1, 2025 population estimates, as compiled in the [Metropolitan statistical area table](https://en.wikipedia.org/wiki/Metropolitan_statistical_area). Los Angeles, Riverside, and San Diego remain the default Southern California comparison; San Jose is retained separately as a selected California comparator. Short display labels follow Zillow's metro names and include state abbreviations. The combined set contains 21 metros across eight Census divisions.

Values are rounded only in the compact published files: currency and counts to whole units, days to one decimal, and shares/ratios to five decimals.

To keep static releases small enough for reliable academic hosting, ZIP series omit only leading and trailing missing values and retain a start offset. The application reconstructs those missing positions before any calculation; observed monthly values and interior gaps are unchanged.

## Redfin Data Center

The independent Redfin pipeline streams the official [Redfin Data Center downloads](https://www.redfin.com/news/data-center/downloads/) and follows Redfin's [Data Center methodology](https://www.redfin.com/news/data-center/methodology/). National source files are not committed. City/community observations are filtered against Census places assigned to Orange and Los Angeles counties, independently of Zillow's coverage. ZIP observations use the lab's county-labelled ZCTA reference because ZCTAs can cross county lines. Redfin results are published under `public/data/redfin/` with a separate release pointer.

Selected series:

| Display measure | Redfin field | Interpretation | Change shown |
|---|---|---|---|
| Months of supply | `MONTHS OF SUPPLY` | Inventory relative to the recent closed-sales pace | Absolute months |
| Median days on market | `MEDIAN DAYS ON MARKET (DAYS)` | Listing to contract speed | Absolute days |
| Homes sold above original list | `SHARE SOLD ABOVE ORIGINAL LIST (%)` | Sale competition relative to the initial ask | Percentage points |
| Active listings with price drops | `PERCENT ACTIVE WITH PRICE DROPS (%)` | Seller repricing among active listings | Percentage points |
| Median sale price per square foot | `MEDIAN SALE PRICE PER SQ.FT. ($)` | Transaction price normalized by floor area | Percent |

City and ZIP observations use Redfin's **rolling three-month** frequency. The period end date is used as the chart date. The pipeline starts in January 2018, which provides a pre-pandemic baseline while keeping scheduled national-file scans bounded.

Redfin city names are matched directly to Census place names; they do not need a corresponding Zillow observation. If Redfin exposes duplicate rows for the same place label and period, the pipeline selects the row with the larger activity count instead of summing medians or shares. A source schema change, date-order change, or material loss of coverage rejects only the prospective Redfin release.

Redfin and Zillow activity variables should not be treated as interchangeable even when their labels resemble one another. They come from different listing feeds, record processing, geographic definitions, revision practices, and smoothing conventions. The interface therefore keeps provider badges and reporting windows visible.

## Realtor.com Economic Research

The independent Realtor.com pipeline reads the ZIP historical files from the official [Realtor.com Real Estate Data Library](https://www.realtor.com/research/data/). It filters against the lab's two-county ZCTA boundary reference rather than inferring counties from ZIP prefixes. Realtor.com data appear as a separate **Inventory & buyer interest** lens within **Market Conditions**; they are not pooled with similarly named Redfin measures.

Selected primary series:

| Display measure | Realtor.com field | Interpretation | Change shown |
|---|---|---|---|
| Active listings | `active_listing_count` | Typical daily active for-sale inventory during the month | Percent |
| New listings | `new_listing_count` | Listings newly added during the month | Percent |
| Pending-to-active ratio | `pending_ratio` | Pending listings divided by active listings | Percentage points |
| Listing viewers relative to U.S. | `page_view_count_per_property_vs_us` | Viewer attention per property relative to a typical U.S. listing | Change in multiple |
| Market Hotness score | `hotness_score` | Equal-weight composite of relative demand and supply scores | Score points |

Demand score, supply score, and Realtor.com median days on market are retained only to explain the Hotness measure. Provider-created ranks, listing-price measures, raw pending counts, and price-reduction measures are omitted from the first release to avoid redundancy or misleading comparison with Zillow and Redfin.

Inventory and Hotness have separate `latest.json` pointers under `public/data/realtor/` because the two files may be released in different weeks. The interface labels the latest month for the selected metric rather than implying a common Realtor.com vintage. Each product retains its three newest validated releases for rollback.

The national historical files are large, so the updater performs an HTTP metadata check before retrieval. When a file changes, it is streamed once and never written to disk; only selected ZIP rows from January 2018 onward are held in memory. The full source must be reread after a change because Realtor.com reissues and may restate historical observations rather than publishing an append-only series.

Rows with a nonzero `quality_flag` remain in the compact release so that the historical series is not fragmented. Their month indexes are stored separately and surfaced in charts, rankings, maps, and coverage summaries as observations requiring review. A source schema change, fewer than 150 covered local ZIPs, a short history, or a processed product above 5 MB rejects that product's prospective release while leaving its prior pointer unchanged.

The public application attributes the data to **Realtor.com® Economic Research** and links to the provider's Data Library and [Market Hotness methodology](https://www.realtor.com/research/reports/hottest-markets/). Market Hotness is a relative measure based on listing attention and market speed; it is not a probability of sale and should not be interpreted as a matched-market comparison with Redfin.

## Consumer Price Index

The independent CPI pipeline reads the official BLS [`cu.data.1.AllItems`](https://download.bls.gov/pub/time.series/cu/cu.data.1.AllItems) bulk time-series file first and uses the [Public Data API](https://www.bls.gov/developers/) only as a fallback. It does not rely on a FRED mirror or require a registered API key. This avoids routine dependence on the API's unregistered daily query quota; fallback requests are divided into ten-year blocks within the public limit.

Selected series:

| Use | BLS series | Geography | Adjustment |
|---|---|---|---|
| Local real values, rents, and inflation | `CUURS49ASA0` | Los Angeles–Long Beach–Anaheim; Los Angeles and Orange Counties | Not seasonally adjusted |
| Common cross-metro benchmark | `CUUR0000SA0` | U.S. city average | Not seasonally adjusted |

Both series are CPI-U, All Items, monthly, with an index reference base of 1982–84=100. Local views default to the LA-area series because its published geography matches the two-county focus. Regional-cycle comparisons default to the U.S. series so every selected metro uses the same deflator. Users may select either series when viewing real values.

The pipeline constructs a complete monthly calendar and preserves an unavailable official observation as `null`; it does not interpolate or carry CPI forward. Consequently, real housing observations end with the latest month for which both the housing measure and selected CPI exist. The local index has a smaller sample and can be more volatile than the national index, so year-over-year inflation is emphasized over month-to-month change.

## Building Permits Survey

The permit pipeline downloads the Census Bureau's documented comma-delimited West-region place files underlying the [Building Permits Survey](https://www.census.gov/construction/bps/). [HUD SOCDS Building Permits](https://www.huduser.gov/socds/permits/) remains linked in the interface as a convenient jurisdiction-level verification tool. The project attributes the observations to the U.S. Census Bureau rather than describing SOCDS as a separate statistical source.

| Display measure | Construction categories | Interpretation |
|---|---|---|
| All units authorized | 1-unit + 2-unit + 3–4-unit + 5+-unit structures | New privately owned housing units authorized by permits |
| Single-unit housing | 1-unit structures | Attached or detached single-unit structures |
| Units in 2–4-unit buildings | 2-unit + 3–4-unit structures | Small multifamily authorizations |
| Units in 5+-unit buildings | 5+-unit structures | Larger multifamily authorizations |
| 5+-unit share | 5+-unit housing units ÷ all authorized units | Structure mix among authorized units |
| Units per 1,000 existing units | All authorized units ÷ ACS housing stock × 1,000 | Permitting intensity relative to the current housing base |

Annual place files are retained from 1980 through the latest final year. Monthly place files begin in January 2022 because the BPS local-area estimation method changed then; starting at the method break provides a more coherent comparison window. Current-year monthly records are preliminary, can be revised, and can include Census-imputed values. Final annual files also disclose reported-only components and months reported; the compact release stores month indexes where reported and published totals differ.

The geographic unit is the permit-issuing jurisdiction, not every Census place. The current reference contains 122 incorporated cities and the Los Angeles County and Orange County unincorporated-area aggregates. Census-designated places such as Rossmoor do not receive a separate BPS observation: their map boundaries are labelled as included in the appropriate county unincorporated total and are never assigned a duplicated county value. County totals shown in the interface sum incorporated jurisdictions plus the unincorporated aggregate.

Modern records are joined by five-digit Census place FIPS. Older BPS identifiers were reused as the permitting universe changed, so legacy rows are joined by county and a normalized jurisdiction name instead of treating the raw six-digit BPS identifier as stable. Unit tests preserve this rule. The normalization denominator is the configured ACS five-year table `B25001` (total housing units); the unincorporated denominator is the county estimate less the included incorporated-place estimates.

Final history and open years have independent atomic pointers. A routine check discovers the newest cumulative revised monthly file and rebuilds only the provisional bundle. Annual history, final 2022–present monthly data, and the ACS denominator are rebuilt only when the latest final annual year changes. Coverage must remain at 89 Los Angeles County jurisdictions and 35 Orange County jurisdictions, duplicate jurisdiction-dates are rejected, and compact history/provisional releases are capped separately before publication.

## Census cartographic boundaries

- 2025 California Places, 1:500,000 cartographic boundary file
- 2025 US Counties, 1:500,000 cartographic boundary file
- 2025 California Places Gazetteer internal points
- 2020 national ZCTAs, 1:500,000 cartographic boundary file

The city/community map retains every Census place assigned to Orange or Los Angeles County, including Census-designated places in unincorporated territory. A place without a current observation for the selected provider and metric remains visible in gray and is labelled **No data** rather than being absorbed into a neighboring city. Unshaded basemap areas are outside the displayed Census place geography—typically county remainder, wilderness, or open space—and are not classified as missing city-level observations. The pipeline uses each place's official Census internal point and county polygons to make the county assignment.

The pipeline matches place names or five-digit ZCTA codes to provider regions and publishes compact GeoJSON boundaries. ZCTAs approximate—but do not exactly reproduce—USPS delivery ZIP codes. Maps are selection and pattern-finding aids; the chart values come from the provider records, not from the boundary files.

## OpenStreetMap

The interactive maps request the standard OpenStreetMap tile layer at `https://tile.openstreetmap.org/{z}/{x}/{y}.png` only for the area and zoom level a visitor views. The application does not prefetch, scrape, proxy, or archive map tiles. Visible attribution is retained on every map.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Tile use is subject to the [OpenStreetMap Foundation tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Transformations

- **Percent change:** `value[t] / value[t-12] - 1`
- **Absolute change:** `value[t] - value[t-12]` for days and months
- **Percentage-point change:** `100 × (share[t] - share[t-12])`
- **Indexed:** `100 × value[t] / value[user-selected starting month]`
- **Price–rent multiple:** `ZHVI[t] / (12 × ZORI[t])`
- **Constant-dollar value:** `nominal[t] × CPI[base month] / CPI[t]`
- **Real percent change:** `(nominal[t] / nominal[t-12]) / (CPI[t] / CPI[t-12]) - 1`
- **Inflation:** `CPI[t] / CPI[t-12] - 1`

Changing the constant-dollar base month rescales the displayed real dollar level but does not change real growth. The derived price–rent multiple compares a typical value index with an observed-rent index and is unchanged by applying the same CPI adjustment to its numerator and denominator. It is an educational market indicator, not a capitalization rate, investment return, or matched-property valuation. Real rent measures purchasing power relative to a general consumer basket; it is not an affordability measure because it does not incorporate household income.

## Release checks

A provider release is rejected unless all required files stream or download, date columns are ordered and sufficiently long, local coverage remains above conservative floors, and processed public data stays under its size guardrail. Zillow, Redfin, Realtor.com Inventory, Realtor.com Hotness, BLS CPI, final permit history, and provisional permit years use independent versioned directories and `latest.json` pointers, so a failure retains the prior release for that provider or product.

The scheduled workflow checks all providers on four staggered dates each month. Release timing is intentionally decoupled: a newer CPI release does not require a simultaneous Zillow release, and a newer Zillow release does not wait for CPI. Nominal housing observations remain available through Zillow's latest validated month. Constant-dollar levels, real changes, and same-month inflation comparisons use only exact months with official observations in both the selected housing series and selected CPI series; unmatched newer housing months remain unavailable in real terms until BLS publishes the corresponding CPI observation.

Data provided by Zillow Group, Redfin, and Realtor.com® Economic Research. This repository does not redistribute the complete provider files. See [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md) for source-specific attribution and reuse limits.

## Intended use and disclaimer

The application and filtered releases are provided for instruction and noncommercial academic research. They are not financial, investment, legal, valuation, or real-estate advice and should not be used for transaction decisions. Third-party data remain subject to their respective licenses and terms; this repository does not grant reuse or commercial-use rights to provider data.
