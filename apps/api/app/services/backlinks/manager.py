from __future__ import annotations

import json
from datetime import datetime
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.models.entities import BacklinkCampaign, BacklinkOpportunity, BacklinkTarget
from app.services.providers.openai_provider import OpenAIProvider
from app.services.settings import resolve_project_runtime_config


def _extract_domain(value: str) -> str:
    parsed = urlparse(value.strip())
    host = (parsed.netloc or '').lower().strip()
    if host.startswith('www.'):
        host = host[4:]
    return host or value.strip().lower()


def _safe_json(raw: str) -> dict:
    text = (raw or '').strip()
    if not text:
        return {}
    candidates = [text]
    if '```json' in text:
        start = text.find('```json') + len('```json')
        end = text.find('```', start)
        if end > start:
            candidates.insert(0, text[start:end].strip())
    start_obj = text.find('{')
    end_obj = text.rfind('}')
    if start_obj >= 0 and end_obj > start_obj:
        candidates.append(text[start_obj : end_obj + 1])

    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return value
        except Exception:
            continue
    return {}


def _build_fallback_plan(campaign: BacklinkCampaign, targets: list[BacklinkTarget], target_domains: list[str]) -> list[dict]:
    opportunities: list[dict] = []
    candidates = target_domains[:]
    candidates.extend([_extract_domain(t.target_url) for t in targets if t.target_url])
    deduped: list[str] = []
    seen = set()
    for domain in candidates:
        if not domain or domain in seen:
            continue
        seen.add(domain)
        deduped.append(domain)

    if not deduped:
        deduped = ['medium.com', 'quora.com', 'reddit.com']

    for idx, domain in enumerate(deduped[:12], start=1):
        target = targets[(idx - 1) % len(targets)] if targets else None
        target_url = target.target_url if target else campaign.website_url
        anchor = target.anchor_text if target and target.anchor_text else (campaign.business_name or 'Learn more')
        opportunities.append(
            {
                'domain': domain,
                'source_url': f'https://{domain}/',
                'source_type': 'profile',
                'profile_title': f"{campaign.business_name or campaign.name} - verified profile",
                'profile_description': (
                    f"{campaign.business_name or campaign.name} provides trusted services. "
                    f"Add profile with website, phone, and clear business details."
                ),
                'suggested_anchor': anchor,
                'suggested_target_url': target_url,
                'action_steps_json': [
                    'Create profile with business details and website URL.',
                    'Add one contextual backlink to target URL.',
                    'Complete bio and verify phone/email details.',
                ],
            }
        )
    return opportunities


async def generate_backlink_plan(
    db: Session,
    campaign: BacklinkCampaign,
    targets: list[BacklinkTarget],
    target_domains: list[str],
    objective: str | None = None,
) -> list[BacklinkOpportunity]:
    project = campaign.project
    config = resolve_project_runtime_config(db, project)
    openai_key = config.get('openai_api_key')
    openai_model = config.get('openai_model')
    provider = OpenAIProvider(api_key=openai_key, model=openai_model)

    target_payload = [
        {
            'target_url': target.target_url,
            'anchor_text': target.anchor_text or '',
            'priority': target.priority,
            'notes': target.notes or '',
        }
        for target in targets
    ]

    prompt = (
        'You are an SEO off-page strategist. Return strict JSON object with key "opportunities" as array. '\
        'Each object keys: domain, source_url, source_type, profile_title, profile_description, '\
        'suggested_anchor, suggested_target_url, action_steps_json (array of 2-5 short steps). '\
        'No markdown. No explanation.\n'
        f"Campaign: {campaign.name}\n"
        f"Website: {campaign.website_url}\n"
        f"Business: {campaign.business_name or ''}\n"
        f"Phone: {campaign.phone or ''}\n"
        f"Email: {campaign.contact_email or ''}\n"
        f"Address: {campaign.address or ''}\n"
        f"Objective: {objective or 'Create quality profile + citation style backlinks for ranking improvements.'}\n"
        f"Preferred domains: {json.dumps(target_domains)}\n"
        f"Targets: {json.dumps(target_payload)}\n"
        'Generate 8 to 15 opportunities.'
    )

    generated: list[dict] = []
    if provider.enabled:
        try:
            result = await provider.generate_text(prompt)
            parsed = _safe_json(result.text)
            raw_items = parsed.get('opportunities', []) if isinstance(parsed, dict) else []
            if isinstance(raw_items, list):
                for item in raw_items:
                    if not isinstance(item, dict):
                        continue
                    domain = _extract_domain(str(item.get('domain') or item.get('source_url') or ''))
                    if not domain:
                        continue
                    generated.append(
                        {
                            'domain': domain,
                            'source_url': str(item.get('source_url') or '') or None,
                            'source_type': str(item.get('source_type') or 'profile')[:64],
                            'profile_title': str(item.get('profile_title') or '')[:255] or None,
                            'profile_description': str(item.get('profile_description') or '') or None,
                            'suggested_anchor': str(item.get('suggested_anchor') or '')[:255] or None,
                            'suggested_target_url': str(item.get('suggested_target_url') or '')[:1024] or None,
                            'action_steps_json': item.get('action_steps_json')
                            if isinstance(item.get('action_steps_json'), list)
                            else [],
                        }
                    )
        except Exception:
            generated = []

    if not generated:
        generated = _build_fallback_plan(campaign, targets, target_domains)

    db.query(BacklinkOpportunity).filter(BacklinkOpportunity.campaign_id == campaign.id).delete()
    db.flush()

    created_rows: list[BacklinkOpportunity] = []
    targets_by_url = {target.target_url: target for target in targets}
    now = datetime.utcnow()
    for entry in generated:
        target_url = entry.get('suggested_target_url') or campaign.website_url
        target = targets_by_url.get(target_url)
        row = BacklinkOpportunity(
            campaign_id=campaign.id,
            target_id=target.id if target else None,
            domain=entry.get('domain') or _extract_domain(target_url),
            source_url=entry.get('source_url'),
            source_type=entry.get('source_type') or 'profile',
            profile_title=entry.get('profile_title'),
            profile_description=entry.get('profile_description'),
            suggested_anchor=entry.get('suggested_anchor'),
            suggested_target_url=target_url,
            action_steps_json=entry.get('action_steps_json') or [],
            status='planned',
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        created_rows.append(row)

    campaign.status = 'planned'
    campaign.updated_at = datetime.utcnow()
    db.add(campaign)
    db.commit()

    for row in created_rows:
        db.refresh(row)
    return created_rows
