function clean(value) {
  return String(value || "").trim();
}

function fallbackProfile(row) {
  const category = clean(row.category) || "Business Listing";
  const companyName = clean(row.company_name) || "Business";
  const desc =
    clean(row.company_description) ||
    `${companyName} provides trusted ${category.toLowerCase()} services with a focus on quality and customer support.`;
  const notes =
    clean(row.notes) ||
    `Use natural anchor text and include target link once where relevant. Target: ${clean(row.target_link) || "n/a"}`;
  return {
    company_description: desc,
    notes,
    category,
  };
}

export async function enrichRowWithAi(row, target) {
  const enabled = String(process.env.ENABLE_AI_PROFILE_FILL || "1") !== "0";
  if (!enabled) return { row, usedAi: false, reason: "disabled" };

  const apiKey = clean(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    const fallback = fallbackProfile(row);
    return { row: { ...row, ...fallback }, usedAi: false, reason: "missing_api_key" };
  }

  const model = clean(process.env.OPENAI_MODEL) || "gpt-4.1-mini";
  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You generate concise backlink form fields for legitimate business profile submissions. Return strict JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Create profile fields tailored to target site context.",
            target_site: {
              name: clean(target?.name),
              base_url: clean(target?.base_url),
              notes: clean(target?.notes),
            },
            row_input: {
              company_name: clean(row.company_name),
              company_address: clean(row.company_address),
              company_phone: clean(row.company_phone),
              company_description: clean(row.company_description),
              category: clean(row.category),
              notes: clean(row.notes),
              target_link: clean(row.target_link),
            },
            output_schema: {
              company_description: "string",
              notes: "string",
              category: "string",
            },
            constraints: [
              "No spammy language.",
              "Natural profile tone.",
              "Mention target_link only where useful.",
              "Max 2 short paragraphs for company_description.",
            ],
          },
          null,
          2
        ),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "profile_fill",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            company_description: { type: "string" },
            notes: { type: "string" },
            category: { type: "string" },
          },
          required: ["company_description", "notes", "category"],
        },
      },
    },
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const fallback = fallbackProfile(row);
      return { row: { ...row, ...fallback }, usedAi: false, reason: `http_${res.status}` };
    }
    const json = await res.json();
    const text = clean(json?.output_text);
    const parsed = text ? JSON.parse(text) : {};
    const merged = {
      ...row,
      company_description: clean(parsed.company_description) || clean(row.company_description),
      notes: clean(parsed.notes) || clean(row.notes),
      category: clean(parsed.category) || clean(row.category),
    };
    return { row: merged, usedAi: true, reason: "ok" };
  } catch (_) {
    const fallback = fallbackProfile(row);
    return { row: { ...row, ...fallback }, usedAi: false, reason: "exception" };
  }
}