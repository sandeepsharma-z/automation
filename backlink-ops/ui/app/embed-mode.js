"use client";

import { useEffect } from "react";

export default function EmbedMode() {
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("__embed")) {
        document.body.setAttribute("data-embed", "1");
      } else {
        document.body.removeAttribute("data-embed");
      }
    } catch (_) {
      // ignore
    }
  }, []);

  return null;
}
