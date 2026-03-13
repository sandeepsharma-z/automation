import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import StatusTable from '../StatusTable';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksOpsTablePage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlink Table" subtitle="See all rows and backlink creation status." />
        <StatusTable title="All Backlink Rows" endpoint="/api/backlinks/items" />
      </main>
    </AuthGate>
  );
}
