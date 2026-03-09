import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksFailedPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Failed" subtitle="Blocked / failed / skipped / mapping-required rows." />
        <BacklinkOpsFrame path="/backlinks/failed" title="Failed Table" />
      </main>
    </AuthGate>
  );
}

