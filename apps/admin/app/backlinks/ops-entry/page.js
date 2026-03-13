import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

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

export default async function BacklinksOpsEntryPage({ searchParams }) {
  const sp = await searchParams;
  const typeRaw = String(sp?.type || '').trim().toLowerCase();
  const type = /^[a-z0-9-]+$/.test(typeRaw) ? typeRaw : '';
  const typeLabel = TYPE_LABELS[type] || '';
  const endpoint = type
    ? `/api/backlinks/queue?type=${encodeURIComponent(type)}`
    : '/api/backlinks/queue';

  return (
    <AuthGate>
      <main>
        <Header title="Backlink Fill" subtitle="Fill website/backlink details and start processing." />
        <StatusTable
          title={typeLabel ? `Backlink Fill Form - ${typeLabel}` : 'Backlink Fill Form'}
          endpoint={endpoint}
          showRunNow
        />
      </main>
    </AuthGate>
  );
}
