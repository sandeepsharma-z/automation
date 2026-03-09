import StatusTable from "../StatusTable";

export default function FailedPage() {
  return <StatusTable title="Failed / Blocked" endpoint="/api/backlinks/items?status=failed,blocked,needs_manual_mapping,skipped" />;
}

