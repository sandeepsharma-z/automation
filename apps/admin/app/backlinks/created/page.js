import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksCreatedPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Created" subtitle="Successfully created links." />
        <StatusTable title="Created (Success)" endpoint="/api/backlinks/items?status=success" />
      </main>
    </AuthGate>
  );
}
