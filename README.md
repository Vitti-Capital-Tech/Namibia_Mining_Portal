# Namibia Mining Portal

Screen, score and shortlist **4,328 Namibian mineral licences** (4,113 EPLs + 214 Mining Licences) for 13 minerals on one map, then generate a desktop study for any licence.

## Features

- **Licence map.** All exclusive prospecting licences (EPLs) and mining licences (MLs) in the cadastre extracts: 1,212 active, 696 applications and 2,420 inactive. Filter by licence type; MLs have a thick outline. Polygons are coloured by status. **Hover** a licence for its number, holder, status, area and commodity groups. **Click** it for full details.
- **Licence detail.** Holder (with portfolio size), dates, expiry position, region, area, mineral belts (% of licence), the 5 nearest relevant deposits, infrastructure distances and the score breakdown.
- **Recommend tab** (13 target minerals: Gold, Silver, Copper, Zinc, Lead, Uranium, Lithium, Tin, Tantalum, Rare Earths, Manganese, Graphite, Diamonds):
  - *Licences*: ranks every licence whose commodity groups cover the mineral, on geology, nearby deposits, rail, port and tenure.
  - *Known mines*: ranks the 29 curated mines and projects.
  - *Open ground*: finds ~27 km cells inside prospective belts that are **not** covered by an active licence or application, and are outside protected areas.
  - Live weight sliders let users tune the model.
- **Shortlist.** Star (☆) licences anywhere. The shortlist is saved in the browser, can be exported to CSV, and produces a printable **Shortlist report**.
- **Desktop study.** A printable, self-contained report per licence (Print → Save as PDF) covering summary, location map, tenure and holder, geology, nearby deposits, infrastructure, score breakdown and next steps.
- **Deep links.** `/#EPL-5204` opens a licence directly.
- **Context layers.** Mineral belts (schematic), rail, ports and towns, protected areas, regions, 70 USGS deposits, and 29 curated mines.

## Data sources

| Dataset | Source | Notes |
|---|---|---|
| `licences.geojson` | MME Landfolio cadastre extracts, published **public domain** on the Benguela Current Commission GeoNode: [EPLs](https://geodata.benguelacc.org/layers/geonode:NAM_CSR_GREE_Explo_Pros_Lice), [Mining Licences](https://geodata.benguelacc.org/layers/geonode_deploy_data:geonode:NAM_CSR_GREE_mining_licence_Sept2020) | **Snapshot 3 Sep 2020.** Commodities are broad groups (Base & Rare Metals, Precious Metals…) |
| `occurrences.geojson` | [USGS MRDS](https://mrdata.usgs.gov/mrds/) | 70 Namibian deposits. No longer actively updated |
| `sites.geojson` | Curated from public company and press information | 29 mines and projects, approximate coordinates |
| `belts.geojson`, `infrastructure.geojson` | Hand-drawn | **Schematic**, for screening only |
| `namibia_*.geojson` | [geoBoundaries](https://www.geoboundaries.org) | CC BY 4.0 |

Rebuild licences and deposits with `npm run data` (uses the cache in `data-raw/`) or `npm run data:refresh` (downloads again).

### Updating to current licence data

The public 2020 extracts are the newest open, machine-readable copies we could find. Newer data has to be fetched by a person:

| Where | What | Why it can't be automated |
|---|---|---|
| Ministry of Industries, Mines and Energy, **Earth Data Namibia** (mime.gov.na; the old mme.gov.na no longer resolves) | Monthly *mineral licence shapefiles* (2024–2026 listed) and licence-list PDFs | The site sits behind a bot-protection challenge; it works in a normal browser |
| Cadastre map portal (portals.landfolio.com/namibia) | Live licences | Its data services need an access token; request a data export or API access from the Ministry |

Once you have a shapefile (zip) or GeoJSON:

```bash
pip install -r scripts/requirements.txt          # once: pyshp + pyproj
python scripts/build_data.py --licences data-raw/<downloaded>.zip --snapshot 2026-11-01
npm test && npm run build
```

The importer reprojects any `.prj` coordinate system (e.g. UTM 33S) to WGS84. It accepts the usual Landfolio field names (including 10-character shapefile truncations and day-first dates), derives the status group from the status text when no group column exists, and keys licences by number so existing shortlists survive the refresh.

## Tech stack

Vite 6 · Leaflet 1.9 (single canvas renderer for ~4k polygons) · vanilla JS modules · Node test runner · Python 3 data pipeline · Vercel hosting.

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # scoring + data integrity tests
npm run build     # production build -> dist/
```

**Deploy:** import the GitHub repo on vercel.com (Vite is auto-detected), or run `vercel --prod`.

## Scoring model (licences)

Each factor is scored 0–1. The score is the weighted average × 100. Scores are halved inside protected areas.

| Factor | Default weight | Computation |
|---|---|---|
| Geology / belt | 35 | Share of the licence (centroid + boundary samples) inside belts prospective for the mineral |
| Nearby deposits | 25 | Linear decay to 0 at 75 km from the nearest known deposit of the mineral |
| Rail access | 15 | Linear decay to 0 at 150 km |
| Port access | 10 | Linear decay to 0 at 600 km (Walvis Bay, Lüderitz) |
| Tenure status | 15 | Active 1.0 · Application 0.6 · Inactive 0.3 |

A licence qualifies for a mineral when one of its commodity groups covers it (e.g. Gold → Precious Metals, Uranium → Nuclear Fuel, Diamonds → Precious Stones).

## Project structure

```
src/main.js        map, layers, UI, shortlist
src/scoring.js     scoring + ranking (pure, tested)
src/report.js      desktop study + shortlist reports (HTML/SVG)
src/geo.js         geometry helpers
src/util.js        formatting, CSV, expiry logic
scripts/build_data.py   licence + MRDS pipeline
public/data/       GeoJSON served to the browser
tests/             node --test
```

## Roadmap

1. **Refresh licence data.** Import the Ministry's latest monthly licence shapefile (see *Updating to current licence data*), or request API access to the cadastre portal from the Ministry.
2. **Specific commodities.** Replace commodity groups with the actual minerals listed on each licence.
3. **Geology.** Swap the schematic belts for Geological Survey of Namibia maps and mineral occurrences.
4. **Deal Intelligence.** Comparable transactions database (acquirer, target, stake, price, stage, commodity) and an indicative value per licence (e.g. EV per km² or per resource unit from comparables).
5. **News feed** per licence and holder (serverless function + RSS).
