from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import BacklinkCampaign, BacklinkOpportunity, BacklinkTarget, Project
from app.schemas.entities import (
    BacklinkCampaignCreate,
    BacklinkCampaignDetailResponse,
    BacklinkCampaignResponse,
    BacklinkOpportunityResponse,
    BacklinkOpportunityUpdate,
    BacklinkPlanRequest,
    BacklinkTargetResponse,
    BacklinkTargetsUpsertRequest,
)
from app.services.backlinks.manager import generate_backlink_plan

router = APIRouter(prefix='/api/backlinks', tags=['backlinks'], dependencies=[Depends(get_current_admin)])


def _campaign_or_404(db: Session, campaign_id: int) -> BacklinkCampaign:
    campaign = db.get(BacklinkCampaign, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail='Backlink campaign not found')
    return campaign


@router.get('/projects/{project_id}/campaigns', response_model=list[BacklinkCampaignResponse])
def list_campaigns(project_id: int, db: Session = Depends(get_db)) -> list[BacklinkCampaign]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    return db.execute(
        select(BacklinkCampaign)
        .where(BacklinkCampaign.project_id == project_id)
        .order_by(BacklinkCampaign.updated_at.desc())
    ).scalars().all()


@router.post('/projects/{project_id}/campaigns', response_model=BacklinkCampaignResponse)
def create_campaign(project_id: int, payload: BacklinkCampaignCreate, db: Session = Depends(get_db)) -> BacklinkCampaign:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    now = datetime.utcnow()
    campaign = BacklinkCampaign(
        project_id=project_id,
        name=payload.name.strip(),
        website_url=payload.website_url.strip(),
        business_name=(payload.business_name or '').strip() or None,
        contact_email=(payload.contact_email or '').strip() or None,
        phone=(payload.phone or '').strip() or None,
        address=(payload.address or '').strip() or None,
        profile_notes=(payload.profile_notes or '').strip() or None,
        status=(payload.status or 'draft').strip() or 'draft',
        created_at=now,
        updated_at=now,
    )
    db.add(campaign)
    db.commit()
    db.refresh(campaign)
    return campaign


@router.get('/campaigns/{campaign_id}', response_model=BacklinkCampaignDetailResponse)
def get_campaign(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    campaign = _campaign_or_404(db, campaign_id)
    targets = db.execute(
        select(BacklinkTarget)
        .where(BacklinkTarget.campaign_id == campaign_id)
        .order_by(BacklinkTarget.priority.desc(), BacklinkTarget.updated_at.desc())
    ).scalars().all()
    opportunities = db.execute(
        select(BacklinkOpportunity)
        .where(BacklinkOpportunity.campaign_id == campaign_id)
        .order_by(BacklinkOpportunity.updated_at.desc())
    ).scalars().all()
    return {'campaign': campaign, 'targets': targets, 'opportunities': opportunities}


@router.post('/campaigns/{campaign_id}/targets', response_model=list[BacklinkTargetResponse])
def upsert_targets(campaign_id: int, payload: BacklinkTargetsUpsertRequest, db: Session = Depends(get_db)) -> list[BacklinkTarget]:
    campaign = _campaign_or_404(db, campaign_id)
    existing = {
        row.target_url: row
        for row in db.execute(select(BacklinkTarget).where(BacklinkTarget.campaign_id == campaign_id)).scalars().all()
    }

    now = datetime.utcnow()
    touched: list[BacklinkTarget] = []
    for item in payload.targets:
        target_url = item.target_url.strip()
        if not target_url:
            continue
        row = existing.get(target_url)
        if not row:
            row = BacklinkTarget(
                campaign_id=campaign_id,
                target_url=target_url,
                anchor_text=(item.anchor_text or '').strip() or None,
                notes=(item.notes or '').strip() or None,
                priority=max(1, min(10, int(item.priority or 1))),
                created_at=now,
                updated_at=now,
            )
        else:
            row.anchor_text = (item.anchor_text or '').strip() or row.anchor_text
            row.notes = (item.notes or '').strip() or row.notes
            row.priority = max(1, min(10, int(item.priority or row.priority or 1)))
            row.updated_at = now
        db.add(row)
        touched.append(row)

    campaign.updated_at = now
    db.add(campaign)
    db.commit()

    for row in touched:
        db.refresh(row)
    return touched


@router.post('/campaigns/{campaign_id}/plan', response_model=list[BacklinkOpportunityResponse])
async def create_plan(campaign_id: int, payload: BacklinkPlanRequest, db: Session = Depends(get_db)) -> list[BacklinkOpportunity]:
    campaign = _campaign_or_404(db, campaign_id)
    targets = db.execute(
        select(BacklinkTarget)
        .where(BacklinkTarget.campaign_id == campaign_id)
        .order_by(BacklinkTarget.priority.desc(), BacklinkTarget.created_at.asc())
    ).scalars().all()

    rows = await generate_backlink_plan(
        db=db,
        campaign=campaign,
        targets=targets,
        target_domains=[item.strip() for item in payload.target_domains if item.strip()],
        objective=(payload.objective or '').strip() or None,
    )
    return rows


@router.patch('/opportunities/{opportunity_id}', response_model=BacklinkOpportunityResponse)
def update_opportunity(
    opportunity_id: int,
    payload: BacklinkOpportunityUpdate,
    db: Session = Depends(get_db),
) -> BacklinkOpportunity:
    row = db.get(BacklinkOpportunity, opportunity_id)
    if not row:
        raise HTTPException(status_code=404, detail='Backlink opportunity not found')

    if payload.status is not None:
        row.status = payload.status.strip() or row.status
    if payload.placed_url is not None:
        row.placed_url = payload.placed_url.strip() or None
    if payload.notes is not None:
        row.notes = payload.notes.strip() or None
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
