'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

function parseAllowedKeywords(text) {
  return String(text || '')
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.id;
  const [project, setProject] = useState(null);
  const [settingsText, setSettingsText] = useState('{}');
  const [wpAuthMode, setWpAuthMode] = useState('basic_auth');
  const [wpUser, setWpUser] = useState('');
  const [wpAppPassword, setWpAppPassword] = useState('');
  const [wpConnectorToken, setWpConnectorToken] = useState('');
  const [shopifyStore, setShopifyStore] = useState('');
  const [shopifyToken, setShopifyToken] = useState('');
  const [shopifyBlogs, setShopifyBlogs] = useState([]);
  const [shopifyBlogsLoading, setShopifyBlogsLoading] = useState(false);
  const [shopifyBlogId, setShopifyBlogId] = useState('');
  const [shopifyAuthor, setShopifyAuthor] = useState('');
  const [shopifyTags, setShopifyTags] = useState('');
  const [shopifyPublished, setShopifyPublished] = useState(true);
  const [allowedKeywordsText, setAllowedKeywordsText] = useState('');
  const [allowedKeywordsUpdatedAt, setAllowedKeywordsUpdatedAt] = useState('');
  const [savingKeywords, setSavingKeywords] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const loadShopifyBlogs = async (id = projectId) => {
    if (!id) return;
    try {
      setShopifyBlogsLoading(true);
      const data = await apiFetch(`/api/shopify/blogs?project_id=${id}`);
      setShopifyBlogs(Array.isArray(data?.blogs) ? data.blogs : []);
    } catch (_) {
      setShopifyBlogs([]);
    } finally {
      setShopifyBlogsLoading(false);
    }
  };

  const load = async () => {
    try {
      setError('');
      const data = await apiFetch(`/api/projects/${projectId}`);
      setProject(data);
      setSettingsText(JSON.stringify(data.settings_json || {}, null, 2));
      const settings = data.settings_json || {};
      const mode = String(data.wordpress_auth_mode || data.settings_json?.wordpress_auth_mode || '').toLowerCase();
      setWpAuthMode(mode === 'token_connector' ? 'token_connector' : 'basic_auth');
      setWpUser(data.wp_user || '');
      setWpAppPassword('');
      setWpConnectorToken('');
      setShopifyStore(data.shopify_store || '');
      setShopifyToken('');
      setShopifyBlogId(settings.shopify_blog_id ? String(settings.shopify_blog_id) : '');
      setShopifyAuthor(settings.shopify_author || '');
      setShopifyTags(Array.isArray(settings.shopify_tags) ? settings.shopify_tags.join(', ') : '');
      setShopifyPublished(settings.shopify_published !== false);
      if (data.platform === 'shopify') {
        await loadShopifyBlogs(data.id);
      }
      try {
        const policy = await apiFetch(`/api/blog-agent/keyword-policy?project_id=${projectId}`);
        const keywords = Array.isArray(policy?.keywords) ? policy.keywords : [];
        setAllowedKeywordsText(keywords.join('\n'));
        setAllowedKeywordsUpdatedAt(String(policy?.updated_at || ''));
      } catch (_) {
        setAllowedKeywordsText('');
        setAllowedKeywordsUpdatedAt('');
      }
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const saveAllowedKeywords = async () => {
    try {
      setError('');
      setMsg('');
      setSavingKeywords(true);
      const keywords = parseAllowedKeywords(allowedKeywordsText);
      const data = await apiFetch('/api/blog-agent/keyword-policy', {
        method: 'PUT',
        body: JSON.stringify({
          project_id: Number(projectId),
          keywords,
        }),
      });
      const saved = Array.isArray(data?.keywords) ? data.keywords : [];
      setAllowedKeywordsText(saved.join('\n'));
      setAllowedKeywordsUpdatedAt(String(data?.updated_at || ''));
      setMsg(`Allowed keywords updated (${saved.length}).`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSavingKeywords(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      load();
    }
  }, [projectId]);

  const saveSettings = async () => {
    try {
      setError('');
      setMsg('');
      const payload = {
        settings_json: JSON.parse(settingsText),
      };
      if (project?.platform === 'wordpress') {
        payload.wordpress_auth_mode = wpAuthMode;
        if (wpAuthMode === 'token_connector') {
          if (wpConnectorToken.trim()) {
            payload.wp_connector_token = wpConnectorToken.trim();
          }
        } else {
          payload.wp_user = wpUser || null;
          if (wpAppPassword.trim()) {
            payload.wp_app_password = wpAppPassword.trim();
          }
        }
      } else {
        payload.shopify_store = shopifyStore || null;
        if (shopifyToken.trim()) {
          payload.shopify_token = shopifyToken.trim();
        }
        payload.shopify_blog_id = shopifyBlogId ? Number(shopifyBlogId) : null;
        payload.shopify_author = shopifyAuthor || null;
        payload.shopify_tags = shopifyTags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);
        payload.shopify_published = Boolean(shopifyPublished);
      }
      await apiFetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setMsg('Settings and credentials updated');
      setWpAppPassword('');
      setWpConnectorToken('');
      setShopifyToken('');
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const testConnection = async () => {
    try {
      setError('');
      if (project?.platform === 'shopify') {
        const data = await apiFetch(`/api/settings/test/shopify?project_id=${projectId}`, { method: 'POST' });
        setMsg(
          `Shopify connected: ${data.shop_name || 'shop'} (${data.primary_domain || 'domain'}) | Blogs: ${data.blogs_count || 0}`
        );
        await loadShopifyBlogs(projectId);
      } else {
        const data = await apiFetch(`/api/projects/${projectId}/test-connection`, { method: 'POST' });
        setMsg(`Connection ok: ${JSON.stringify(data.result)}`);
      }
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const syncLibrary = async () => {
    try {
      setError('');
      const data = await apiFetch(`/api/projects/${projectId}/sync-library`, { method: 'POST' });
      setMsg(`Library sync queued: ${data.task_id}`);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title={`Project ${projectId}`} />
        <div className="stack" style={{ marginBottom: 12 }}>
          <Link href={`/projects/${projectId}/library`}>Library</Link>
          <Link href={`/projects/${projectId}/topics`}>Topics</Link>
          <Link href={`/projects/${projectId}/patterns`}>Patterns</Link>
          <Link href={`/projects/${projectId}/usage`}>Usage</Link>
          <Link href={`/blog-agent?project_id=${projectId}`}>Blog Agent</Link>
        </div>

        {msg ? <div className="msg">{msg}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}

        <section className="card">
          <h2>{project?.name || 'Loading...'}</h2>
          <p>{project?.platform} | {project?.base_url}</p>
          <div className="stack" style={{ marginBottom: 12 }}>
            <button onClick={testConnection}>Test Connection</button>
            <button className="secondary" onClick={syncLibrary}>Sync Library</button>
            <button className="secondary" onClick={load}>Refresh</button>
          </div>
          {project?.platform === 'wordpress' ? (
            <>
              <div className="form-row">
                <label>
                  WordPress Auth Mode
                  <select value={wpAuthMode} onChange={(e) => setWpAuthMode(e.target.value)}>
                    <option value="basic_auth">basic_auth</option>
                    <option value="token_connector">token_connector</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                {wpAuthMode === 'token_connector' ? (
                  <label>
                    WP Connector Token
                    <input
                      type="password"
                      value={wpConnectorToken}
                      onChange={(e) => setWpConnectorToken(e.target.value)}
                      placeholder="Paste connector token from WordPress plugin"
                    />
                    <small>Test Connection will use `/wp-json/contentops/v1/ping`.</small>
                  </label>
                ) : (
                  <>
                    <label>
                      WP User
                      <input
                        value={wpUser}
                        onChange={(e) => setWpUser(e.target.value)}
                        placeholder="your-wp-username-or-email"
                      />
                    </label>
                    <label>
                      WP Application Password
                      <input
                        type="password"
                        value={wpAppPassword}
                        onChange={(e) => setWpAppPassword(e.target.value)}
                        placeholder="Paste new app password here"
                      />
                    </label>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="form-row">
              <label>
                Shopify Store (domain)
                <input
                  value={shopifyStore}
                  onChange={(e) => setShopifyStore(e.target.value)}
                  placeholder="your-store.myshopify.com"
                />
              </label>
              <label>
                Shopify Access Token
                <input
                  type="password"
                  value={shopifyToken}
                  onChange={(e) => setShopifyToken(e.target.value)}
                  placeholder="shpat_..."
                />
              </label>
              <label>
                Shopify Blog
                <select value={shopifyBlogId} onChange={(e) => setShopifyBlogId(e.target.value)}>
                  <option value="">{shopifyBlogsLoading ? 'Loading blogs...' : 'Select blog'}</option>
                  {shopifyBlogs.map((blog) => (
                    <option key={blog.id} value={blog.id}>
                      {blog.title} ({blog.handle || 'no-handle'})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Shopify Author
                <input
                  value={shopifyAuthor}
                  onChange={(e) => setShopifyAuthor(e.target.value)}
                  placeholder="ContentOps AI"
                />
              </label>
              <label>
                Shopify Tags (comma separated)
                <input
                  value={shopifyTags}
                  onChange={(e) => setShopifyTags(e.target.value)}
                  placeholder="seo, manufacturing, woven-bags"
                />
              </label>
              <label>
                Shopify Published Default
                <select
                  value={shopifyPublished ? 'true' : 'false'}
                  onChange={(e) => setShopifyPublished(e.target.value === 'true')}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>
            </div>
          )}
          <label>
            Settings JSON
            <textarea rows={16} value={settingsText} onChange={(e) => setSettingsText(e.target.value)} />
          </label>

          <label style={{ marginTop: 12 }}>
            Blog Agent Allowed Keywords (bulk: one per line)
            <textarea
              rows={8}
              value={allowedKeywordsText}
              onChange={(e) => setAllowedKeywordsText(e.target.value)}
              placeholder={'keyword 1\nkeyword 2\nkeyword 3'}
            />
          </label>
          <div className="stack" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={saveAllowedKeywords} disabled={savingKeywords}>
              {savingKeywords ? 'Saving...' : 'Save Allowed Keywords'}
            </button>
            <span className="pill muted">
              {allowedKeywordsUpdatedAt ? `Updated: ${new Date(allowedKeywordsUpdatedAt).toLocaleString()}` : 'Not saved yet'}
            </span>
          </div>

          <div className="stack" style={{ marginTop: 12 }}>
            <button onClick={saveSettings}>Save Settings</button>
          </div>
        </section>
      </main>
    </AuthGate>
  );
}
