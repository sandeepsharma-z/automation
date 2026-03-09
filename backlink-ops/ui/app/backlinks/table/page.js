import StatusTable from "../StatusTable";

export default function TablePage() {
  return <StatusTable title="All Backlink Rows" endpoint="/api/backlinks/items" />;
}

