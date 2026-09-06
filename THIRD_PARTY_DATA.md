# Third-party data, licensing, and attribution

Housing Market Lab combines original software and educational material with external data. The repository's MIT and CC BY 4.0 licenses apply only to the project-authored materials identified in [README.md](README.md) and [LICENSE](LICENSE). They do **not** license the data, geographic boundaries, map tiles, provider names, logos, or trademarks described below.

The compact files under `public/data/` are filtered and transformed for this instructional application. Their presence in a public repository does not grant downstream users permission to reproduce, redistribute, sell, sublicense, or use the underlying third-party material. Anyone reusing those files must independently comply with the applicable provider terms and obtain permission where required.

## Zillow Research

- **Material used:** Zillow Home Value Index (ZHVI), Zillow Observed Rent Index (ZORI), and selected aggregate housing-market series.
- **Source:** [Zillow Research housing data](https://www.zillow.com/research/data/)
- **Guidance and terms:** [ZHVI User Guide](https://www.zillow.com/research/zhvi-user-guide/) and [Zillow Terms of Use](https://www.zillow.com/corporate/terms-of-use/)
- **Required project attribution:** Data provided by Zillow Group.

Zillow's terms permit specified uses of aggregate data and derivative displays when Zillow is cited, but they do not provide a general open-data license for all Research downloads. Do not assume that this repository can pass through broader redistribution or commercial-use rights.

## Redfin Data Center

- **Material used:** Selected rolling three-month city- and ZIP-level housing-market activity measures.
- **Source:** [Redfin Data Center downloads](https://www.redfin.com/news/data-center/downloads/)
- **Methodology:** [Redfin Data Center methodology](https://www.redfin.com/news/data-center/methodology/)
- **Terms:** [Redfin Terms of Use](https://www.redfin.com/about/terms-of-use)
- **Required project attribution:** Data provided by Redfin.

Redfin makes aggregate data available for download, but its general terms reserve reproduction and redistribution rights unless expressly permitted. The repository does not grant permission to republish Redfin data independently of this instructional application.

## Realtor.com Economic Research

- **Material used:** Selected monthly ZIP-level inventory and Market Hotness measures.
- **Source and attribution guidance:** [Realtor.com Real Estate Data Library](https://www.realtor.com/research/data/)
- **Terms:** [Realtor.com Terms of Use](https://www.realtor.com/terms-of-service/)
- **Required project attribution:** Realtor.com® Economic Research, with a link to its Data Library on digital properties.

The Data Library expressly provides downloads and attribution instructions, but it does not state a general open-data license. The repository therefore does not grant downstream redistribution or commercial-use rights. Provider quality flags and retrospective revisions should be reviewed before reporting individual ZIP observations.

## U.S. Bureau of Labor Statistics

- **Material used:** CPI-U All Items for Los Angeles–Long Beach–Anaheim and the U.S. city average.
- **Source:** [BLS CPI data](https://www.bls.gov/cpi/data.htm)
- **Copyright:** [BLS Copyright Information](https://www.bls.gov/opub/copyright-information.htm)
- **API terms:** [BLS Public Data API Terms of Service](https://www.bls.gov/developers/termsOfService.htm)
- **Attribution:** U.S. Bureau of Labor Statistics; release metadata record the retrieval date.

BLS-published material is public domain except for identified third-party photographs and illustrations. If an API fallback is used, the resulting release is subject to BLS citation and derived-analysis disclaimer requirements: BLS cannot vouch for data or analyses after retrieval.

## U.S. Census Bureau

- **Material used:** Census cartographic boundary files and geographic reference information.
- **Source:** [Census cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html)
- **Citation guidance:** [Citing Census data and geographic products](https://www.census.gov/about/policies/citation.html)
- **Attribution:** U.S. Census Bureau, with the boundary vintage recorded in [DATA_SOURCES.md](DATA_SOURCES.md).

Derived classifications and conclusions are the responsibility of Housing Market Lab and do not imply Census Bureau endorsement.

## OpenStreetMap

- **Material used:** Interactive contextual basemap tiles; tiles are not committed to this repository.
- **License and attribution:** [OpenStreetMap copyright and ODbL](https://www.openstreetmap.org/copyright)
- **Service policy:** [OpenStreetMap Foundation Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
- **Required attribution:** Map data © OpenStreetMap contributors, displayed on each interactive map.

OpenStreetMap data are licensed under ODbL. Standard tile-server access is a separate, best-effort service governed by its usage policy. The application requests only tiles actively viewed by visitors and does not bulk-download, prefetch, proxy, or archive them.

## Names, marks, and endorsement

Zillow, Redfin, Realtor.com®, OpenStreetMap, California State University, Fullerton, and other names and marks belong to their respective owners. They are used only to identify sources or institutional affiliation. Housing Market Lab is an independent academic project and is not endorsed by any data provider or by California State University, Fullerton.

Questions about downstream reuse should be directed to the relevant provider. Questions about Housing Market Lab's original code, teaching material, or citation should be directed to the project author through [desenlin.com](https://desenlin.com/).
