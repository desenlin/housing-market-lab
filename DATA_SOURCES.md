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

City and ZIP observations use Redfin's **rolling three-month** frequency. The period end date is used as the chart date. The pipeline starts in January 2018, which provides a pre-pandemic baseline while keeping national-file processing bounded.

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

Inventory and Hotness have separate `latest.json` pointers under `public/data/realtor/` because the two files may be released in different weeks. The interface labels the latest month for the selected metric rather than implying a common Realtor.com vintage. Each product retains its current validated release and one rollback.

The national historical files are large, so the updater performs an HTTP metadata check before retrieval. When a file changes, it is streamed once and never written to disk; only selected ZIP rows from January 2018 onward are held in memory. The full source must be reread after a change because Realtor.com reissues and may restate historical observations rather than publishing an append-only series.

Rows with a nonzero `quality_flag` remain in the compact release so that the historical series is not fragmented. Their month indexes are stored separately and surfaced in charts, rankings, maps, and coverage summaries as observations requiring review. A source schema change, fewer than 150 covered local ZIPs, a short history, or a processed product above 5 MB rejects that product's prospective release while leaving its prior pointer unchanged.

The public application attributes the data to **Realtor.com® Economic Research** and links to the provider's Data Library and [Market Hotness methodology](https://www.realtor.com/research/reports/hottest-markets/). Market Hotness is a relative measure based on listing attention and market speed; it is not a probability of sale and should not be interpreted as a matched-market comparison with Redfin.

## Consumer Price Index

The independent CPI pipeline uses official [BLS bulk time-series files](https://download.bls.gov/pub/time.series/cu/): `cu.data.10.OtherWest`, `cu.data.1.AllItems`, `cu.data.11.USFoodBeverage`, `cu.data.12.USHousing`, `cu.data.14.USTransportation`, and `cu.data.20.USCommoditiesServicesSpecial`. Each file is retrieved once per run, then only the configured series are retained. The [Public Data API](https://www.bls.gov/developers/) is a fallback for failed bulk groups, batched into at most 25 series and ten-year windows. No FRED mirror or paid API is required. Twenty series over 2000–2026 require three batched API requests if every bulk source is unavailable.

| Category | Los Angeles area | U.S. city average |
|---|---|---|
| Headline CPI | `CUURS49ASA0` | `CUUR0000SA0` |
| Core CPI | `CUURS49ASA0L1E` | `CUUR0000SA0L1E` |
| Food | `CUURS49ASAF1` | `CUUR0000SAF1` |
| Groceries | `CUURS49ASAF11` | `CUUR0000SAF11` |
| Dining out | `CUURS49ASEFV` | `CUUR0000SEFV` |
| Energy | `CUURS49ASA0E` | `CUUR0000SA0E` |
| Gasoline | `CUURS49ASETB01` | `CUUR0000SETB01` |
| Shelter | `CUURS49ASAH1` | `CUUR0000SAH1` |
| Tenant rent | `CUURS49ASEHA` | `CUUR0000SEHA` |
| Excluding shelter | `CUURS49ASA0L2` | `CUUR0000SA0L2` |

All selected series are monthly CPI-U, not seasonally adjusted, with an index reference base of 1982–84=100. The retained history begins January 2000. The `la` and `us` keys remain the headline all-items series used for existing nominal/real housing views and CPI overlays; component series use explicit area/category keys.

**Regional inflation** is a data lens within **Prices & Rents**, alongside Zillow values and rents. It supports comparison across spending categories within an area and comparison of a single category between LA and the United States. Up to five categories can be selected or deselected. Annual inflation is `CPI[t] / CPI[t-12] - 1`; cumulative change is `CPI[t] / CPI[base] - 1`. The chart window crops observations without changing the cumulative base. The snapshot uses the most recent month officially observed in every included series, avoiding comparisons of different release months. Calculations use unrounded index observations, with percentages rounded only for display. Year-over-year change uses calendar months, not the previous twelve nonmissing observations.

Headline CPI includes food and energy. Core excludes both but includes shelter. Groceries and dining are components of food; gasoline is part of energy. These overlapping inflation rates cannot be summed as contributions to headline inflation. Shelter measures housing services including rental equivalence for owners, not home-purchase prices or mortgage payments. Tenant rent includes existing rental agreements and is not interchangeable with Zillow observed asking rents. Separate local electricity and natural-gas indexes ended in December 2024, while the broad energy index continues; see the [BLS utility-series notice](https://www.bls.gov/regions/west/news-release/averageenergyprices_losangeles.htm).

The current LA-area index covers Los Angeles and Orange counties together, matching the Lab's focus, but provides no distinct county, city or ZIP-code inflation rates. Before the [2018 geographic revision](https://www.bls.gov/cpi/additional-resources/geographic-revision-2018.htm), its continuous historical series covered the broader Los Angeles–Riverside–Orange County area. Long comparisons cross this geography change. CPI tracks price changes within an area, not differences in absolute price levels between places. Local samples are smaller than the national sample, and the indexes are not seasonally adjusted; year-over-year rates are the default.

The pipeline constructs complete monthly calendars and preserves unavailable observations as `null`. Most selected series lack October 2025 because of the [2025 federal appropriations lapse](https://www.bls.gov/cpi/additional-resources/2025-federal-government-shutdown-impact-cpi.htm), while gasoline observations remain available. Missingness is series-specific. Inflation charts never interpolate or carry observations forward, and a missing comparison month also leaves the corresponding year-over-year change unavailable. For **derived real housing calculations only**, the application fills the October 2025 headline CPI gap with the geometric midpoint of September and November CPI (log-linear interpolation). No other missing or trailing observation is filled; unmatched newer housing months remain unavailable in real terms.

CPI shares one independent, validated release pointer for all twenty series. Its manifest records each series identifier, observation coverage, missing months, source URL, retrieval method, and source-content fingerprint (SHA-256 of decoded bulk text or canonical API JSON), plus the chart-ready bundle fingerprint. All required series must pass history, schema and size checks before publication. Unchanged data retain the current release; a failed update retains the previous validated release. The site exposes series coverage and source fingerprints in **Data & methods → Current release provenance** and retains one rollback release. Raw national files are not committed.

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

The interface uses **Monthly estimates** for open-year observations, **Historical monthly estimates** for older local monthly records, and **Final annual totals** for annual data. Per [Census methodology](https://www.census.gov/construction/bps/methodology.html), cumulative local files incorporate late reports and corrections, but local monthly observations are not benchmarked to final annual totals. Historical monthly files preserve the observations available at annual release and may not sum to the annual totals. Question-mark definitions explain this distinction; Census-imputed flags remain visible where published totals include estimated activity. Market Brief uses a neutral monthly-estimates badge and retains preliminary/revision caveats in evidence details.

The geographic unit is the permit-issuing jurisdiction, not every Census place. The current reference contains 122 incorporated cities and the Los Angeles County and Orange County unincorporated-area aggregates. Census-designated places such as Rossmoor do not receive a separate BPS observation: their map boundaries are labelled as included in the appropriate county unincorporated total and are never assigned a duplicated county value. County totals shown in the interface sum incorporated jurisdictions plus the unincorporated aggregate.

Modern records are joined by five-digit Census place FIPS. Older BPS identifiers were reused as the permitting universe changed, so legacy rows are joined by county and a normalized jurisdiction name instead of treating the raw six-digit BPS identifier as stable. Unit tests preserve this rule. The normalization denominator is the configured ACS five-year table `B25001` (total housing units); the unincorporated denominator is the county estimate less the included incorporated-place estimates.

Permit history and open years have independent atomic pointers. A routine check discovers the newest cumulative revised monthly file and rebuilds only the provisional bundle. New final annual years are detected automatically. Quarterly revision checks in January, April, July, and October re-fetch historical files and the configured ACS inputs even when the final annual year is unchanged. Any history rebuild also rebuilds open-year monthly data using the same reference inputs. Unchanged content keeps its release identifier. Coverage must remain at 89 Los Angeles County jurisdictions and 35 Orange County jurisdictions, duplicate jurisdiction-dates are rejected, and compact history/provisional releases are capped separately before publication. Legacy history metadata such as `latest_final_month` and the monthly bundle’s `Final` status identify membership in the historical release; they do not establish local monthly benchmarking. Existing release identifiers and observation values are preserved when display terminology changes.

## American Community Survey housing context

The ACS layer is deliberately limited to six measures that help interpret housing demand, affordability, and stock. It is not a general demographic-variable browser.

| Display measure | ACS detailed table | Construction |
|---|---|---|
| Median household income | `B19013` | Published median and MOE |
| Renter-occupied share | `B25003` | Renter-occupied ÷ occupied units |
| Rent-burdened households | `B25070` | Gross rent at least 30% of income ÷ cash-rent units with burden computed |
| Average household size | `B25010` | Published average and MOE |
| Median age | `B01002` | Published median and MOE |
| Housing in 5+-unit structures | `B25024` | Units in structures with at least five units ÷ all housing units |

The current cross-section uses the latest ACS five-year estimates for every mapped city, Census-designated place, and ZCTA in Los Angeles and Orange Counties. Estimates and Census-published 90% margins of error are retained together. Derived sums combine component variances; derived shares use the Census approximation for a numerator contained within its denominator. Values with large relative margins of error remain visible and are identified in the interface rather than silently suppressed.

City/community structural change compares adjacent **non-overlapping** periods—for the initial release, 2015–2019 and 2020–2024. A difference is identified as statistically distinguishable when its absolute value exceeds the combined 90% margin of error. Consecutive five-year releases are not plotted as annual observations because they share four collection years. Prior-period household income and its MOE are converted to latest-vintage dollars using the ratio of annual-average U.S. CPI-U. ZCTA change is not shown because the comparison spans different ZCTA boundary vintages; ZIP-level use is limited to the latest cross-section.

ACS updates are isolated from the monthly provider workflow. A small job checks for the next table-based five-year vintage during the December–February release window. If it is absent, December and January checks stop without querying estimates. February and explicit manual revision checks also re-fetch the existing vintage. HTTP 404/410 means absent; other availability errors are surfaced, with transient failures retried up to three times. When retrieval is required, three keyed Census API calls retrieve only the selected raw fields: prior-period California places, current California places, and current California ZCTAs. Filtering against the existing map reference reduces the public release to local estimates and MOEs, currently about 270 KB. Map geometry is never duplicated. Validation requires broad local coverage, a non-overlapping five-year comparison, a sub-1 MB release, and an atomic pointer update; one rollback is retained.

## California HCD housing delivery

Housing Supply keeps Census BPS permit activity separate from California HCD APR housing delivery. HCD includes categories outside BPS coverage; the two permit measures are never spliced, added or substituted. Annual permits and completions are flows from different project cohorts, not a completion probability or measured backlog.

Source: [APR data and dictionaries](https://data.ca.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year), Table A2; [reporting instructions](https://www.hcd.ca.gov/apr/forms). `JURIS_NAME`, `CNTY_NAME`, `YEAR`, and `UNIT_CAT` identify jurisdiction-year-type groups. `NO_BUILDING_PERMITS` and `NO_OTHER_FORMS_OF_READINESS` measure housing units permitted and ready for occupancy, not document counts. BP/CO income components distinguish deed-restricted and non-deed-restricted units. New acutely/extremely low categories are included alongside the remaining very-low category; the legacy `EXTR_LOW_INCOME_UNITS` subset is not added again. Affordability detail is withheld where components do not reconcile. ADUs remain separate from other structure types.

The public DataStore executes bounded, county-filtered aggregate queries grouped additionally by development-stage year. Field batches must have identical keys and record counts; source modification metadata is rechecked after retrieval. Numeric parse failures, truncated responses, unmapped jurisdictions, or inadequate coverage reject a candidate. Addresses, parcel identifiers, project names and statewide raw files are not published. Records are not deduplicated by project ID: separate phases, housing types and years may legitimately share identifiers. These are aggregations of published records, not an independent project census.

Stage dates matching the reporting year are included. Positive stage counts dated outside that year are excluded; undated counts remain with a flag. Quality counters summarize affected aggregate groups, except missing-total counters which count records. Missing/invalid totals make the jurisdiction-year stage unavailable. No-row jurisdiction-years are null, not zero. Observed zeroes refer only to available records; A2 alone cannot establish whether a locality submitted a complete zero-activity report. County jurisdictions cover unincorporated areas; CDPs receive no separately assigned county values. Previously observed jurisdiction-years disappearing from a replacement snapshot trigger review.

The trend shows reported annual observations without smoothing, with up to five jurisdictions selected. Completions per 1,000 housing units reuse the dated ACS stock denominator in the BPS layer. These are production intensity measures, not net stock growth. Completion is readiness for occupancy, not actual occupancy; demolition counts are not subtracted.

Checks run in July and October, with manual execution available. Current-calendar-year APRs are excluded. Local history is rebuilt when the source changes to incorporate revisions. Source metadata and calculation inputs are checked before retrieval; identical local content retains the existing release. Current and one rollback release live under `public/data/hcd/`; each release is capped at 1 MB and subject to the existing 25 MB public-data budget before publication. Failed candidates leave the current pointer untouched.

## Census cartographic boundaries

- 2025 California Places, 1:500,000 cartographic boundary file
- 2025 US Counties, 1:500,000 cartographic boundary file
- 2025 California Places Gazetteer internal points
- 2020 national ZCTAs, 1:500,000 cartographic boundary file

The city/community map retains every Census place assigned to Orange or Los Angeles County, including Census-designated places in unincorporated territory. A place without a current observation for the selected provider and metric remains visible in gray and is labelled **No data** rather than being absorbed into a neighboring city. Unshaded basemap areas are outside the displayed Census place geography—typically county remainder, wilderness, or open space—and are not classified as missing city-level observations. The pipeline uses each place's official Census internal point and county polygons to make the county assignment.

The pipeline matches place names or five-digit ZCTA codes to provider regions and publishes compact GeoJSON boundaries. ZCTAs approximate—but do not exactly reproduce—USPS delivery ZIP codes. Maps are selection and pattern-finding aids; the chart values come from the provider records, not from the boundary files.

## OpenStreetMap

The interactive maps request the standard OpenStreetMap tile layer at `https://tile.openstreetmap.org/{z}/{x}/{y}.png` only for the area and zoom level a visitor views. No tile archive or background area download is created. Visible attribution is retained on every map.

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

A provider release is rejected unless all required files stream or download, date columns are ordered and sufficiently long, local coverage remains above conservative floors, and processed public data stays under its size guardrail. Zillow, Redfin, Realtor.com Inventory, Realtor.com Hotness, BLS CPI, ACS context, HCD annual delivery, permit history, provisional permit years, and Census map geometry use independent versioned directories and `latest.json` pointers, so a failure retains the prior release for that provider or product. County-level sharding keeps generated JSON objects below 1 MB, and every release family keeps only the current version plus one rollback.

Public provenance uses **Data checks completed [date]** consistently across providers, including monthly permits. This date records acceptance after checks of source files, data structure, dates, coverage, and calculation inputs. It is not a measure of statistical reliability, an independent verification of every reported observation, or a guarantee against revisions. Internal `validated` and `preliminary` fields support release processing and revision disclosures; Market Brief does not present them as competing reliability grades. Archived brief wording and evidence vintages remain unchanged.

Before publication, each updater merges the new local extract with the current validated history. A prior value is retained when its date is absent from the new provider file, protecting the lab if an upstream full-history file becomes a rolling window. For dates that remain in the new file, the new value—including revisions or an explicit missing observation—is authoritative. Building-permit history follows the same principle and can append a newly final year without re-downloading the complete 1980-present archive. The detailed rules and recovery hierarchy are documented in [Storage and historical continuity](STORAGE_DESIGN.md).

Provider release timing is intentionally decoupled, and source families follow independent release-window checks. A newer CPI release does not require a simultaneous Zillow release, and a newer Zillow release does not wait for CPI. Nominal housing observations remain available through Zillow's latest validated month. Constant-dollar levels and real changes use exact matched months except for the disclosed October 2025 log-linear deflator interpolation. Inflation overlays use only official CPI observations. Unmatched newer housing months remain unavailable in real terms until BLS publishes the corresponding CPI observation.

Data provided by Zillow Group, Redfin, and Realtor.com® Economic Research. Complete provider source files are not retained or published. See [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md) for source-specific attribution and reuse limits.

## Intended use and disclaimer

The application and filtered releases are provided for instruction and noncommercial academic research. They are not financial, investment, legal, valuation, or real-estate advice and should not be used for transaction decisions. Third-party data remain subject to their respective licenses and terms; this repository does not grant reuse or commercial-use rights to provider data.

## Automated checks and reference review

Four GitHub Actions workflows cover all current data families. The monthly Pages workflow refreshes Zillow, Redfin, Realtor.com, all twenty BLS CPI series, and Census BPS on the 12th, 18th, 24th, and 28th. ACS and HCD keep independent annual schedules. The fourth workflow prepares market-brief drafts for review after a successful Pages run.

Freshness is evaluated from each series' observation date, separately from its processing date and source revision status. `config/data_health_policy.json` contains conservative monitoring thresholds: Zillow and Redfin after the 28th (Zillow sale-to-list receives one extra month), Realtor inventory after the 18th, Hotness after the 24th, and annual thresholds appropriate to ACS, HCD, and final annual permits. For CPI and local monthly BPS, known release dates override the fallback thresholds and receive one calendar day of grace. Current overrides come from the [BLS CPI calendar](https://www.bls.gov/schedule/news_release/cpi.htm) and [Census BPS calendar](https://www.census.gov/construction/bps/schedule.html), reviewed September 20, 2026. Outside the reviewed calendar, fallback alerts begin on the 25th for CPI and at month-end for local permits. These are maintainer alert policies, not official release guarantees; announced delays should be recorded as dated overrides.

One failed provider check is shown as a warning. Repeated failures (two consecutive attempted runs), missing/overdue observation coverage, or failure of every provider attempted in a run produces a failed health check. Deployment can still publish releases that pass validation. A successful no-change provider check resets its failure streak; a deployment-only run neither resets nor increments it. Monitoring state is bounded to one record per provider in `.github/data-update-state.json`, outside the published data. Alerts are GitHub Actions annotations and summaries; no automated issues or external messages are sent. A failing Pages health check also pauses automatic market-brief draft preparation.

Same-vintage ACS corrections are checked in February, with a manual option available. BPS history is re-fetched during the January, April, July, and October 28 runs; corrected overlapping observations replace prior values, while archived dates missing from a truncated download remain preserved. HCD already rebuilds changed source snapshots and checks for historical coverage loss. All retain content fingerprints and one rollback; a check with unchanged observations does not create a new data release.

An annual reference-review reminder appears in the existing health summary when due. The current review covers 2025 place/county/Gazetteer references, 2020 ZCTA boundaries, metro population ranks dated July 1, 2025, and the configured 2024 ACS stock denominator. New ACS housing-context vintages do not automatically change that denominator. A decision to change it must rebuild annual and monthly permit rates consistently, refresh affected HCD calculation inputs, and update the methods and provenance. The next review is January 15, 2027; maintainers also refresh release-calendar overrides and record the next review date in the monitoring policy.
