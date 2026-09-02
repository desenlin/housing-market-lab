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

## Census cartographic boundaries

- 2025 California Places, 1:500,000 cartographic boundary file
- 2020 national ZCTAs, 1:500,000 cartographic boundary file

The pipeline matches place names or five-digit ZCTA codes to provider regions and converts polygons into local SVG paths. ZCTAs approximate—but do not exactly reproduce—USPS delivery ZIP codes. Maps are selection and pattern-finding aids; the chart values come from the provider records, not from the boundary files.

## Transformations

- **Year over year:** `value[t] / value[t-12] - 1`
- **Indexed:** `100 × value[t] / first_nonmissing_value`
- **Price–rent multiple:** `ZHVI[t] / (12 × ZORI[t])`

The derived price–rent multiple compares a typical value index with an observed-rent index. It is an educational market indicator, not a capitalization rate, investment return, or matched-property valuation.

## Release checks

A release is rejected unless all required files download, date columns are ordered and sufficiently long, local coverage remains above conservative floors, and the processed public data remains under 50 MB. The prior `latest.json` pointer stays in place on failure.

Data provided by Zillow Group. This repository does not redistribute the complete provider files.
