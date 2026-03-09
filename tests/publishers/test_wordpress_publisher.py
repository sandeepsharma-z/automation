import asyncio

from app.models.entities import Draft, PlatformType, Project
from app.services.publishers.wordpress_publisher import publish_wordpress_draft


class FakeConnector:
    def __init__(self):
        self.upload_calls = []
        self.publish_payloads = []

    async def upload_media(self, image_path, alt_text, caption):
        self.upload_calls.append((image_path, alt_text, caption))
        return 991

    async def publish(self, payload):
        self.publish_payloads.append(payload)
        return {'platform_post_id': '123', 'platform_url': 'https://example.com/post'}


def test_wordpress_publisher_media_and_featured_payload(monkeypatch):
    connector = FakeConnector()
    monkeypatch.setattr('app.services.publishers.wordpress_publisher.build_connector', lambda _project: connector)

    project = Project(
        name='WP',
        platform=PlatformType.wordpress,
        base_url='https://example.com',
        settings_json={'wordpress_seo_meta_enabled': True},
    )
    draft = Draft(
        topic_id=1,
        project_id=1,
        title='Demo',
        slug='demo',
        html='<p>Hello</p>',
        meta_title='Meta Demo',
        meta_description='Meta Description',
        internal_links_json=[],
        sources_json=[],
        image_path='/tmp/feature.png',
        alt_text='Alt text',
        caption='Caption text',
    )

    result = asyncio.run(
        publish_wordpress_draft(
            project,
            draft,
            mode='publish_now',
            tags=['seo'],
            categories=['news'],
        )
    )

    assert result['platform_post_id'] == '123'
    assert connector.upload_calls
    assert connector.publish_payloads
    payload = connector.publish_payloads[0]
    assert payload['featured_media'] == 991
    assert payload['status'] == 'publish'
    assert payload['seo_meta']['_yoast_wpseo_title'] == 'Meta Demo'
