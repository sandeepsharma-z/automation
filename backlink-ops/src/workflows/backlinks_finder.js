export const backlinksFinderWorkflow = {
  type: "backlinks_finder",
  required_fields: ["target_link"],
  optional_fields: ["site_url", "site_name", "notes", "tags"],
  required_selectors: [],
  steps: ["search", "collect", "enqueue"],
  uses_playwright: true,
};
