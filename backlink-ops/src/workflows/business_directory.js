export const businessDirectoryWorkflow = {
  type: "business_directory",
  required_fields: ["site_url", "company_name", "company_address", "company_description", "target_link"],
  optional_fields: ["username", "email", "password", "company_phone", "category", "anchor_text", "notes", "tags"],
  steps: ["navigate", "fill", "review", "submit", "extract"],
  uses_playwright: true,
};
