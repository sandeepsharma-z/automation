#!/usr/bin/env python3
import os
import sys
import time

import httpx

API_URL = os.environ.get('API_URL', 'http://localhost:8000')
USERNAME = os.environ.get('ADMIN_USERNAME', 'admin')
PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')


def fail(message: str) -> None:
    print(f'[FAIL] {message}')
    sys.exit(1)


with httpx.Client(timeout=20.0) as client:
    health = client.get(f'{API_URL}/healthz')
    if health.status_code != 200:
        fail(f'health check failed: {health.status_code}')
    print('[OK] health check')

    login = client.post(f'{API_URL}/api/auth/login', json={'username': USERNAME, 'password': PASSWORD})
    if login.status_code != 200:
        fail(f'login failed: {login.status_code} {login.text}')
    token = login.json()['access_token']
    headers = {'Authorization': f'Bearer {token}'}
    print('[OK] auth login')

    created = client.post(
        f'{API_URL}/api/projects',
        headers=headers,
        json={
            'name': 'Smoke Project',
            'platform': 'wordpress',
            'base_url': 'https://example.com',
            'wp_user': '',
            'wp_app_password': '',
            'settings_json': {
                'language': 'en',
                'country': 'us',
                'tone': 'professional',
                'persona': 'editor',
                'reading_level': 'grade 8',
                'style_rules': ['short paragraphs'],
                'banned_claims': ['guaranteed results'],
                'default_publish_mode': 'draft',
                'image_generation_enabled': False,
            },
        },
    )
    if created.status_code != 200:
        fail(f'project create failed: {created.status_code} {created.text}')
    project_id = created.json()['id']
    print(f'[OK] project created #{project_id}')

    topic = client.post(
        f'{API_URL}/api/topics/project/{project_id}',
        headers=headers,
        json={
            'title': 'Smoke Topic',
            'primary_keyword': 'content ops automation',
            'secondary_keywords_json': ['workflow', 'editorial'],
            'desired_word_count': 900,
        },
    )
    if topic.status_code != 200:
        fail(f'topic create failed: {topic.status_code} {topic.text}')
    topic_id = topic.json()['id']
    print(f'[OK] topic created #{topic_id}')

    run = client.post(f'{API_URL}/api/topics/{topic_id}/run', headers=headers)
    if run.status_code != 200:
        fail(f'pipeline trigger failed: {run.status_code} {run.text}')
    run_id = run.json()['pipeline_run_id']
    print(f'[OK] pipeline started #{run_id}')

    deadline = time.time() + 90
    while time.time() < deadline:
        details = client.get(f'{API_URL}/api/pipeline-runs/{run_id}', headers=headers)
        if details.status_code != 200:
            fail(f'pipeline fetch failed: {details.status_code} {details.text}')
        status = details.json()['run']['status']
        print(f'  status={status}')
        if status == 'completed':
            print('[OK] pipeline completed')
            sys.exit(0)
        if status == 'failed':
            fail(f"pipeline failed: {details.json()['run']['error_message']}")
        time.sleep(3)

    fail('pipeline did not complete in time')
