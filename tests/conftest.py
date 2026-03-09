import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_PATH = ROOT / 'apps' / 'api'
WORKER_PATH = ROOT / 'apps' / 'worker'

if str(API_PATH) not in sys.path:
    sys.path.insert(0, str(API_PATH))
if str(WORKER_PATH) not in sys.path:
    sys.path.append(str(WORKER_PATH))

os.environ.setdefault('FERNET_MASTER_KEY', 'u3fKzvTjv0YgS5ER5YjZL5QkNo4fU6Y4ZCkxzgv2F0A=')
os.environ.setdefault('DATABASE_URL', 'sqlite+pysqlite:///:memory:')
os.environ.setdefault('JWT_SECRET', 'test-secret')
os.environ.setdefault('OPENAI_API_KEY', '')
os.environ.setdefault('RAG_ENABLED', 'true')
os.environ.setdefault('CHROMA_PERSIST_DIR', './storage/test-chroma')
os.environ.pop('SSL_CERT_FILE', None)
os.environ.pop('SSL_CERT_DIR', None)
