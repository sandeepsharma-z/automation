import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import SuccessVaultUI from './SuccessVaultUI';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacklinksSuccessVaultPage() {
  return (
    <AuthGate>
      <main>
        <Header title="Success Vault" subtitle="All created backlinks in one filterable view." />
        <SuccessVaultUI />
      </main>
    </AuthGate>
  );
}
