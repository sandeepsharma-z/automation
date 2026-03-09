export const blogCommentingWorkflow = {
  type: "blog_commenting",
  required_fields: ["target_link"],
  optional_fields: [
    "site_url",
    "site_name",
    "username",
    "email",
    "password",
    "company_name",
    "company_description",
    "notes",
    "anchor_text",
    "tags",
  ],
  required_selectors: ["comment_box", "submit_button"],
  steps: ["navigate", "detect_comment_form", "fill", "review", "submit", "extract"],
  uses_playwright: true,
};

