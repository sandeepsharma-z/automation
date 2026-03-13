import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksPendingPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Pending" subtitle="Submitted rows waiting for verification." />
        <StatusTable title="Pending Verification" endpoint="/api/backlinks/items?status=pending_verification,submitted" />
      </main>
    </AuthGate>
  );
}
