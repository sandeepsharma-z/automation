import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksOpsPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlink Ops" subtitle="Single workspace for queue, runs, created, pending, and failed tabs." />
        <StatusTable title="Backlink Fill Form" endpoint="/api/backlinks/queue" showRunNow />
      </main>
    </AuthGate>
  );
}
