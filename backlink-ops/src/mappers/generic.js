const FIELD_SELECTOR_MAP = {
  username: "username|name",
  email: "email",
  password: "password",
  company_name: "website_name|name",
  company_address: "address",
  company_phone: "phone",
  company_description: "description|comment_box",
  target_link: "target_link|website",
  category: "category",
  notes: "notes|comment_box|description",
};

function resolveSelector(selectors, selectorKey) {
  const keys = String(selectorKey || "").split("|").map((v) => v.trim()).filter(Boolean);
  for (const key of keys) {
    const value = selectors[key];
    if (!value) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "object") {
      const css = String(value.css || "").trim();
      const xpath = String(value.xpath || "").trim();
      if (css) return css;
      if (xpath) return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
    }
  }
  return "";
}

export async function applyGenericMapper(page, row, target) {
  const selectors = target.selectors || {};
  const filled = [];
  const missingSelectors = [];
  const failed = [];

  for (const [rowField, selectorKey] of Object.entries(FIELD_SELECTOR_MAP)) {
    const value = String(row[rowField] || "").trim();
    if (!value) continue;
    const selector = resolveSelector(selectors, selectorKey);
    if (!selector) {
      missingSelectors.push(selectorKey);
      continue;
    }
    try {
      await page.locator(selector).first().fill(value, { timeout: 5000 });
      filled.push({ row_field: rowField, selector_key: selectorKey });
    } catch (err) {
      failed.push({ row_field: rowField, selector_key: selectorKey, error: String(err.message || err) });
    }
  }

  return {
    filled,
    missingSelectors: [...new Set(missingSelectors)],
    failed,
  };
}
