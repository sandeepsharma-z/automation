import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinksFinderUI from './FinderUI';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksFinderPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Finder" subtitle="Discover blog/comment opportunities and send selected links to queue." />
        <BacklinksFinderUI />
      </main>
    </AuthGate>
  );
}
