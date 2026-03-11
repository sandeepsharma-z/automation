export const WORKFLOW_REGISTRY = {
  profile_listing: {
    type: "profile_listing",
    required_fields: ["site_url", "company_name", "company_description", "target_link"],
    optional_fields: ["username", "email", "password", "company_address", "company_phone", "anchor_text", "notes", "tags"],
    steps: ["navigate", "fill", "review", "submit", "extract"],
    uses_playwright: true,
  },
  business_directory: {
    type: "business_directory",
    required_fields: ["site_url", "company_name", "company_address", "company_description", "target_link"],
    optional_fields: ["username", "email", "password", "company_phone", "category", "anchor_text", "notes", "tags"],
    steps: ["navigate", "fill", "review", "submit", "extract"],
    uses_playwright: true,
  },
  resource_submission: {
    type: "resource_submission",
    required_fields: ["site_url", "target_link"],
    optional_fields: ["site_name", "company_name", "company_description", "anchor_text", "notes", "tags"],
    steps: ["navigate", "fill", "review", "submit", "extract"],
    uses_playwright: true,
  },
  image_submission: {
    type: "image_submission",
    required_fields: ["site_url", "target_link"],
    optional_fields: ["site_name", "company_name", "company_description", "username", "email", "password", "anchor_text", "category", "notes", "tags"],
    steps: ["navigate", "fill", "review", "submit", "extract"],
    uses_playwright: true,
    auto_detect_selectors: true,
  },
  outreach_email: {
    type: "outreach_email",
    required_fields: ["target_link", "company_name"],
    optional_fields: ["site_url", "site_name", "email", "company_description", "anchor_text", "notes", "tags"],
    steps: ["draft_email", "human_review", "crm_track"],
    uses_playwright: false,
  },
  citation_update: {
    type: "citation_update",
    required_fields: ["site_url", "company_name", "company_address", "company_phone", "target_link"],
    optional_fields: ["username", "email", "password", "company_description", "notes", "tags"],
    steps: ["navigate", "fill", "review", "submit", "extract"],
    uses_playwright: true,
  },
  blog_commenting: {
    type: "blog_commenting",
    required_fields: ["target_link"],
    optional_fields: ["site_url", "site_name", "username", "email", "password", "company_name", "company_description", "notes", "anchor_text", "tags"],
    required_selectors: ["comment_box", "submit_button"],
    steps: ["navigate", "detect_comment_form", "fill", "review", "submit", "extract"],
    uses_playwright: true,
  },
  backlinks_finder: {
    type: "backlinks_finder",
    required_fields: ["target_link"],
    optional_fields: ["site_url", "site_name", "notes", "tags"],
    required_selectors: [],
    steps: ["search", "collect", "enqueue"],
    uses_playwright: true,
  },
};

export function getWorkflow(type) {
  const key = String(type || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return WORKFLOW_REGISTRY[key] || WORKFLOW_REGISTRY.business_directory;
}

export function listWorkflows() {
  return Object.values(WORKFLOW_REGISTRY);
}
