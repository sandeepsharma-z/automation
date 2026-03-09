from pathlib import Path

from app.services.competitive.competitive_analyzer import (
    compute_competitive_strength,
    dedup_and_cluster_discovery,
)
from app.services.competitive.competitor_extractor import extract_competitor_signals
from app.services.competitive.originality_guard import enforce_originality


def test_scoring_order_prefers_stronger_page():
    weak = compute_competitive_strength(
        keyword='bopp laminated bags',
        title='What is BOPP',
        snippet='short intro',
        headings={'h2': ['Overview'], 'h3': []},
        metrics={'word_count_estimate': 300},
        faqs=[],
        discovered_at='2024-01-01T00:00:00+00:00',
        last_seen_at='2024-01-01T00:00:00+00:00',
        inlink_count=1,
        publish_date='2024-01-01T00:00:00+00:00',
    )
    strong = compute_competitive_strength(
        keyword='bopp laminated bags',
        title='BOPP laminated bags quality standards and cost checklist',
        snippet='supplier checklist and standards',
        headings={'h2': ['Quality standards', 'Cost checklist'], 'h3': ['Testing steps', 'FAQ']},
        metrics={'word_count_estimate': 2200},
        faqs=['What quality standard matters?', 'How to compare suppliers?'],
        discovered_at='2026-02-01T00:00:00+00:00',
        last_seen_at='2026-02-15T00:00:00+00:00',
        inlink_count=120,
        publish_date='2026-01-10T00:00:00+00:00',
    )
    assert strong['competitive_strength_score'] > weak['competitive_strength_score']


def test_discovery_dedup_limits_two_urls_per_domain():
    rows = [
        {'title': 'How to test BOPP', 'url': 'https://a.com/how-to-test', 'domain': 'a.com', 'snippet': 'how to guide'},
        {'title': 'BOPP supplier list', 'url': 'https://a.com/suppliers', 'domain': 'a.com', 'snippet': 'supplier'},
        {'title': 'A third same domain should drop', 'url': 'https://a.com/third', 'domain': 'a.com', 'snippet': 'pricing'},
        {'title': 'ISO standards for bags', 'url': 'https://b.com/iso', 'domain': 'b.com', 'snippet': 'standard compliance'},
    ]
    out = dedup_and_cluster_discovery(rows, max_urls_per_domain=2, max_items=10)
    assert len([r for r in out['items'] if r['domain'] == 'a.com']) == 2
    assert out['dropped_for_domain_cap'] == 1


def test_extractor_returns_headings_entities_and_metrics():
    html = """
    <html><body>
      <article>
        <h1>BOPP Laminated Bags Guide</h1>
        <h2>Quality Standards</h2>
        <h3>Testing Methods</h3>
        <p>BOPP and ISO process checks improve packaging outcomes.</p>
        <p>What testing checklist should buyers use?</p>
        <img src="x.jpg" />
      </article>
    </body></html>
    """
    data = extract_competitor_signals('https://example.com/bopp-guide', html)
    assert data['headings']['h1'][0] == 'BOPP Laminated Bags Guide'
    assert 'Quality Standards' in data['headings']['h2']
    assert data['entities']
    assert data['metrics']['media_count'] == 1
    assert any('?' in q for q in data['faqs'])


def test_originality_guard_rewrites_when_too_close():
    competitor = "bopp laminated bags quality checks include gsm bond strength and print accuracy controls"
    html = (
        "<article><h2>Quality checks</h2>"
        "<p>BOPP laminated bags quality checks include GSM bond strength and print accuracy controls.</p></article>"
    )
    result = enforce_originality(
        html=html,
        competitor_texts=[competitor],
        primary_keyword='bopp laminated bags',
        threshold=0.01,
    )
    assert result['rewritten'] is True
    assert result['html'] != html


def test_no_serp_reference_in_competitive_pipeline_files():
    targets = [
        Path('apps/api/app/services/competitive/open_crawl_service.py'),
        Path('apps/api/app/services/competitive/competitive_analyzer.py'),
        Path('apps/api/app/services/pipeline/engine.py'),
        Path('apps/api/app/api/routes/blog_agent.py'),
        Path('apps/admin/app/blog-agent/page.js'),
    ]
    for target in targets:
        text = target.read_text(encoding='utf-8').lower()
        assert 'serp sources' not in text
        assert 'serp_' not in text
        assert 'serp runs' not in text


def test_serp_service_removed_from_competitive_module():
    assert not Path('apps/api/app/services/competitive/serp_service.py').exists()


def test_audit_payload_uses_crawl_keys():
    route_file = Path('apps/api/app/api/routes/blog_agent.py').read_text(encoding='utf-8')
    assert 'crawl_candidates_json' in route_file
    assert 'extracts_json' in route_file
    assert 'brief_json' in route_file
    assert 'qa_json' in route_file
