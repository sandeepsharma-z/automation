export const imageSubmissionWorkflow = {
  type: "image_submission",
  required_fields: ["site_url", "target_link"],
  optional_fields: ["site_name", "company_name", "company_description", "username", "email", "password", "anchor_text", "category", "notes", "tags"],
  steps: ["navigate", "fill", "review", "submit", "extract"],
  uses_playwright: true,
  auto_detect_selectors: true,
};
