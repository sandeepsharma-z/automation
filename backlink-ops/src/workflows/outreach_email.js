export const outreachEmailWorkflow = {
  type: "outreach_email",
  required_fields: ["target_link", "company_name"],
  optional_fields: ["site_url", "site_name", "email", "company_description", "anchor_text", "notes", "tags"],
  steps: ["draft_email", "human_review", "crm_track"],
  uses_playwright: false,
};

