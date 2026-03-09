export const resourceSubmissionWorkflow = {
  type: "resource_submission",
  required_fields: ["site_url", "target_link"],
  optional_fields: ["site_name", "company_name", "company_description", "anchor_text", "notes", "tags"],
  steps: ["navigate", "fill", "review", "submit", "extract"],
  uses_playwright: true,
};
