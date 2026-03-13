import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksFailedPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Failed" subtitle="Blocked / failed / skipped / mapping-required rows." />
        <StatusTable title="Failed / Blocked" endpoint="/api/backlinks/items?status=failed,blocked,needs_manual_mapping,skipped" />
      </main>
    </AuthGate>
  );
}
