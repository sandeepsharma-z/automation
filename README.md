# ContentOps AI

ContentOps AI is a multi-tenant content operations platform for research-driven blog generation and publishing to WordPress or Shopify.

## Compatibility
- Recommended runtime: **Python 3.11**.
- Requirements are pinned for Python 3.11 stability.
- `orjson` is optional and installed only for Python versions below 3.14.
- JSON handling has runtime fallback to stdlib JSON when `orjson` is unavailable.

## Stack
- API: FastAPI
- DB: MySQL 8 + SQLAlchemy 2.0 + Alembic
- Queue: Celery (Redis primary, SQLAlchemy fallback supported)
- Scheduler: Celery Beat (for scheduled publishing dispatch)
- Admin: Next.js
- RAG: LangChain + Chroma persistent vector store (fallback hashed index if Chroma unavailable)

## Prerequisites
- Python 3.11+
- Node.js 20+
- MySQL running locally and reachable from `DATABASE_URL`
- Optional: Redis (if missing, worker uses SQLAlchemy transport)

## Environment
Create env file:

```powershell
Copy-Item .env.example .env
```

Set at least:
- `DATABASE_URL` in `mysql+pymysql://user:pass@host:3306/dbname` format
- `FERNET_MASTER_KEY`
- `OPENAI_API_KEY` (recommended)

Important defaults:
- `DEFAULT_LANGUAGE`, `DEFAULT_COUNTRY`, `DEFAULT_PUBLISH_MODE`
- `RAG_ENABLED`, `RAG_TOP_K`, `INTERNAL_LINKS_MAX`
- `QA_ENABLED`, `QA_STRICTNESS`, `ALLOW_AUTOPUBLISH`
- `SERP_PROVIDER`, `SERP_API_KEY`

## Local Run (No Docker) - Windows
If script execution is blocked, run once in PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then run:

1. Setup + migrations
```powershell
./scripts/local_setup.ps1
```

2. API (terminal 1)
```powershell
./scripts/local_run_api.ps1
```

3. Worker (terminal 2)
```powershell
./scripts/local_run_worker.ps1
```

4. Admin (terminal 3)
```powershell
./scripts/local_run_admin.ps1
```

5. Optional beat for scheduled publishing (terminal 4)
```powershell
.\.venv\Scripts\python.exe -m celery -A apps.worker.app.celery_app.celery_app beat --loglevel=INFO
```

URLs:
- API docs: `http://localhost:8000/docs`
- Admin: `http://localhost:3000`

## Local Run (No Docker) - Bash
```bash
./scripts/local_setup.sh
./scripts/local_run_api.sh
./scripts/local_run_worker.sh
./scripts/local_run_admin.sh
```

Optional beat for scheduled publishing:

```bash
python -m celery -A apps.worker.app.celery_app.celery_app beat --loglevel=INFO
```

## Docker Run (still supported)
```powershell
./scripts/dev_up.ps1
```
or
```bash
bash ./scripts/dev_up.sh
```

## Admin Login
From `.env`:
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## Settings Module
Global settings are managed in Admin at `/settings`.

Sections:
- OpenAI: API key, text model, image model, provider test button
- SERP: provider + key + test button
- Publishing defaults: mode + autopublish toggle
- RAG defaults: enable flag, top-k, max internal links
- QA defaults: enable flag + strictness

Secrets are masked in API/UI and never returned in clear form.

### Configuration precedence
Runtime resolution order is:
1. Project override (`projects.settings_json`)
2. Global setting (`settings` table)
3. Environment fallback (`.env`)

Project overrides support: `openai_api_key`, `openai_model`, `rag_top_k`, `internal_links_max`, `publish_mode`, `tone`, `persona`, `style_rules`.

### Test providers from UI
In `/settings`:
- Click **Test OpenAI** to validate API key + model.
- Click **Test SERP** to validate provider configuration.

Provider health badges are updated from the latest test result.

## LangChain RAG + QA Pipeline
- Library content is embedded per project into:
  - `CHROMA_PERSIST_DIR/<project_id>`
- If Chroma fails, fallback local hashed vector index is used.
- Sync Library queues reindex automatically.
- Manual reindex endpoint:
  - `POST /api/projects/{id}/reindex-library`
- RAG status endpoint:
  - `GET /api/projects/{id}/rag/status`

Pipeline includes:
1. Research (SERP + competitor extraction)
2. Optional tool orchestration (`serp_search`, `fetch_url`, `library_search`)
3. RAG retrieval for internal link candidates
4. Draft generation with link/anchor constraints
5. QA stage (links, anchor uniqueness, readability, basic HTML)
6. Image stage
7. Save draft (`needs_review` if QA fails)

Publishing remains deterministic and code-driven.

## Blog Agent (One-Click)
New Admin route: `/blog-agent`

Capabilities:
- Outline-only generation
- Full blog generation (research -> brief -> draft -> QA -> image -> save)
- Regenerate with different structure (diversity guard)
- Generate images only (featured + optional inline)
- Publish to WordPress/Shopify from draft context

API endpoints:
- `POST /api/blog-agent/outline`
- `POST /api/blog-agent/generate`
- `POST /api/blog-agent/{draft_id}/regenerate`
- `POST /api/blog-agent/{draft_id}/images`
- `POST /api/blog-agent/{draft_id}/publish`
- `GET /api/blog-agent/{draft_id}`

Diversity + similarity:
- Structure rotation across: how-to, listicle, comparison, myth-busting, case-study, checklist, framework, mistakes, faq-first
- Similarity guard compares against recent drafts and auto-regenerates if threshold is exceeded
- Heading-sequence repetition is blocked

Blog Agent UI shows:
- Outline preview (editable JSON)
- SEO preview (meta title, description, slug)
- Internal links + anchors + reason + section hint
- Similarity score + structure type
- Featured/inline image previews
- Draft HTML preview
- Error panel + toasts for every API failure (no silent failures)

## Editorial Workflow
- Draft statuses: `draft`, `needs_review`, `approved`, `publishing`, `published`, `failed`
- Approve from Draft page before publishing (unless `allow_autopublish=true`)
- Scheduled publish creates a scheduled publish record; beat dispatches jobs when due.

## Verify RAG Ingestion
1. Start API + Worker + Admin.
2. Create/open a project.
3. Click `Sync Library` in admin.
4. In Library page click `Reindex for RAG` (optional but explicit).
5. Check RAG widget shows:
   - non-zero `Indexed docs`
   - `Last indexed` timestamp
6. Or call API directly:

```bash
curl -X GET http://localhost:8000/api/projects/<PROJECT_ID>/rag/status -H "Authorization: Bearer <TOKEN>"
```

Expected response contains `doc_count > 0` and `indexed_at`.

## Walkthrough: Generate + Publish from Blog Agent
1. Login to Admin and open `http://localhost:3000/blog-agent`.
2. Select a project and platform (`wordpress` or `shopify`).
3. Fill `topic`, `primary keyword`, optional `secondary keywords`, tone, word count.
4. Click **Generate Full Blog**.
5. Review outline, SEO fields, similarity score, and internal links.
6. Click **Generate Images Only** if you want to refresh visuals.
7. Set publish mode (`draft`, `publish_now`, or `schedule`) and click **Publish**.
8. Verify post URL/id in draft state (`publish_url`, `platform_post_id`).

## Tests
Run required checks:

```bash
python -m compileall apps/api/app apps/worker/app
python -m pytest -q
```

Coverage includes:
- Connector tests
- Variation engine tests
- RAG ingestion + retrieval tests
- QA anchor/readability tests
- Local run script parse/smoke checks

## Troubleshooting
- If Next.js admin fails with `Unexpected token 'ï»¿'` while reading `apps/admin/package.json`, re-save that file as **UTF-8 (without BOM)**.
