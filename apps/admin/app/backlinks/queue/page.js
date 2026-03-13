import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksQueuePage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Queue" subtitle="Queued rows from Backlink Operations sheet." />
        <StatusTable title="Queue" endpoint="/api/backlinks/queue" showRunNow />
      </main>
    </AuthGate>
  );
}
