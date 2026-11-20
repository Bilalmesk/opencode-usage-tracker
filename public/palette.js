/* Stable, per-provider colors shared by the dashboard, charts, and widget. */
(() => {
  "use strict";

  // Fixed colors for the plans with dedicated sections. These are deliberately
  // far apart in hue: violet, amber, pink.
  const FIXED = {
    free: "#8b5cf6",
    go: "#f59e0b",
    zen: "#ec4899",
  };

  // External providers get distinct colors from this pool. Blue/emerald/cyan
  // are intentionally first so an external API never looks like Go's amber.
  const EXTERNAL = [
    "#3b82f6", // blue
    "#10b981", // emerald
    "#06b6d4", // cyan
    "#84cc16", // lime
    "#14b8a6", // teal
    "#94a3b8", // slate
  ];

  const cache = new Map();

  function hash(value) {
    let h = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      h = (h * 31 + text.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  /**
   * Accepts a provider object from `/api/usage` or a raw key string.
   * Returns an uppercase hex color and caches it for the session.
   */
  window.ocProviderColor = function ocProviderColor(provider) {
    const value = typeof provider === "string" ? { key: provider } : provider || {};
    const kind =
      value.kind || (value.key && String(value.key).includes(":") ? String(value.key).split(":")[0] : "");
    const key =
      value.key ||
      `${kind}:${value.provider || value.providerName || value.model || "unknown"}`;

    if (cache.has(key)) return cache.get(key);

    let color = FIXED[kind];
    if (!color) {
      const used = new Set(cache.values());
      const start = hash(key) % EXTERNAL.length;
      color = EXTERNAL[start];
      for (let i = 0; i < EXTERNAL.length; i += 1) {
        const candidate = EXTERNAL[(start + i) % EXTERNAL.length];
        if (!used.has(candidate)) {
          color = candidate;
          break;
        }
      }
    }

    cache.set(key, color);
    return color;
  };
})();
