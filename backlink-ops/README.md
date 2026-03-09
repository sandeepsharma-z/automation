# Backlink Operations (Compliant + Human-in-Loop)

This module supports **bulk backlink operations** with strict compliance controls:

- Allowlist-only processing from `targets.json`
- Workflow templates by backlink type
- Per-row + per-target-link execution tracking
- Mandatory human approval before submit/publish
- Playwright runner with safe rate limits (no bypass/evasion features)

It intentionally **does not** implement:

- CAPTCHA solving
- Verification/email bypass
- Stealth/fingerprint spoofing
- Proxy rotation
- Any evasion or spam automation behavior

## Core schema

Input fields (row-level):

- `backlink_type`
- `site_url`
- `site_name`
- `username`, `email`, `password` (optional credentials)
- `company_name`, `company_address`, `company_phone`, `company_description`
- `target_links` (array; pipe-separated in Sheets)
- `anchor_text` (optional)
- `category`, `notes`, `tags`

Output fields:

- `results` (array/json per target link)
- `result_title`
- `created_link`
- `status`
- `status_reason`
- `run_id`
- `started_at`
- `completed_at`
- `screenshot_url`

Per-target result object format:

```json
{
  "target_link": "https://example.com/page",
  "created_link": "https://directory.com/listing/123",
  "result_title": "Submission complete",
  "status": "success",
  "status_reason": "",
  "artifacts": ["runs/<run_id>/<site_slug>/pre_submit_1.png", "runs/<run_id>/<site_slug>/pre_submit_1.html"]
}
```

## Workflow templates (`src/workflows`)

Available types:

- `profile_listing`
- `business_directory`
- `resource_submission`
- `outreach_email` (no Playwright submit; draft + tracking flow)
- `citation_update`

Each workflow defines:

- `required_fields`
- `optional_fields`
- `steps`

Runner still depends on `targets.json` selectors. If required selectors are missing, row/target becomes `needs_manual_mapping`.

## Bulk Runs UI

Page: `/backlinks/bulk-runs`

Features:

- CSV/TSV upload or paste
- Column-to-schema mapping
- Validation preview:
  - allowlisted vs blocked
  - mapping-needed rows
- Import to queue
- Run monitoring with per-run totals and per-target counts
- CSV export per run

### CSV format example

```csv
backlink_type,site_url,site_name,username,email,password,company_name,company_address,company_phone,company_description,target_links,anchor_text,notes,tags
business_directory,https://example-directory.com,Example Directory,account01,user@gmail.com,pass@123,My Company,City India,+91...,Dental services,"https://site.com/page-1|https://site.com/page-2",best dental implant,priority row,"seo,india"
profile_listing,https://another-site.com,Another Site,,,,My Company,City India,+91...,Dental services,https://site.com/page-3,,manual check,
```

## Success Vault UI

Page: `/backlinks/success-vault`

Shows all successful `created_link` entries with filters by query/type:

- backlink type
- site URL/name
- target link
- created link
- timestamp/run id

## Runner behavior upgrades

- Bulk sequential processing with jitter delay (`MIN_DELAY_MINUTES` / `MAX_DELAY_MINUTES`)
- Multi-target processing per row (`target_links`)
- Resume/idempotency:
  - skips already-successful target links unless `--force=1`
- Per-target status updates are written during execution
- Human approval checkpoint before submit for every target-link submit step

## Sheets mode notes

When `DATA_SOURCE=sheets`:

- `target_links` is read/written as pipe-separated (`url1|url2|url3`)
- `results` is stored as JSON string in cell
- stable row key uses: `<sheet_row_number>-<normalized_host_hash>`

## API endpoints (UI app)

- `POST /api/backlinks/bulk-preview`
- `POST /api/backlinks/bulk-import`
- `GET /api/backlinks/runs?include_rows=1`
- `GET /api/backlinks/runs/[runId]`
- `GET /api/backlinks/runs/export?run_id=<id>`
- `GET /api/backlinks/success-vault`

## Run commands

```bash
cd backlink-ops
npm run run -- --limit=5
npm run run -- --row-key=12 --force-retry=1 --limit=1
npm run run -- --limit=5 --force=1
```

## Admin embedding routes

In admin app sidebar `Backlinks` submenu:

- type-specific fill routes (`/backlinks/ops-entry?type=...`)
- `/backlinks/ops-table`
- `/backlinks/bulk-runs`
- `/backlinks/success-vault`
