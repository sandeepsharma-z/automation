import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksRunsPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Runs" subtitle="Run history grouped by run_id." />
        <BacklinkOpsFrame path="/backlinks/runs" title="Runs Table" />
      </main>
    </AuthGate>
  );
}

