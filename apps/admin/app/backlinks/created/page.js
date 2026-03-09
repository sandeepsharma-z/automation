import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksCreatedPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Created" subtitle="Successfully created links." />
        <BacklinkOpsFrame path="/backlinks/created" title="Created Table" />
      </main>
    </AuthGate>
  );
}

