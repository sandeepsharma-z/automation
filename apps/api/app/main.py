from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import auth, backlinks, blog_agent, blog_compose, debug, drafts, pipeline_runs, projects, seo_reports, settings, shopify, topics, wordpress
from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()
app_settings = get_settings()
app_settings.media_path.mkdir(parents=True, exist_ok=True)

app = FastAPI(title='ContentOps AI API', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(topics.router)
app.include_router(pipeline_runs.router)
app.include_router(drafts.router)
app.include_router(settings.router)
app.include_router(blog_agent.router)
app.include_router(blog_compose.router)
app.include_router(debug.router)
app.include_router(seo_reports.router)
app.include_router(backlinks.router)
app.include_router(shopify.router)
app.include_router(wordpress.router)

app.mount('/media', StaticFiles(directory=str(app_settings.media_path)), name='media')


@app.get('/healthz')
def health() -> dict:
    return {'status': 'ok'}
