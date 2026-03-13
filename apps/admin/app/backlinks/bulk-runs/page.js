import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BulkRunsUI from './BulkRunsUI';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksBulkRunsPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Bulk Runs" subtitle="CSV/paste import, validation, and per-run drill-down." />
        <BulkRunsUI />
      </main>
    </AuthGate>
  );
}
