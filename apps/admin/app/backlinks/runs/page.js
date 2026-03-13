import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import RunsUI from './RunsUI';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksRunsPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlinks Runs" subtitle="Run history grouped by run_id." />
        <RunsUI />
      </main>
    </AuthGate>
  );
}
