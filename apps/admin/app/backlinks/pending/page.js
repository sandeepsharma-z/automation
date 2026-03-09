import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksPendingPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Pending" subtitle="Submitted rows waiting for verification." />
        <BacklinkOpsFrame path="/backlinks/pending" title="Pending Table" />
      </main>
    </AuthGate>
  );
}

