export const citationUpdateWorkflow = {
  type: "citation_update",
  required_fields: ["site_url", "company_name", "company_address", "company_phone", "target_link"],
  optional_fields: ["username", "email", "password", "company_description", "notes", "tags"],
  steps: ["navigate", "fill", "review", "submit", "extract"],
  uses_playwright: true,
};
