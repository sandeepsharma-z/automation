from __future__ import annotations

import argparse
import json

import requests


def main() -> None:
    parser = argparse.ArgumentParser(description='Run Blog Agent competitor-intelligence demo endpoint.')
    parser.add_argument('--api', default='http://localhost:8010', help='API base URL')
    parser.add_argument('--token', default='', help='Bearer token (optional if auth disabled)')
    parser.add_argument('--project-id', type=int, required=True)
    parser.add_argument('--keyword', required=True)
    parser.add_argument('--country', default='us')
    parser.add_argument('--language', default='en')
    args = parser.parse_args()

    headers = {'Content-Type': 'application/json'}
    if args.token:
        headers['Authorization'] = f'Bearer {args.token}'

    payload = {
        'project_id': args.project_id,
        'keyword': args.keyword,
        'country': args.country,
        'language': args.language,
    }
    response = requests.post(f"{args.api.rstrip('/')}/api/blog-agent/demo", headers=headers, json=payload, timeout=1800)
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2))


if __name__ == '__main__':
    main()
