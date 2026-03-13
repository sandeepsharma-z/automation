'use client';

import { useEffect, useMemo, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const EMPTY = {
  openai_api_key: '',
  openai_model: 'gpt-4.1-mini',
  image_model: 'gpt-image-1',
  anthropic_api_key: '',
  anthropic_model: 'claude-sonnet-4-6',
  ai_provider: 'openai',
  opencrawl_api_url: '',
  opencrawl_api_key: '',
  default_language: 'en',
  default_country: 'in',
  default_publish_mode: 'draft',
  rag_enabled: true,
  rag_top_k: 8,
  internal_links_max: 5,
  qa_enabled: true,
  qa_strictness: 'med',
  allow_autopublish: false,
};

export default function SettingsPage() {
  const [settings, setSettings] = useState(EMPTY);
  const [providerHealth, setProviderHealth] = useState({});
  const [showOpenAIKey, setShowOpenAIKey] = useState(false);
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [claudeKeyInput, setClaudeKeyInput] = useState('');
  const [showOpenCrawlKey, setShowOpenCrawlKey] = useState(false);
  const [openCrawlKeyInput, setOpenCrawlKeyInput] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await apiFetch('/api/settings');
      const map = { ...EMPTY };
      (data.items || []).forEach((item) => {
        map[item.key] = item.value ?? EMPTY[item.key];
      });
      setSettings(map);
      setOpenaiKeyInput('');
      setClaudeKeyInput('');
      setOpenCrawlKeyInput('');
      setProviderHealth(data.provider_health || {});
      setError('');
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const badgeClass = useMemo(() => {
    return (status) => (status === 'ok' ? 'msg' : 'msg error');
  }, []);

  const saveKey = async (key, value) => {
    try {
      setError('');
      setMsg('');
      await apiFetch(`/api/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setMsg(`Saved ${key}`);
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const testOpenAI = async () => {
    try {
      setError('');
      const data = await apiFetch('/api/settings/test/openai', { method: 'POST' });
      if (data.ok) {
        setMsg(`OpenAI test passed (${data.model})`);
      } else {
        setError(data.error || 'OpenAI test failed');
      }
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const testOpenCrawl = async () => {
    try {
      setError('');
      const data = await apiFetch('/api/settings/test/opencrawl', { method: 'POST' });
      if (data.ok) {
        setMsg(`OpenCrawl test passed (${data.provider}) results=${data.results}`);
      } else {
        setError(data.error || 'OpenCrawl test failed');
      }
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const testClaude = async () => {
    try {
      setError('');
      const data = await apiFetch('/api/settings/test/claude', { method: 'POST' });
      if (data.ok) {
        setMsg(`Claude test passed (${data.model})`);
      } else {
        setError(data.error || 'Claude test failed');
      }
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title="Settings" />
        {msg ? <div className="msg">{msg}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Provider Health</h3>
          <div className="stack">
            <div className={badgeClass(providerHealth?.openai?.status)}>
              OpenAI: {providerHealth?.openai?.status || 'unknown'} ({providerHealth?.openai?.message || 'Not tested yet'})
            </div>
            <div className={badgeClass(providerHealth?.claude?.status)}>
              Claude: {providerHealth?.claude?.status || 'unknown'} ({providerHealth?.claude?.message || 'Not tested yet'})
            </div>
            <div className={badgeClass(providerHealth?.opencrawl?.status)}>
              OpenCrawl: {providerHealth?.opencrawl?.status || 'unknown'} ({providerHealth?.opencrawl?.message || 'Not tested yet'})
            </div>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>OpenAI</h3>
          <div className="form-row">
            <label>
              API Key
              <input
                type={showOpenAIKey ? 'text' : 'password'}
                value={openaiKeyInput}
                placeholder={settings.openai_api_key || 'Enter new OpenAI key'}
                onChange={(e) => setOpenaiKeyInput(e.target.value)}
              />
            </label>
            <label>
              Model
              <input
                value={settings.openai_model || ''}
                onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Image Model
              <input
                value={settings.image_model || ''}
                onChange={(e) => setSettings({ ...settings, image_model: e.target.value })}
              />
            </label>
          </div>
          <div className="stack">
            <label><input type="checkbox" checked={showOpenAIKey} onChange={(e) => setShowOpenAIKey(e.target.checked)} /> Show key</label>
            <button
              className="secondary"
              onClick={() => {
                if (!openaiKeyInput.trim()) {
                  setError('Enter a new OpenAI API key before saving.');
                  return;
                }
                saveKey('openai_api_key', openaiKeyInput.trim());
              }}
            >
              Save API Key
            </button>
            <button className="secondary" onClick={() => saveKey('openai_model', settings.openai_model)}>Save Model</button>
            <button className="secondary" onClick={() => saveKey('image_model', settings.image_model)}>Save Image Model</button>
            <button onClick={testOpenAI}>Test OpenAI</button>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Claude (Anthropic)</h3>
          <div className="form-row">
            <label>
              API Key
              <input
                type={showClaudeKey ? 'text' : 'password'}
                value={claudeKeyInput}
                placeholder={settings.anthropic_api_key || 'Enter Anthropic API key (sk-ant-...)'}
                onChange={(e) => setClaudeKeyInput(e.target.value)}
              />
            </label>
            <label>
              Model
              <select
                value={settings.anthropic_model || 'claude-sonnet-4-6'}
                onChange={(e) => setSettings({ ...settings, anthropic_model: e.target.value })}
              >
                <option value="claude-opus-4-6">claude-opus-4-6 (best quality)</option>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6 (recommended)</option>
                <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fastest)</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Active AI Provider
              <select
                value={settings.ai_provider || 'openai'}
                onChange={(e) => setSettings({ ...settings, ai_provider: e.target.value })}
              >
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="claude">Claude (Anthropic)</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <label><input type="checkbox" checked={showClaudeKey} onChange={(e) => setShowClaudeKey(e.target.checked)} /> Show key</label>
            <button
              className="secondary"
              onClick={() => {
                if (!claudeKeyInput.trim()) { setError('Enter Anthropic API key first.'); return; }
                saveKey('anthropic_api_key', claudeKeyInput.trim());
              }}
            >
              Save API Key
            </button>
            <button className="secondary" onClick={() => saveKey('anthropic_model', settings.anthropic_model)}>Save Model</button>
            <button className="secondary" onClick={() => saveKey('ai_provider', settings.ai_provider)}>Save Active Provider</button>
            <button onClick={testClaude}>Test Claude</button>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>OpenCrawl</h3>
          <div className="form-row">
            <label>
              API URL
              <input
                value={settings.opencrawl_api_url || ''}
                onChange={(e) => setSettings({ ...settings, opencrawl_api_url: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                type={showOpenCrawlKey ? 'text' : 'password'}
                value={openCrawlKeyInput}
                placeholder={settings.opencrawl_api_key || 'Enter new OpenCrawl API key'}
                onChange={(e) => setOpenCrawlKeyInput(e.target.value)}
              />
            </label>
          </div>
          <div className="stack">
            <label><input type="checkbox" checked={showOpenCrawlKey} onChange={(e) => setShowOpenCrawlKey(e.target.checked)} /> Show key</label>
            <button className="secondary" onClick={() => saveKey('opencrawl_api_url', settings.opencrawl_api_url || '')}>Save API URL</button>
            <button
              className="secondary"
              onClick={() => saveKey('opencrawl_api_key', openCrawlKeyInput.trim())}
            >
              Save API Key
            </button>
            <button onClick={testOpenCrawl}>Test OpenCrawl</button>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Publishing Defaults</h3>
          <div className="form-row">
            <label>
              Default Publish Mode
              <select
                value={settings.default_publish_mode || 'draft'}
                onChange={(e) => setSettings({ ...settings, default_publish_mode: e.target.value })}
              >
                <option value="draft">draft</option>
                <option value="publish">publish</option>
                <option value="scheduled">scheduled</option>
              </select>
            </label>
            <label>
              Allow Autopublish
              <select
                value={settings.allow_autopublish ? 'true' : 'false'}
                onChange={(e) => setSettings({ ...settings, allow_autopublish: e.target.value === 'true' })}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <button className="secondary" onClick={() => saveKey('default_publish_mode', settings.default_publish_mode)}>Save Mode</button>
            <button className="secondary" onClick={() => saveKey('allow_autopublish', settings.allow_autopublish)}>Save Autopublish</button>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>RAG Defaults</h3>
          <div className="form-row">
            <label>
              Enabled
              <select
                value={settings.rag_enabled ? 'true' : 'false'}
                onChange={(e) => setSettings({ ...settings, rag_enabled: e.target.value === 'true' })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label>
              Top K
              <input
                type="number"
                value={settings.rag_top_k}
                onChange={(e) => setSettings({ ...settings, rag_top_k: Number(e.target.value || 8) })}
              />
            </label>
            <label>
              Internal Links Max
              <input
                type="number"
                value={settings.internal_links_max}
                onChange={(e) => setSettings({ ...settings, internal_links_max: Number(e.target.value || 5) })}
              />
            </label>
          </div>
          <div className="stack">
            <button className="secondary" onClick={() => saveKey('rag_enabled', settings.rag_enabled)}>Save RAG Enabled</button>
            <button className="secondary" onClick={() => saveKey('rag_top_k', settings.rag_top_k)}>Save Top K</button>
            <button className="secondary" onClick={() => saveKey('internal_links_max', settings.internal_links_max)}>Save Link Max</button>
          </div>
        </section>

        <section className="card">
          <h3>QA Defaults</h3>
          <div className="form-row">
            <label>
              Enabled
              <select
                value={settings.qa_enabled ? 'true' : 'false'}
                onChange={(e) => setSettings({ ...settings, qa_enabled: e.target.value === 'true' })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label>
              Strictness
              <select
                value={settings.qa_strictness || 'med'}
                onChange={(e) => setSettings({ ...settings, qa_strictness: e.target.value })}
              >
                <option value="low">low</option>
                <option value="med">med</option>
                <option value="high">high</option>
              </select>
            </label>
            <label>
              Language
              <input
                value={settings.default_language || 'en'}
                onChange={(e) => setSettings({ ...settings, default_language: e.target.value })}
              />
            </label>
            <label>
              Country
              <input
                value={settings.default_country || 'in'}
                onChange={(e) => setSettings({ ...settings, default_country: e.target.value })}
              />
            </label>
          </div>
          <div className="stack">
            <button className="secondary" onClick={() => saveKey('qa_enabled', settings.qa_enabled)}>Save QA Enabled</button>
            <button className="secondary" onClick={() => saveKey('qa_strictness', settings.qa_strictness)}>Save Strictness</button>
            <button className="secondary" onClick={() => saveKey('default_language', settings.default_language)}>Save Language</button>
            <button className="secondary" onClick={() => saveKey('default_country', settings.default_country)}>Save Country</button>
          </div>
        </section>
      </main>
    </AuthGate>
  );
}
