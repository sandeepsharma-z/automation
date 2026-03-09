import StatusTable from "../StatusTable";

export default function IntakePage() {
  return <StatusTable title="Backlink Fill Form" endpoint="/api/backlinks/queue" showRunNow />;
}

