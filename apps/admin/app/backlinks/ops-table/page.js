import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksOpsTablePage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlink Table" subtitle="See all rows and backlink creation status." />
        <BacklinkOpsFrame path="/backlinks/table" title="Backlink Status Table" compact />
      </main>
    </AuthGate>
  );
}
