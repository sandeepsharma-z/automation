import StatusTable from "../StatusTable";

export default function PendingPage() {
  return <StatusTable title="Pending Verification" endpoint="/api/backlinks/items?status=pending_verification,submitted" />;
}

