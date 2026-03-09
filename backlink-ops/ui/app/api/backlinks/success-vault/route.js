import { NextResponse } from "next/server";
import { listSuccessVault } from "../../../../lib/backend";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = String(searchParams.get("q") || "").trim().toLowerCase();
    const type = String(searchParams.get("type") || "").trim().toLowerCase();

    let entries = listSuccessVault();
    if (type) {
      entries = entries.filter((item) => String(item.backlink_type || "").toLowerCase() === type);
    }
    if (q) {
      entries = entries.filter((item) =>
        [item.site_url, item.site_name, item.target_link, item.created_link, item.submitted_comment_link, item.result_title]
          .some((value) => String(value || "").toLowerCase().includes(q))
      );
    }

    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
