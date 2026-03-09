async function pickSelectorOnPage(page, label) {
  return page.evaluate(async (fieldLabel) => {
    return new Promise((resolve) => {
      const toCssPath = (el) => {
        if (!(el instanceof Element)) return "";
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 8) {
          let selector = node.nodeName.toLowerCase();
          if (node.id) {
            selector += `#${CSS.escape(node.id)}`;
            parts.unshift(selector);
            break;
          }
          if (node.classList && node.classList.length) {
            selector += `.${Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".")}`;
          }
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.nodeName === node.nodeName);
            if (siblings.length > 1) {
              const idx = siblings.indexOf(node) + 1;
              selector += `:nth-of-type(${idx})`;
            }
          }
          parts.unshift(selector);
          node = node.parentElement;
        }
        return parts.join(" > ");
      };

      const toXPath = (el) => {
        if (!(el instanceof Element)) return "";
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          let ix = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.nodeName === node.nodeName) ix += 1;
            sib = sib.previousElementSibling;
          }
          parts.unshift(`${node.nodeName.toLowerCase()}[${ix}]`);
          node = node.parentElement;
        }
        return `/${parts.join("/")}`;
      };

      const oldCursor = document.body.style.cursor;
      const oldOutline = new WeakMap();
      let hoverEl = null;

      const overlay = document.createElement("div");
      overlay.setAttribute("data-selector-overlay", "1");
      overlay.style.cssText = [
        "position:fixed",
        "top:14px",
        "right:14px",
        "z-index:2147483647",
        "max-width:420px",
        "background:rgba(9,17,36,0.95)",
        "color:#e5eefc",
        "padding:12px 14px",
        "border:1px solid #3b82f6",
        "border-radius:12px",
        "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
        "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
      ].join(";");
      overlay.innerHTML = `
        <div style="font-weight:700;margin-bottom:6px;">Map Selector</div>
        <div style="margin-bottom:10px;">Click element for <b>${fieldLabel}</b></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="skipSelMap" style="border:1px solid #64748b;background:#0f172a;color:#e2e8f0;padding:4px 10px;border-radius:8px;cursor:pointer;">Skip</button>
          <span style="font-size:12px;color:#93c5fd;">Hover = highlight, click = select</span>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanHover = () => {
        if (hoverEl && oldOutline.has(hoverEl)) {
          hoverEl.style.outline = oldOutline.get(hoverEl);
        }
        hoverEl = null;
      };

      const cleanup = () => {
        document.body.style.cursor = oldCursor;
        cleanHover();
        overlay.remove();
        document.removeEventListener("mouseover", onMouseOver, true);
        document.removeEventListener("mouseout", onMouseOut, true);
        document.removeEventListener("click", onClick, true);
      };

      const onMouseOver = (ev) => {
        const el = ev.target;
        if (!(el instanceof Element)) return;
        if (overlay.contains(el)) return;
        cleanHover();
        hoverEl = el;
        oldOutline.set(el, el.style.outline);
        el.style.outline = "2px solid #60a5fa";
      };

      const onMouseOut = () => {
        cleanHover();
      };

      const onClick = (ev) => {
        const el = ev.target;
        if (!(el instanceof Element)) return;
        if (overlay.contains(el)) return;
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
        resolve({
          skipped: false,
          css: toCssPath(el),
          xpath: toXPath(el),
          tag: el.tagName.toLowerCase(),
        });
      };

      const skipBtn = overlay.querySelector("#skipSelMap");
      if (skipBtn) {
        skipBtn.addEventListener("click", () => {
          cleanup();
          resolve({ skipped: true, css: "", xpath: "", tag: "" });
        });
      }

      document.body.style.cursor = "crosshair";
      document.addEventListener("mouseover", onMouseOver, true);
      document.addEventListener("mouseout", onMouseOut, true);
      document.addEventListener("click", onClick, true);
    });
  });
}

export async function runInteractiveSelectorMapper(page, fields = []) {
  // Inject stealth before mapping
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  
  const mapped = {};
  for (const field of fields) {
    const label = String(field?.label || field?.key || "field");
    const picked = await pickSelectorOnPage(page, label);
    if (!picked || picked.skipped) continue;
    const key = String(field?.key || "").trim();
    if (!key) continue;
    mapped[key] = {
      css: picked.css || "",
      xpath: picked.xpath || "",
    };
  }
  return mapped;
}