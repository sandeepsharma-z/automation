"use client";

import { useEffect } from "react";

export default function RecoveryFlagClearer() {
  useEffect(() => {
    try {
      sessionStorage.removeItem("backlink_ops_chunk_reload_once");
    } catch (_) {
      // Ignore storage access errors.
    }
  }, []);
  return null;
}
