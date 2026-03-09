'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const defaultSettings = {
  language: 'en',
  country: 'us',
  tone: 'professional',
  persona: 'subject matter expert',
  reading_level: 'grade 8',
  style_rules: [],
  banned_claims: [],
  default_publish_mode: 'draft',
  image_generation_enabled: true,
};

export default function NewProjectPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    platform: 'wordpress',
    wordpress_auth_mode: 'basic_auth',
    base_url: '',
    wp_user: '',
    wp_app_password: '',
    wp_connector_token: '',
    shopify_store: '',
    shopify_token: '',
    settings_json: JSON.stringify(defaultSettings, null, 2),
  });
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const payload = {
        ...form,
        settings_json: JSON.parse(form.settings_json || '{}'),
      };
      if (payload.platform === 'wordpress') {
        if (payload.wordpress_auth_mode === 'token_connector') {
          payload.wp_user = null;
          payload.wp_app_password = null;
        } else {
          payload.wp_connector_token = null;
        }
      }
      const created = await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      router.push(`/projects/${created.id}`);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title="Create Project" />
        <section className="card">
          {error ? <div className="msg error">{error}</div> : null}
          <form onSubmit={submit}>
            <div className="form-row">
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label>
                Platform
                <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                  <option value="wordpress">WordPress</option>
                  <option value="shopify">Shopify</option>
                </select>
              </label>
            </div>

            <div className="form-row">
              <label>
                Base URL
                <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} required />
              </label>
            </div>

            {form.platform === 'wordpress' ? (
              <>
                <div className="form-row">
                  <label>
                    WordPress Auth Mode
                    <select
                      value={form.wordpress_auth_mode}
                      onChange={(e) => setForm({ ...form, wordpress_auth_mode: e.target.value })}
                    >
                      <option value="basic_auth">basic_auth</option>
                      <option value="token_connector">token_connector</option>
                    </select>
                  </label>
                </div>

                {form.wordpress_auth_mode === 'token_connector' ? (
                  <div className="form-row">
                    <label>
                      WP Connector Token
                      <input
                        type="password"
                        value={form.wp_connector_token}
                        onChange={(e) => setForm({ ...form, wp_connector_token: e.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="form-row">
                    <label>
                      WP User
                      <input value={form.wp_user} onChange={(e) => setForm({ ...form, wp_user: e.target.value })} />
                    </label>
                    <label>
                      WP App Password
                      <input value={form.wp_app_password} onChange={(e) => setForm({ ...form, wp_app_password: e.target.value })} />
                    </label>
                  </div>
                )}
              </>
            ) : (
              <div className="form-row">
                <label>
                  Shopify Store (domain)
                  <input value={form.shopify_store} onChange={(e) => setForm({ ...form, shopify_store: e.target.value })} />
                </label>
                <label>
                  Shopify Access Token
                  <input value={form.shopify_token} onChange={(e) => setForm({ ...form, shopify_token: e.target.value })} />
                </label>
              </div>
            )}

            <label>
              Settings JSON
              <textarea rows={14} value={form.settings_json} onChange={(e) => setForm({ ...form, settings_json: e.target.value })} />
            </label>
            <div className="stack" style={{ marginTop: 12 }}>
              <button type="submit">Create</button>
            </div>
          </form>
        </section>
      </main>
    </AuthGate>
  );
}
