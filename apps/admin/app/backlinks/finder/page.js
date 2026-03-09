import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksFinderPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Finder" subtitle="Discover blog/comment targets and send selected links to queue." />
        <BacklinkOpsFrame path="/backlinks/finder" title="Backlinks Finder" compact />
      </main>
    </AuthGate>
  );
}
