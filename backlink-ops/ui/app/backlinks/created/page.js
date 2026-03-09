import StatusTable from "../StatusTable";

export default function CreatedPage() {
  return <StatusTable title="Created (Success)" endpoint="/api/backlinks/items?status=success" />;
}

