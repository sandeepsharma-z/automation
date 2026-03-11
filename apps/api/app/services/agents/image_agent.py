from __future__ import annotations

from bs4 import BeautifulSoup
from bs4.element import Tag
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.entities import Draft, DraftImage, Project, Topic
from app.services.providers.openai_provider import OpenAIProvider
from app.services.settings import resolve_project_runtime_config
from app.services.media_storage import guess_image_extension, save_binary_image


def _public_media_path(value: str | None) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.startswith('http://') or raw.startswith('https://'):
        return raw
    normalized = raw.replace('\\', '/')
    if '/media/' in normalized:
        suffix = normalized.split('/media/', 1)[1].lstrip('/')
        return f"/media/{suffix}"
    if normalized.startswith('media/'):
        return f"/{normalized}"
    if 'storage/media/' in normalized:
        suffix = normalized.split('storage/media/', 1)[1].lstrip('/')
        return f"/media/{suffix}"
    return normalized if normalized.startswith('/') else f"/{normalized}"


def _new_image_figure(
    soup: BeautifulSoup,
    *,
    css_class: str,
    src: str,
    alt_text: str | None,
    caption: str | None,
) -> Tag:
    figure = soup.new_tag('figure')
    figure['class'] = [css_class, 'contentops-generated-image']

    image = soup.new_tag('img')
    image['src'] = src
    image['alt'] = alt_text or 'generated image'
    image['loading'] = 'lazy'
    figure.append(image)

    if caption:
        figcaption = soup.new_tag('figcaption')
        figcaption.string = caption
        figure.append(figcaption)
    return figure


def _inject_generated_images(
    html: str,
    *,
    featured_image_path: str | None,
    featured_alt: str | None,
    featured_caption: str | None,
    inline_images: list[dict[str, Any]],
) -> str:
    source_html = html or '<article></article>'
    soup = BeautifulSoup(source_html, 'html.parser')
    root = soup.find('article') or soup.body or soup

    for existing in soup.select('figure.contentops-generated-image'):
        existing.decompose()

    if featured_image_path:
        featured = _new_image_figure(
            soup,
            css_class='contentops-featured-image',
            src=featured_image_path,
            alt_text=featured_alt,
            caption=featured_caption or 'Featured image',
        )
        first_para = root.find('p')
        if first_para:
            first_para.insert_after(featured)
        else:
            heading = root.find('h1')
            if heading:
                heading.insert_after(featured)
            else:
                root.insert(0, featured)

    inline_entries = [entry for entry in inline_images if entry.get('image_path')]
    if inline_entries:
        h2s = root.find_all('h2')
        for idx, image in enumerate(inline_entries):
            inline_figure = _new_image_figure(
                soup,
                css_class='contentops-inline-image',
                src=str(image.get('image_path')),
                alt_text=str(image.get('alt_text') or f"Inline image {idx + 1}"),
                caption=str(image.get('caption') or ''),
            )
            if idx < len(h2s):
                h2s[idx].insert_after(inline_figure)
            else:
                root.append(inline_figure)

    return str(soup)


def _build_base_prompt(
    *,
    topic: str,
    primary_keyword: str,
    tone: str,
    country: str,
    style: str,
) -> str:
    keyword_lc = str(primary_keyword or '').lower()
    medical_terms = ('dental', 'clinic', 'doctor', 'patient', 'implant', 'surgery', 'hospital', 'tooth', 'teeth')
    avoid_medical = not any(term in keyword_lc for term in medical_terms)
    negative = (
        "Avoid any doctors, hospitals, clinics, medical uniforms, surgery scenes. "
        if avoid_medical
        else ""
    )
    return (
        f"Create a high-quality realistic {style} image for '{topic}'. "
        f"Visual intent should match keyword '{primary_keyword}'. "
        f"Tone: {tone}. Region context: {country}. "
        "Output must be wide horizontal landscape composition (not square, not portrait/mobile ratio). "
        "Keep subjects and props strictly aligned with article industry/topic context. "
        f"{negative}"
        "Photorealistic lighting, natural materials, ecommerce-grade composition. "
        "Strictly no text, no letters, no words, no logos, no watermark, no UI elements."
    )


async def generate_images_for_draft(
    db: Session,
    *,
    draft_id: int,
    image_mode: str = 'featured_only',
    inline_images_count: int = 0,
) -> dict[str, Any]:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise RuntimeError('Draft not found')
    project = db.get(Project, draft.project_id)
    if not project:
        raise RuntimeError('Project not found')
    topic = db.get(Topic, draft.topic_id) if draft.topic_id else None

    runtime = resolve_project_runtime_config(db, project)
    provider = OpenAIProvider(
        api_key=runtime.get('openai_api_key'),
        model=runtime.get('openai_model'),
        image_model=runtime.get('image_model'),
    )

    settings_json = project.settings_json or {}
    image_provider = str(runtime.get('image_provider') or settings_json.get('image_provider') or 'openai')
    image_style = str(runtime.get('image_style') or settings_json.get('image_style') or 'editorial')
    allow_inline_images = bool(runtime.get('allow_inline_images', settings_json.get('allow_inline_images', True)))
    tone = str(settings_json.get('tone') or 'professional')
    country = str(runtime.get('country') or 'in')
    primary_keyword = str((topic.primary_keyword if topic else '') or draft.title)

    featured_prompt = _build_base_prompt(
        topic=primary_keyword,
        primary_keyword=primary_keyword,
        tone=tone,
        country=country,
        style=image_style,
    ) + (
        f" Article context: {draft.title}. "
        "Compose as a wide hero shot for top-of-article banner. "
        "Do not mimic inline section images."
    )

    db.execute(delete(DraftImage).where(DraftImage.draft_id == draft.id))
    db.commit()

    images: list[dict[str, Any]] = []
    if image_provider == 'disabled' or image_mode == 'prompts_only':
        draft.image_prompt = featured_prompt
        db.add(draft)
        db.commit()
        return {'draft_id': draft.id, 'generated': 0, 'mode': 'prompts_only', 'prompts': [featured_prompt]}

    errors: list[str] = []
    try:
        featured_binary = await provider.generate_image(featured_prompt) if provider.enabled else None
    except Exception as exc:
        featured_binary = None
        errors.append(str(exc))
    used_fallback = False
    if not featured_binary:
        errors.append('Featured image was not generated (provider unavailable or request failed).')
    if featured_binary:
        featured_ext = guess_image_extension(featured_binary, fallback='png')
        featured_path = save_binary_image(
            project_id=draft.project_id,
            draft_id=draft.id,
            kind='featured',
            index=0,
            binary=featured_binary,
            extension=featured_ext,
            max_bytes=2 * 1024 * 1024,
        )
        featured_alt = f"{draft.title} - {primary_keyword}"
        featured_caption = f"Featured visual for {draft.title}"
        draft.image_path = featured_path
        draft.image_prompt = featured_prompt
        draft.alt_text = featured_alt
        draft.caption = featured_caption
        db.add(
            DraftImage(
                draft_id=draft.id,
                project_id=draft.project_id,
                kind='featured',
                image_path=featured_path,
                prompt=featured_prompt,
                alt_text=featured_alt,
                caption=featured_caption,
                position=0,
            )
        )
        images.append({'kind': 'featured', 'image_path': featured_path, 'alt_text': featured_alt})
    else:
        draft.image_path = None
        draft.image_prompt = featured_prompt
        draft.alt_text = None
        draft.caption = None

    inline_total = max(0, min(3, inline_images_count))
    if image_mode == 'featured+inline' and allow_inline_images and inline_total:
        soup = BeautifulSoup(draft.html or '', 'html.parser')
        heading_contexts = [str(tag.get_text(' ', strip=True)) for tag in soup.find_all(['h2', 'h3']) if tag.get_text(strip=True)]
        inline_styles = [
            'close-up technical detail shot',
            'industrial process scene with machinery and materials',
            'product specification and measurement context shot',
        ]
        inline_prompts = []
        for idx in range(inline_total):
            section_label = heading_contexts[idx] if idx < len(heading_contexts) else primary_keyword
            style_hint = inline_styles[idx % len(inline_styles)]
            inline_prompts.append(
                f"{_build_base_prompt(topic=section_label, primary_keyword=primary_keyword, tone=tone, country=country, style=image_style)} "
                f"Section context: '{section_label}'. "
                f"Shot style: {style_hint}. "
                "Must be compositionally different from featured hero and other inline images "
                "(different framing, camera distance, and subject arrangement). "
                "Strictly no text, no labels, no letters, no watermark."
            )
        for idx, prompt in enumerate(inline_prompts, start=1):
            try:
                binary = await provider.generate_image(prompt) if provider.enabled else None
            except Exception as exc:
                binary = None
                errors.append(f'Inline image {idx} generation failed: {str(exc) or repr(exc)}')
            if not binary:
                errors.append(f'Inline image {idx} was not generated (provider unavailable or request failed).')
                continue
            inline_ext = guess_image_extension(binary, fallback='png')
            path = save_binary_image(
                project_id=draft.project_id,
                draft_id=draft.id,
                kind='inline',
                index=idx,
                binary=binary,
                extension=inline_ext,
                max_bytes=2 * 1024 * 1024,
            )
            alt = f"{draft.title} inline visual {idx}"
            caption = ''
            db.add(
                DraftImage(
                    draft_id=draft.id,
                    project_id=draft.project_id,
                    kind='inline',
                    image_path=path,
                    prompt=prompt,
                    alt_text=alt,
                    caption=caption,
                    position=idx,
                )
            )
            images.append(
                {
                    'kind': 'inline',
                    'image_path': path,
                    'alt_text': alt,
                    'caption': caption,
                    'position': idx,
                }
            )

    featured_public_path = _public_media_path(draft.image_path)
    inline_for_html: list[dict[str, Any]] = []
    for item in images:
        if item.get('kind') != 'inline':
            continue
        inline_for_html.append(
            {
                'image_path': _public_media_path(str(item.get('image_path') or '')),
                'alt_text': item.get('alt_text'),
                'caption': item.get('caption'),
            }
        )
    draft.html = _inject_generated_images(
        draft.html,
        featured_image_path=featured_public_path,
        featured_alt=draft.alt_text,
        featured_caption=draft.caption,
        inline_images=inline_for_html,
    )

    db.add(draft)
    db.commit()
    mode = image_mode if provider.enabled else 'disabled'
    return {
        'draft_id': draft.id,
        'generated': len(images),
        'mode': mode,
        'used_fallback': used_fallback,
        'errors': errors,
        'images': images,
    }


def list_draft_images(db: Session, draft_id: int) -> list[DraftImage]:
    return db.execute(
        select(DraftImage).where(DraftImage.draft_id == draft_id).order_by(DraftImage.position.asc(), DraftImage.id.asc())
    ).scalars().all()
