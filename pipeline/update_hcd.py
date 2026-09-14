#!/usr/bin/env python3
"""Bounded HCD APR release. Aggregate in the public DataStore, never mirror records.

No-row jurisdiction-years remain null: A2 alone cannot certify zero activity.
Historical stages are counted only in their dated reporting year; missing dates
retain reported counts with a quality flag. No project-identifier deduplication
is attempted: projects legitimately have multiple phases, types and years.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from pipeline.storage import atomic_write, compact_json
except ModuleNotFoundError:
    from storage import atomic_write, compact_json

ROOT = Path(__file__).resolve().parents[1]
API = "https://data.ca.gov/api/3/action/"
INCOMES = ["ACUTELY_LOW_INCOME_DR", "ACUTELY_LOW_INCOME_NDR",
           "EXTREMELY_LOW_INCOME_DR", "EXTREMELY_LOW_INCOME_NDR",
           "VLOW_INCOME_DR", "VLOW_INCOME_NDR", "LOW_INCOME_DR",
           "LOW_INCOME_NDR", "MOD_INCOME_DR", "MOD_INCOME_NDR", "ABOVE_MOD_INCOME"]
STAGES = {"permits": ("BP", "NO_BUILDING_PERMITS", "BP_ISSUE_DT1"),
          "completions": ("CO", "NO_OTHER_FORMS_OF_READINESS", "CO_ISSUE_DT1")}
TYPES = {"SFD": "Single-family detached", "SFA": "Single-family attached",
         "2-4": "2–4 units", "5+": "5+ units", "ADU": "Accessory dwelling units",
         "MH": "Manufactured housing", "Other": "Other / unspecified"}


def request(action, **params):
    url = API + action + "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": "HousingMarketLab/1.0 (academic research; desenlin.com)"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        raw = response.read(8_000_001)
    if len(raw) > 8_000_000:
        raise ValueError("HCD response exceeded transfer budget")
    result = json.loads(raw)
    if not result.get("success"):
        raise ValueError("HCD API rejected request")
    return result["result"]


def numeric(field):
    # Malformed numeric text rejects the query; it is never silently zero-filled.
    return f'COALESCE(NULLIF("{field}",\'\')::numeric,0)'


def query(config, fields):
    required = {"CNTY_NAME", "JURIS_NAME", "YEAR", "UNIT_CAT"}
    required |= {v for stage in STAGES.values() for v in stage[1:]}
    required |= {f"{prefix}_{income}" for prefix, _, _ in STAGES.values() for income in INCOMES}
    if not required <= set(fields):
        raise ValueError(f"HCD schema changed; missing {sorted(required-set(fields))}")
    keys = ['"CNTY_NAME"', '"JURIS_NAME"', '"YEAR"', '"UNIT_CAT"',
            'left("BP_ISSUE_DT1",4) AS bpyear', 'left("CO_ISSUE_DT1",4) AS coyear', 'count(*) AS records']
    columns = []
    for stage, (prefix, total, _) in STAGES.items():
        columns.append(f'SUM("{total}"::numeric) AS {stage}')
        columns.append(f'count(*)-count("{total}") AS {stage}_missing_total')
        columns.append(f'MIN("{total}"::numeric) AS {stage}_minimum')
        for index, income in enumerate(INCOMES):
            field = f'{prefix}_{income}'
            columns.append(f'SUM("{field}"::numeric) AS {stage}_i{index}')
            columns.append(f'MIN("{field}"::numeric) AS {stage}_min_i{index}')
    counties = ','.join("'" + c.replace("'", "''") + "'" for c in config["counties"])
    suffix = (f' FROM "{config["resource_id"]}" WHERE "CNTY_NAME" IN ({counties}) '
              f'GROUP BY "CNTY_NAME","JURIS_NAME","YEAR","UNIT_CAT",bpyear,coyear '
              f'LIMIT {config["max_result_rows"]}')
    queries, current = [], keys.copy()
    for expression in columns:
        candidate = 'SELECT ' + ', '.join(current+[expression]) + suffix
        if len(urllib.parse.urlencode({'sql': candidate})) > 1800 and len(current) > len(keys):
            queries.append('SELECT ' + ', '.join(current) + suffix)
            current = keys.copy()
        current.append(expression)
    queries.append('SELECT ' + ', '.join(current) + suffix)
    return queries


def retrieve(config, fields, fetch=request):
    merged = None
    for index, sql in enumerate(query(config, fields)):
        print(f'  aggregate field batch {index+1}', flush=True)
        result = fetch('datastore_search_sql', sql=sql)
        rows = result['records']
        if result.get('records_truncated') or len(rows) >= config['max_result_rows']:
            raise ValueError('HCD aggregate response truncated')
        keyed = {(r['CNTY_NAME'], r['JURIS_NAME'], r['YEAR'], r['UNIT_CAT'], r['bpyear'], r['coyear']): r for r in rows}
        if len(keyed) != len(rows):
            raise ValueError('Duplicate aggregate keys')
        if merged is None:
            merged = keyed
        else:
            if merged.keys() != keyed.keys():
                raise ValueError('HCD aggregate batches have different coverage')
            for key, row in keyed.items():
                if row['records'] != merged[key]['records']:
                    raise ValueError('HCD row counts changed during retrieval')
                merged[key].update(row)
    rows = list((merged or {}).values())
    for row in rows:
        for stage, (prefix, _, _) in STAGES.items():
            stage_year = row[prefix.lower()+'year']
            active = not stage_year or stage_year == row['YEAR']
            total = float(row[stage] or 0)
            row[stage+'_invalid'] = int(min([float(row.get(stage+'_minimum') or 0)] + [float(row.get(f'{stage}_min_i{i}') or 0) for i in range(len(INCOMES))]) < 0) if active else 0
            row[stage+'_undated'] = int(not stage_year and total > 0)
            row[stage+'_outside_year'] = int(not active and total > 0)
            parts = [float(row[f'{stage}_i{i}'] or 0) for i in range(len(INCOMES))]
            row[stage+'_mismatch'] = int(active and sum(parts) != total)
            row[stage] = total if active else 0
            row[stage+'_missing_total'] = int(row[stage+'_missing_total']) if active else 0
            for i, value in enumerate(parts):
                row[f'{stage}_i{i}'] = value if active else 0
    return rows


def reference(root):
    folder = root / 'public/data/permits/history'
    release = json.loads((folder/'latest.json').read_text())["release"]
    return json.loads((folder/'releases'/release/'annual.json').read_text())["regions"]


def build(rows, regions, config, end_year):
    lookup = {}
    for region in regions:
        county = region["county"].removesuffix(" County")
        key = (county, county.upper()+" COUNTY" if region["jurisdiction_type"] == "county_unincorporated" else region["name"].upper())
        lookup[key] = region
    values = {}
    audit = {"source_records": 0, "aggregate_rows": len(rows), "excluded_year_rows": 0}
    for row in rows:
        key = (row["CNTY_NAME"], row["JURIS_NAME"])
        if key not in lookup:
            raise ValueError(f"Unmapped HCD jurisdiction {key}")
        year = int(row["YEAR"])
        if not config["start_year"] <= year <= end_year:
            audit["excluded_year_rows"] += 1
            continue
        region = lookup[key]
        cell = values.setdefault((region["id"], year), {"records": 0, **{
            stage: {"total": 0, "types": {t: 0 for t in TYPES}, "income": [0]*len(INCOMES),
                    "quality": {q: 0 for q in ["invalid", "missing_total", "undated", "outside_year", "mismatch"]}}
            for stage in STAGES}})
        cell["records"] += int(row["records"])
        audit["source_records"] += int(row["records"])
        unit_type = row["UNIT_CAT"] if row["UNIT_CAT"] in TYPES else "Other"
        for stage in STAGES:
            item = cell[stage]
            total = float(row[stage])
            if total < 0 or not total.is_integer():
                raise ValueError("Noninteger or negative HCD unit count")
            item["total"] += int(total)
            item["types"][unit_type] += int(total)
            for i in range(len(INCOMES)):
                value = float(row[f"{stage}_i{i}"])
                if value < 0 or not value.is_integer():
                    raise ValueError("Invalid affordability unit count")
                item["income"][i] += int(value)
            for q in item["quality"]:
                item["quality"][q] += int(row[f"{stage}_{q}"])
    output = []
    for region in sorted(regions, key=lambda x: x["id"]):
        annual = []
        for year in range(config["start_year"], end_year+1):
            cell = values.get((region["id"], year))
            if cell:
                for stage in STAGES:
                    if cell[stage]["quality"]["invalid"] or cell[stage]["quality"]["missing_total"]:
                        cell[stage]["total"] = None
                    if cell[stage]["quality"]["mismatch"] or cell[stage]["total"] is None:
                        cell[stage]["income"] = None
            annual.append(cell)
        output.append({k: region[k] for k in ["id", "name", "county", "jurisdiction_type", "housing_stock", "housing_stock_vintage"]} | {"annual": annual})
    return {"schema_version": 1, "years": list(range(config["start_year"], end_year+1)),
            "types": TYPES, "income_fields": INCOMES, "regions": output, "audit": audit}


def publish(root, dataset, config, metadata):
    folder = root/'public/data/hcd'
    pointer = folder/'latest.json'
    previous = json.loads(pointer.read_text()) if pointer.exists() else None
    payload = compact_json(dataset)
    digest = hashlib.sha256(payload).hexdigest()
    if previous and previous["bundle_sha256"] == digest:
        # Remember upstream checks without changing the public release or its citation date.
        atomic_write(folder/'source-check.json', compact_json(metadata))
        return False
    if previous:
        old = json.loads((folder/'releases'/previous['release']/'annual.json').read_text())
        if len(old['regions']) != len(dataset['regions']):
            raise ValueError('Jurisdiction reference changed; review required')
        if dataset['audit']['source_records'] < old['audit']['source_records'] * 0.8:
            raise ValueError('HCD source lost more than 20% of local records; review required')
        for prior, current in zip(old['regions'], dataset['regions']):
            if prior['id'] != current['id']:
                raise ValueError('Jurisdiction reference changed; review required')
            for i, cell in enumerate(prior['annual']):
                if cell is not None and (i >= len(current['annual']) or current['annual'][i] is None):
                    raise ValueError('Previously observed HCD jurisdiction-year disappeared')
    release = f"{datetime.now(timezone.utc):%Y-%m-%d}-{digest[:12]}"
    manifest = {"release": release, "provider": "California HCD", "data_page": config['data_page'],
                "created_at": datetime.now(timezone.utc).isoformat(), "bundle_sha256": digest,
                "source": metadata, "files": {"annual": ["annual.json"]}, "audit": dataset['audit'],
                "latest_year": dataset['years'][-1]}
    files = {'annual.json': payload, 'manifest.json': compact_json(manifest)}
    if sum(map(len, files.values())) > config['max_release_bytes']:
        raise ValueError('HCD release exceeds 1 MB budget')
    policy = json.loads((root/'config/storage_policy.json').read_text())
    existing = sum(p.stat().st_size for p in (root/'public/data').rglob('*') if p.is_file())
    if existing + sum(map(len, files.values())) + 2048 > policy['max_public_data_bytes']:
        raise ValueError('HCD candidate would exceed overall public storage budget')
    releases = folder/'releases'
    releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=folder) as temp:
        staging = Path(temp)/release
        staging.mkdir()
        for name, content in files.items():
            (staging/name).write_bytes(content)
        destination = releases/release
        if destination.exists():
            # Reverting to the retained rollback is safe only for identical payloads.
            if (destination/'annual.json').read_bytes() != payload:
                raise ValueError('HCD release identifier collision')
        else:
            staging.replace(destination)
    atomic_write(pointer, compact_json({"release": release, "bundle_sha256": digest}))
    atomic_write(folder/'source-check.json', compact_json(metadata))
    keep = {release, previous['release'] if previous else release}
    for path in releases.iterdir():
        if path.is_dir() and path.name not in keep:
            shutil.rmtree(path)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='Recheck unchanged source; all validation gates remain active')
    parser.add_argument('--pilot', action='store_true', help='Validate aggregates without publishing')
    args = parser.parse_args()
    config = json.loads((ROOT/'config/hcd_sources.json').read_text())
    resource = request('resource_show', id=config['resource_id'])
    if not resource.get('datastore_active'):
        raise ValueError('HCD DataStore unavailable')
    now = datetime.now(timezone.utc)
    end_year = now.year-1  # No current-year partial APRs.
    stamp = {"resource_id": config['resource_id'], "last_modified": resource.get('last_modified'),
             "size": resource.get('size'), "end_year": end_year, "schema_version": 1,
             "calculation_sha256": hashlib.sha256(Path(__file__).read_bytes()+compact_json(config)+compact_json([
                 {k: r[k] for k in ['id','name','county','jurisdiction_type','housing_stock','housing_stock_vintage']}
                 for r in reference(ROOT)])).hexdigest()}
    check = ROOT/'public/data/hcd/source-check.json'
    if check.exists() and json.loads(check.read_text()) == stamp and not args.force and not args.pilot:
        print('HCD source unchanged; no data query or release rebuild.')
        return
    fields = [f['id'] for f in request('datastore_search', resource_id=config['resource_id'], limit=0)['fields']]
    print('Retrieving county-filtered HCD aggregates with reporting-year checks.', flush=True)
    rows = retrieve(config, fields)
    if len(rows) < 500:
        raise ValueError('HCD aggregate response incomplete or unexpectedly small')
    # Ensure the upstream resource did not change during the query.
    after = request('resource_show', id=config['resource_id'])
    if after.get('last_modified') != stamp['last_modified']:
        raise ValueError('HCD source changed during retrieval')
    dataset = build(rows, reference(ROOT), config, end_year)
    for county in config['counties']:
        covered = sum(any(c for c in r['annual']) for r in dataset['regions'] if r['county'] == county+' County')
        if covered < (80 if county == 'Los Angeles' else 30):
            raise ValueError(f'Insufficient jurisdiction coverage in {county}: {covered}')
    print(json.dumps({"bytes": len(compact_json(dataset)), "audit": dataset['audit'],
                      "observed_city_years": sum(c is not None for r in dataset['regions'] for c in r['annual'])}))
    if args.pilot:
        print('Pilot passed; no public files written.')
    else:
        print('Published HCD release.' if publish(ROOT, dataset, config, stamp) else 'Local aggregates unchanged; retained release.')


if __name__ == '__main__':
    main()
