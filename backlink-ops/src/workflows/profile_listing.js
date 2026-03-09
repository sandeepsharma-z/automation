export const profileListingWorkflow = {
  type: "profile_listing",
  required_fields: ["site_url", "company_name", "company_description", "target_link"],
  optional_fields: ["username", "email", "password", "company_address", "company_phone", "anchor_text", "notes", "tags"],
  steps: ["navigate", "fill", "review", "submit", "extract"],
  uses_playwright: true,
};
