# Housing Market Lab

[![Validate data and deploy Pages](https://github.com/desenlin/housing-market-lab/actions/workflows/pages.yml/badge.svg)](https://github.com/desenlin/housing-market-lab/actions/workflows/pages.yml)
[![MIT licensed code](https://img.shields.io/badge/code-MIT-12355b.svg)](LICENSE)
[![CC BY 4.0 educational content](https://img.shields.io/badge/content-CC%20BY%204.0-ff7a1a.svg)](https://creativecommons.org/licenses/by/4.0/)

Interactive housing-market analytics for instruction and exploratory academic research. The current release focuses on city/community and ZIP-level observations in Orange and Los Angeles counties, with a separate metropolitan comparison view.

**Live application:** <https://desenlin.com/housing-market-lab/>

Created by **[Desen Lin](https://desenlin.com/)**, California State University, Fullerton.

## What the application provides

- Zillow Home Value Index (ZHVI) and Zillow Observed Rent Index (ZORI)
- A derived price–rent multiple
- Redfin months of supply, median days on market, sales above original list, price-drop share, and median sale price per square foot
- Explicit source and reporting-window labels, with hover/focus definitions for market concepts
- Current levels and explicitly labeled changes from one year earlier
- User-selected one-, three-, and five-year or maximum chart windows
- Indexed comparisons with a user-selected starting month
- City/community and ZIP rankings sortable by current value or 12-month growth
- Interactive OpenStreetMap context maps with pan, zoom, automatic county fitting, hover details, gray **No data** boundaries, and a separate legend state for land outside city/CDP geography
- Metro inventory, days to pending, price-cut share, and sale-to-list comparisons

The application is a static Next.js/Vinext export. It uses no database, paid API, paid map service, or continuously running server. Google Analytics measures aggregate traffic using the same property as the academic website.

## Data sources and references

- [Zillow Research housing data](https://www.zillow.com/research/data/) supplies the market time series.
- [Redfin Data Center](https://www.redfin.com/news/data-center/downloads/) supplies local listing and transaction activity in rolling three-month windows.
- [US Census Bureau cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) supply place and ZCTA boundaries.
- [OpenStreetMap](https://www.openstreetmap.org/copyright) supplies contextual basemap tiles. Map data © OpenStreetMap contributors.

Definitions, transformations, boundary vintages, coverage rules, and provider caveats are documented in [DATA_SOURCES.md](DATA_SOURCES.md). Provider data are redistributed only as compact, geographically filtered, chart-ready releases rather than complete source files.

## Reproducible release architecture

```mermaid
flowchart TD
  A[Zillow Research] --> C[Zillow pipeline]
  B[Redfin Data Center] --> D[Redfin pipeline]
  C --> E[Zillow release pointer]
  D --> F[Redfin release pointer]
  E --> G[Static interactive site]
  F --> G
  G --> H[GitHub Pages and Sites]
```

Raw source files are temporary. Zillow releases live in `public/data/releases/<release-id>/`; Redfin releases live independently in `public/data/redfin/releases/<release-id>/`. Each provider has its own `latest.json` pointer, and a pointer changes only after that source's schema, date, coverage, and size checks succeed.

The Pages workflow runs on pushes, manual dispatch, and two monthly refresh attempts. A failed provider download or validation does not replace that provider's prior working release or prevent the other provider from refreshing.

## Local development

Requirements: Node 24+, Python 3.11+, and npm.

```bash
npm run install:ci
python -m pip install -r requirements.txt
python pipeline/update_data.py
python pipeline/update_redfin.py
npm run dev
```

For repeated Zillow pipeline development, `--cache-dir .cache/zillow` reuses local downloads. The Redfin pipeline streams national CSVs and retains only configured dates and the two-county Census-place/ZIP geography list; it never stores full raw downloads.

Build and test:

```bash
npm run lint
npm test
python -m unittest discover tests
```

GitHub Pages must use **GitHub Actions** as its deployment source in repository **Settings → Pages**.

## Citation

Please cite the application when it is used in instruction, research, or derivative work:

> Lin, D. (2026). *Housing Market Lab* [Computer software]. https://desenlin.com/housing-market-lab/

GitHub also provides structured citation metadata from [CITATION.cff](CITATION.cff) through the repository’s **Cite this repository** control. For a reproducible empirical reference, report the release identifier and bundle fingerprint displayed under **Data & methods** in the application.

## Academic-use disclaimer

This project is provided for instruction and academic research. It is not financial, investment, legal, valuation, or real-estate advice and should not be relied on for transactions or commercial decision-making.

The filtered data releases are intended for instructional and noncommercial academic-research use. Zillow, Redfin, Census, and OpenStreetMap data remain subject to their respective provider licenses and terms. This repository does not grant commercial-use rights to third-party data or imply endorsement by any provider or California State University, Fullerton.

## Licenses and attribution

The original software code in this repository is licensed under the [MIT License](LICENSE). Original educational content is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), unless otherwise noted. When reusing or adapting original project materials, credit Desen Lin and link to this repository.

Third-party data, cartographic boundaries, institutional names, and trademarks are excluded from those licenses. Data provided by Zillow Group and Redfin. Map data © OpenStreetMap contributors.
