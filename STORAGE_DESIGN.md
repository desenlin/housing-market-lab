# Storage and historical continuity

## Design goals

The public repository should remain inexpensive to clone and reliable to update on GitHub Free while preserving observations that a provider may later remove from its current download. The design archives the lab's compact, attributed local extracts—not national raw provider files.

GitHub recommends keeping a single Git object at or below 1 MB, blocks regular Git objects above 100 MiB, recommends repositories remain below 1 GB, and recommends the same 1 GB ceiling for a GitHub Pages source repository. The lab therefore uses a stricter 1,000,000-byte generated-JSON limit and a 25,000,000-byte working-tree budget. See GitHub's [repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits), [large-file guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github), and [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

## Four storage controls

1. **Shard chart data by geography and county.** City and ZIP releases are stored in separate Los Angeles and Orange County JSON files. Metro data remain in one small file. Every generated JSON object must stay below 1,000,000 bytes.
2. **Store boundary geometry once.** Census place and ZCTA geometry has an independent versioned pointer under `public/data/maps/`. A housing-data refresh no longer duplicates unchanged map geometry inside every Zillow release.
3. **Bound rollback copies.** Every provider or independent product retains the current validated release and one rollback release. Older working-tree snapshots are pruned only after the new pointer is written successfully. Deleted snapshots remain recoverable from Git history, but routine operation does not depend on an ever-growing release directory.
4. **Stream sources and enforce budgets automatically.** National CSV and ZIP inputs remain temporary or in ignored development caches. `scripts/check_storage.py` rejects committed raw/archive formats, invalid JSON, dangling pointers, excess release directories, objects above 1 MB, or a public-data tree above 25 MB.

The 2026-09-08 migration reduced the public-data working tree from approximately 22 MB to 12.3 MB. The largest current schema-v2 chart shard is approximately 756 KB; the largest retained legacy rollback object is approximately 992 KB.

## Preserving history when a provider truncates its download

Each updater follows a **merge-forward** rule before publishing:

- Match a series by provider/product, geography, stable region identifier, metric, and date.
- Use the newest provider value—including a revision or an explicit missing value—for every date present in the new provider file.
- Retain the prior compact value only when that date is absent from the new provider file, such as when a download changes from full history to a rolling ten-year window.
- If a previously observed region disappears entirely from the new file, retain its prior history while leaving newly added dates empty.
- Record the prior release and any detected earlier-date truncation in the new manifest.

This distinction is important: a date omitted from a truncated file is archived, while a date still present but reported as missing remains missing. The pipeline does not overwrite an explicit provider deletion with an old value.

Zillow, Redfin, Realtor.com, and BLS CPI use this merge-forward process. Final Census building-permit history is appended and merged from the last validated archive, so a new final year does not require re-downloading every file back to 1980. Preliminary permit releases are not merged indefinitely; once a year becomes final, it belongs in the final-history layer.

## Recovery hierarchy

1. The current pointer serves the latest validated, history-preserving extract.
2. The retained rollback release permits an immediate pointer reversal after a bad update.
3. Git history provides disaster recovery for older compact releases and pipeline code.
4. The provider remains the authoritative source for overlapping revisions and corrections.

GitHub Actions artifacts are not used as the historical archive because public-repository artifacts have a maximum 90-day retention period and GitHub Free artifact storage is limited. Git LFS and GitHub Release assets are also unnecessary at the current scale and would complicate GitHub Pages delivery and third-party-data governance.
