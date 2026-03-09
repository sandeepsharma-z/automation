import asyncio

from app.models.entities import Draft, PlatformType, Project
from app.services.publishers.shopify_publisher import publish_shopify_draft


class FakeConnector:
    def __init__(self):
        self.publish_payloads = []

    async def publish(self, payload):
        self.publish_payloads.append(payload)
        return {'platform_post_id': '998', 'platform_url': 'https://shop.example.com/blogs/news/demo'}


def test_shopify_publisher_payload(monkeypatch):
    connector = FakeConnector()
    monkeypatch.setattr('app.services.publishers.shopify_publisher.build_connector', lambda _project: connector)

    project = Project(
        name='Shop',
        platform=PlatformType.shopify,
        base_url='https://placeholder',
        settings_json={},
    )
    draft = Draft(
        topic_id=1,
        project_id=1,
        title='Shop Draft',
        slug='shop-draft',
        html='<p>Hi</p>',
        meta_title='Meta',
        meta_description='Desc',
        internal_links_json=[],
        sources_json=[],
        image_path='/tmp/feature.png',
        alt_text='Alt text',
    )

    result = asyncio.run(
        publish_shopify_draft(
            project,
            draft,
            mode='scheduled',
            scheduled_at='2026-12-01T10:00:00Z',
            tags=['launch'],
            blog_id=77,
        )
    )

    assert result['platform_post_id'] == '998'
    assert connector.publish_payloads
    payload = connector.publish_payloads[0]
    assert payload['status'] == 'published'
    assert payload['scheduled_at'] == '2026-12-01T10:00:00Z'
    assert payload['blog_id'] == 77
    assert payload['image_path'] == '/tmp/feature.png'
