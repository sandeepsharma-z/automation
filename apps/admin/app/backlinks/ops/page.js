import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import BacklinkOpsFrame from '../ops-frame';

export default function BacklinksOpsPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Backlink Ops" subtitle="Single workspace for queue, runs, created, pending, and failed tabs." />
        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Where To Fill Details</h3>
          <div style={{ fontSize: 14, opacity: 0.9 }}>
            Fill all backlink input details in Google Sheet (site_name, site_url, username, email, password, company_name, company_address, company_phone, company_description, target_link, category, notes).
            Output columns (status, result_title, created_link, run_id, timestamps, screenshot_url) auto-update from runner.
          </div>
        </section>
        <BacklinkOpsFrame path="/backlinks/intake" title="Backlink Operations" />
      </main>
    </AuthGate>
  );
}
