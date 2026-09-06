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

Local filtering retains California observations whose `CountyName` is Orange County or Los Angeles County. The metro comparison retains Los Angeles, Riverside, San Diego, San Francisco, San Jose, Phoenix, and Austin.

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

## Consumer Price Index

The independent CPI pipeline queries the [U.S. Bureau of Labor Statistics Public Data API](https://www.bls.gov/developers/) directly. It does not rely on a FRED mirror or require a registered API key. Requests are divided into ten-year blocks within the public unregistered API limit.

Selected series:

| Use | BLS series | Geography | Adjustment |
|---|---|---|---|
| Local real values, rents, and inflation | `CUURS49ASA0` | Los Angeles–Long Beach–Anaheim; Los Angeles and Orange Counties | Not seasonally adjusted |
| Common cross-metro benchmark | `CUUR0000SA0` | U.S. city average | Not seasonally adjusted |

Both series are CPI-U, All Items, monthly, with an index reference base of 1982–84=100. Local views default to the LA-area series because its published geography matches the two-county focus. Regional-cycle comparisons default to the U.S. series so every selected metro uses the same deflator. Users may select either series when viewing real values.

The pipeline constructs a complete monthly calendar and preserves an unavailable official observation as `null`; it does not interpolate or carry CPI forward. Consequently, real housing observations end with the latest month for which both the housing measure and selected CPI exist. The local index has a smaller sample and can be more volatile than the national index, so year-over-year inflation is emphasized over month-to-month change.

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

A provider release is rejected unless all required files stream or download, date columns are ordered and sufficiently long, local coverage remains above conservative floors, and processed public data stays under its size guardrail. Zillow, Redfin, and BLS CPI use independent versioned directories and `latest.json` pointers, so a failure retains the prior release for that provider.

Data provided by Zillow Group and Redfin. This repository does not redistribute the complete provider files.

## Intended use and disclaimer

The application and filtered releases are provided for instruction and noncommercial academic research. They are not financial, investment, legal, valuation, or real-estate advice and should not be used for transaction decisions. Third-party data remain subject to their respective licenses and terms; this repository does not grant commercial-use rights to provider data.
