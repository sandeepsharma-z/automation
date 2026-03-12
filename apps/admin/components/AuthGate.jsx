'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearToken, getToken } from '@/lib/api';

const PRIMARY_NAV_ITEMS = [
  { href: '/projects', label: 'Projects' },
  { href: '/drafts', label: 'Drafts' },
  { href: '/blog-agent', label: 'Blog Agent' },
  { href: '/blog-gen', label: '✍️ External Blog Generator' },
  { href: '/blog-history', label: '📋 Blog History' },
  { href: '/seo-reports', label: 'SEO Reports' },
  { href: '/settings', label: 'Settings' },
];

const BACKLINK_TYPES = [
  { type: 'all-links', label: 'All Links' },
  { type: 'directory-submission', label: 'Directory Submission' },
  { type: 'classified-ads', label: 'Classified Ads' },
  { type: 'article-submission', label: 'Article Submission' },
  { type: 'profile-creation', label: 'Profile Creation' },
  { type: 'image-submission', label: 'Image' },
  { type: 'pdf-submission', label: 'PDF' },
  { type: 'blog-commenting', label: 'Blog Commenting' },
  { type: 'social-bookmarking', label: 'Social Bookmarking' },
];

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(true);
  const [selectedType, setSelectedType] = useState('');
  const isBacklinksSection = Boolean(pathname?.startsWith('/backlinks/'));
  const activeHref =
    PRIMARY_NAV_ITEMS.filter((item) => pathname === item.href || pathname?.startsWith(`${item.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href || '';

  useEffect(() => {
    let token = null;
    try {
      token = getToken();
    } catch (_) {
      token = null;
    }
    if (!token) {
      setReady(false);
      router.replace('/');
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          if (!getToken()) {
            window.location.href = '/';
          }
        }, 120);
      }
      return;
    }
    setReady(true);
  }, [router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search || '');
    setSelectedType(String(params.get('type') || '').trim().toLowerCase());
  }, [pathname]);

  if (!ready) {
    return (
      <main style={{ padding: 24 }}>
        <div className="card">Redirecting to login...</div>
      </main>
    );
  }

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <nav className="sidebar-nav">
          {PRIMARY_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${activeHref === item.href ? 'active' : ''}`}
            >
              {item.label}
            </Link>
          ))}

          <details className={`sidebar-group ${isBacklinksSection ? 'open' : ''}`} open={isBacklinksSection}>
            <summary className={`sidebar-link sidebar-group-summary ${isBacklinksSection ? 'active' : ''}`}>
              <span>Backlinks</span>
              <span className="sidebar-chevron" aria-hidden="true" />
            </summary>
            <div className="sidebar-submenu" style={{ display: 'grid', gap: 6, marginLeft: 10 }}>
              {BACKLINK_TYPES.map((item) => {
                const href = `/backlinks/ops-entry?type=${encodeURIComponent(item.type)}`;
                const isActive = pathname === '/backlinks/ops-entry' && selectedType === item.type;
                return (
                  <Link
                    key={item.type}
                    href={href}
                    className={`sidebar-link ${isActive ? 'active' : ''}`}
                    style={{ padding: '8px 10px', fontSize: 14 }}
                  >
                    {item.label}
                  </Link>
                );
              })}
              <Link
                href="/backlinks/ops-table"
                className={`sidebar-link ${pathname === '/backlinks/ops-table' ? 'active' : ''}`}
                style={{ padding: '8px 10px', fontSize: 14 }}
              >
                Status Table
              </Link>
              <Link
                href="/backlinks/bulk-runs"
                className={`sidebar-link ${pathname === '/backlinks/bulk-runs' ? 'active' : ''}`}
                style={{ padding: '8px 10px', fontSize: 14 }}
              >
                Bulk Runs
              </Link>
              <Link
                href="/backlinks/finder"
                className={`sidebar-link ${pathname === '/backlinks/finder' ? 'active' : ''}`}
                style={{ padding: '8px 10px', fontSize: 14 }}
              >
                Backlinks Finder
              </Link>
              <Link
                href="/backlinks/success-vault"
                className={`sidebar-link ${pathname === '/backlinks/success-vault' ? 'active' : ''}`}
                style={{ padding: '8px 10px', fontSize: 14 }}
              >
                Success Vault
              </Link>
            </div>
          </details>
        </nav>

        <div className="sidebar-footer">
          <button
            className="secondary sidebar-logout"
            onClick={() => {
              clearToken();
              window.location.href = '/';
            }}
          >
            Logout
          </button>
        </div>
      </aside>

      <section className="dashboard-content">{children}</section>
    </div>
  );
}
