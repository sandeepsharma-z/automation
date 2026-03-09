import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TYPE_LABELS = {
  'all-links': 'All Links',
  'directory-submission': 'Directory Submission',
  'classified-ads': 'Classified Ads',
  'article-submission': 'Article Submission',
  'profile-creation': 'Profile Creation',
  'image-submission': 'Image',
  'pdf-submission': 'PDF',
  'blog-commenting': 'Blog Commenting',
  'social-bookmarking': 'Social Bookmarking',
};

export default function BacklinksOpsEntryPage({ searchParams }) {
  const typeRaw = String(searchParams?.type || '').trim().toLowerCase();
  const type = /^[a-z0-9-]+$/.test(typeRaw) ? typeRaw : '';
  const typeLabel = TYPE_LABELS[type] || '';
  const path = type ? `/backlinks/intake?type=${encodeURIComponent(type)}` : '/backlinks/intake';

  return (
    <AuthGate>
      <main>
        <Header title="Backlink Fill" subtitle="Fill website/backlink details and start processing." />
        <BacklinkOpsFrame
          path={path}
          title={typeLabel ? `Backlink Fill Form - ${typeLabel}` : 'Backlink Fill Form'}
          compact
        />
      </main>
    </AuthGate>
  );
}

