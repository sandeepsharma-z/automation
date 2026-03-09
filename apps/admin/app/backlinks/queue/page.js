import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksQueuePage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Queue" subtitle="Queued rows from Backlink Operations sheet." />
        <BacklinkOpsFrame path="/backlinks/queue" title="Queue Table" />
      </main>
    </AuthGate>
  );
}

