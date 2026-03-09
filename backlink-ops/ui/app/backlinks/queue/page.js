import StatusTable from "../StatusTable";

export default function QueuePage() {
  return <StatusTable title="Queue" endpoint="/api/backlinks/queue" showRunNow />;
}

