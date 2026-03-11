import { profileListingWorkflow } from "./profile_listing.js";
import { businessDirectoryWorkflow } from "./business_directory.js";
import { resourceSubmissionWorkflow } from "./resource_submission.js";
import { imageSubmissionWorkflow } from "./image_submission.js";
import { outreachEmailWorkflow } from "./outreach_email.js";
import { citationUpdateWorkflow } from "./citation_update.js";
import { blogCommentingWorkflow } from "./blog_commenting.js";
import { backlinksFinderWorkflow } from "./backlinks_finder.js";

const WORKFLOWS = {
  [profileListingWorkflow.type]: profileListingWorkflow,
  [businessDirectoryWorkflow.type]: businessDirectoryWorkflow,
  [resourceSubmissionWorkflow.type]: resourceSubmissionWorkflow,
  [imageSubmissionWorkflow.type]: imageSubmissionWorkflow,
  [outreachEmailWorkflow.type]: outreachEmailWorkflow,
  [citationUpdateWorkflow.type]: citationUpdateWorkflow,
  [blogCommentingWorkflow.type]: blogCommentingWorkflow,
  [backlinksFinderWorkflow.type]: backlinksFinderWorkflow,
};

export function listWorkflows() {
  return Object.values(WORKFLOWS);
}

export function getWorkflow(type) {
  const key = String(type || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return WORKFLOWS[key] || businessDirectoryWorkflow;
}
