/* V2 mission-control shell: views, overview, theme, command palette. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const VIEWS = ["overview", "free", "go", "providers", "history", "console"];
  const VIEW_LABELS = {
    overview: "Overview",
    free: "Free tier",
    go: "Go plan",
    providers: "Providers",
    history: "History",
    console: "Console",
  };
  const KIND_COLORS = {
    free: "#8b5cf6",
    go: "#22d3ee",
    zen: "#fbbf24",
    external: "#34d399",
  };
  const KIND_LABELS = {
    free: "Free",
    go: "Go",
    zen: "Zen",
    external: "API",
  };

  const state = {
    view: "overview",
    range: 14,
    theme: "dark",
    data: null,
    commandIndex: 0,
    commands: [],
  };

  const fmtInt = (v) => new Intl.NumberFormat().format(Math.round(Number(v) || 0));
  const fmtCompact = (v) =>
    new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
      Number(v) || 0,
    );
  const fmtUsd = (v) => {
    const x = Number(v) || 0;
    if (x === 0) return "$0.00";
    if (x >= 1000) return "$" + new Intl.NumberFormat().format(Math.round(x));
    return "$" + (x >= 10 ? x.toFixed(2) : x.toFixed(3));
  };
  const fmtPct = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? `${x.toFixed(1)}%` : "–";
  };
  const fmtDuration = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return "now";
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  const theme = () => document.documentElement.dataset.theme || "dark";
  const isLight = () => theme() === "light";
  const axisColor = () => (isLight() ? "#6b7280" : "#6b7488");
  const gridColor = () => (isLight() ? "rgba(17,24,39,0.08)" : "rgba(255,255,255,0.06)");

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function providerColor(kind, index = 0) {
    const base = KIND_COLORS[kind] || "#8b5cf6";
    if (index % 2 === 0) return base;
    return kind === "external" ? "#2dd4bf" : base;
  }

  /* ---------------- Theme ---------------- */

  function setTheme(next) {
    state.theme = next === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    try {
      localStorage.setItem("oc-tracker-theme", state.theme);
    } catch {
      /* private mode */
    }
    const label = $("v2ThemeLabel");
    if (label) label.textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
    if (window.load && state.data) window.load(false);
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("oc-tracker-theme");
    } catch {
      /* ignore */
    }
    // The tracker's identity is dark by default; light is an explicit choice.
    const preferred = saved || "dark";
    document.documentElement.dataset.theme = preferred === "light" ? "light" : "dark";
    state.theme = preferred === "light" ? "light" : "dark";
    const label = $("v2ThemeLabel");
    if (label) label.textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
  }

  /* ---------------- Views ---------------- */

  function availableViews() {
    const views = new Set(["overview", "free", "history", "console"]);
    if (state.data && state.data.go && state.data.go.detected) views.add("go");
    if (state.data && state.data.all && state.data.all.detected) {
      const all = state.data.all;
      if ((all.providerCount || 0) > 1 || (all.kinds || []).some((kind) => kind !== "free")) {
        views.add("providers");
      }
    }
    return views;
  }

  function setView(view, { updateHash = true } = {}) {
    if (!VIEWS.includes(view)) view = "overview";
    if (state.data && !availableViews().has(view)) view = "overview";
    state.view = view;

    document.querySelectorAll(".v2-main [data-view]").forEach((el) => {
      el.classList.toggle("v2-view-off", el.dataset.view !== view);
    });

    for (const button of document.querySelectorAll(".v2-nav [data-view]")) {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    }
    const crumb = $("v2Crumb");
    if (crumb) crumb.textContent = VIEW_LABELS[view] || "Overview";
    document.title = `${VIEW_LABELS[view] || "Overview"} · OpenCode Usage`;
    document.body.classList.remove("v2-nav-open");
    const menu = $("v2MenuBtn");
    if (menu) menu.setAttribute("aria-expanded", "false");

    if (updateHash) {
      const hash = `#/${view}`;
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }
    if (view === "overview" && state.data) renderOverview(state.data);
  }

  function initView() {
    const forButtons = () => {
      document.querySelectorAll(".v2-nav [data-view]").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.view));
      });
    };
    forButtons();

    document.addEventListener("click", (event) => {
      const jump = event.target.closest("[data-view-jump]");
      if (jump) setView(jump.dataset.viewJump);
    });

    const fromHash = () => {
      const match = location.hash.match(/^#\/([a-z]+)$/);
      return match && VIEWS.includes(match[1]) ? match[1] : "overview";
    };
    window.addEventListener("hashchange", () => setView(fromHash(), { updateHash: false }));
    setView(fromHash(), { updateHash: false });
  }

  function initMobileNav() {
    const menu = $("v2MenuBtn");
    const backdrop = $("v2Backdrop");
    const close = () => {
      document.body.classList.remove("v2-nav-open");
      if (menu) menu.setAttribute("aria-expanded", "false");
    };
    if (menu) {
      menu.addEventListener("click", () => {
        const open = !document.body.classList.contains("v2-nav-open");
        document.body.classList.toggle("v2-nav-open", open);
        menu.setAttribute("aria-expanded", String(open));
      });
    }
    if (backdrop) backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  /* ---------------- Command palette ---------------- */

  function buildCommands() {
    const commands = VIEWS.filter((view) => availableViews().has(view)).map((view) => ({
      label: `Go to ${VIEW_LABELS[view]}`,
      hint: view,
      run: () => setView(view),
    }));
    commands.push(
      { label: "Refresh usage data", hint: "reload", run: () => window.load && window.load(true) },
      {
        label: "Sync Console now",
        hint: "console",
        run: () => {
          setView("console");
          const button = $("consoleSyncBtn");
          if (button) button.click();
        },
      },
      {
        label: `Switch to ${state.theme === "dark" ? "light" : "dark"} mode`,
        hint: "theme",
        run: () => setTheme(state.theme === "dark" ? "light" : "dark"),
      },
      { label: "Download free CSV", hint: "csv", run: () => (location.href = "/api/export.csv") },
      { label: "Download Go CSV", hint: "csv", run: () => (location.href = "/api/export-go.csv") },
      { label: "Download all-provider CSV", hint: "csv", run: () => (location.href = "/api/export-all.csv") },
    );
    return commands;
  }

  function renderCommandList() {
    const input = $("v2CommandInput");
    const list = $("v2CommandList");
    if (!input || !list) return;
    const query = input.value.trim().toLowerCase();
    state.commands = buildCommands().filter(
      (command) => !query || command.label.toLowerCase().includes(query) || command.hint.includes(query),
    );
    state.commandIndex = Math.min(state.commandIndex, Math.max(0, state.commands.length - 1));
    list.textContent = "";
    if (!state.commands.length) {
      list.append(node("div", "v2-command-empty", "No matching action."));
      return;
    }
    state.commands.forEach((command, index) => {
      const button = node("button", index === state.commandIndex ? "active" : "");
      button.type = "button";
      button.append(node("span", null, command.label), node("kbd", null, command.hint));
      button.addEventListener("click", () => runCommand(index));
      list.append(button);
    });
  }

  function runCommand(index) {
    const command = state.commands[index];
    if (!command) return;
    const dialog = $("v2Command");
    if (dialog && dialog.open) dialog.close();
    command.run();
  }

  function openCommand() {
    const dialog = $("v2Command");
    if (!dialog) return;
    const input = $("v2CommandInput");
    if (dialog.open) {
      if (input) input.focus();
      return;
    }
    state.commandIndex = 0;
    if (input) input.value = "";
    renderCommandList();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (input) input.focus();
  }

  function initCommand() {
    const dialog = $("v2Command");
    const input = $("v2CommandInput");
    const opener = $("v2CmdBtn");
    if (opener) opener.addEventListener("click", openCommand);
    if (input) {
      input.addEventListener("input", () => {
        state.commandIndex = 0;
        renderCommandList();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          state.commandIndex = Math.min(state.commands.length - 1, state.commandIndex + 1);
          renderCommandList();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          state.commandIndex = Math.max(0, state.commandIndex - 1);
          renderCommandList();
        } else if (event.key === "Enter") {
          event.preventDefault();
          runCommand(state.commandIndex);
        }
      });
    }
    if (dialog) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommand();
      }
    });
  }

  /* ---------------- Overview ---------------- */

  function planChips(all) {
    const wrap = $("ovPlans");
    if (!wrap) return;
    wrap.textContent = "";
    const seen = new Set();
    for (const provider of all.providers || []) {
      const key = `${provider.kind}:${provider.provider}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const chip = node("span", "v2-chip");
      const dot = node("span", "dot");
      dot.style.background = KIND_COLORS[provider.kind] || "#8b5cf6";
      chip.append(dot, provider.kind === "external" ? provider.providerName : provider.plan);
      wrap.append(chip);
    }
    if (!wrap.childElementCount) {
      const chip = node("span", "v2-chip", "Waiting for usage…");
      wrap.append(chip);
    }
  }

  function sparkline(values, colorA = "#8b5cf6", colorB = "#22d3ee") {
    const wrap = node("div", "v2-spark");
    const max = Math.max(...values, 1);
    for (const value of values) {
      const bar = node("i");
      bar.style.height = `${Math.max(3, Math.round((value / max) * 26))}px`;
      bar.style.background = `linear-gradient(180deg, ${colorA}, ${colorB})`;
      wrap.append(bar);
    }
    return wrap;
  }

  function kpiCard(label, value, sub, values, colors) {
    const card = node("div", "v2-kpi");
    card.append(node("div", "k", label), node("div", "v", value), node("div", "s", sub));
    if (values && values.length) card.append(sparkline(values, colors && colors[0], colors && colors[1]));
    return card;
  }

  function renderKpis(data) {
    const wrap = $("ovKpis");
    if (!wrap) return;
    const all = data.all || {};
    const go = data.go || {};
    const win = data.window || {};
    const days = (all.days || []).slice(-14);
    const requests = days.map((day) => day.requests);
    const tokens = days.map((day) => (day.tokens ? day.tokens.total : 0));
    const costs = days.map((day) => day.costUsd || 0);
    wrap.textContent = "";
    wrap.append(
      kpiCard(
        "Today · requests",
        fmtInt(all.today ? all.today.requests : 0),
        `${all.providerCount || 0} providers · ${all.today ? all.today.sessions : 0} sessions`,
        requests,
      ),
      kpiCard(
        "Today · tokens",
        fmtCompact(all.today && all.today.tokens ? all.today.tokens.total : 0),
        all.today && all.today.tokens
          ? `${fmtCompact(all.today.tokens.input)} in · ${fmtCompact(all.today.tokens.output)} out`
          : "no tokens yet",
        tokens,
        ["#22d3ee", "#34d399"],
      ),
      kpiCard(
        "Today · local cost",
        fmtUsd(all.today ? all.today.costUsd : 0),
        "reported by OpenCode · Go is covered",
        costs,
        ["#fbbf24", "#fb7185"],
      ),
      kpiCard(
        "Free window",
        fmtInt(win.usedRequests || 0),
        win.headroomRequests != null
          ? win.headroomRequests > 0
            ? `${fmtInt(win.headroomRequests)} to last boundary`
            : "at or past the last boundary"
          : "no refusal boundary yet",
        requests,
        ["#8b5cf6", "#6d3ef0"],
      ),
    );

    if (go.detected && go.meters && go.meters.month) {
      const month = go.meters.month;
      wrap.append(
        kpiCard(
          "Go month meter",
          `${fmtUsd(month.usedUsd)} / ${fmtUsd(month.limitUsd)}`,
          `${fmtPct(month.percent)} used · resets in ${fmtDuration(
            Date.parse(month.resetsAt) - Date.now(),
          )}`,
        ),
      );
    }
  }

  function stackedChart(days) {
    const width = 760;
    const height = 240;
    const padL = 38;
    const padR = 8;
    const padT = 12;
    const padB = 24;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const totals = days.map((day) => day.requests || 0);
    const max = Math.max(...totals, 1);
    const gap = days.length > 20 ? 3 : 6;
    const bw = Math.max(3, (innerW - gap * Math.max(0, days.length - 1)) / Math.max(1, days.length));
    const kinds = ["free", "go", "zen", "external"];
    const yOf = (value) => padT + innerH - (value / max) * innerH;

    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Requests by plan per UTC day">`;
    for (let i = 0; i <= 4; i += 1) {
      const y = padT + (innerH * i) / 4;
      const value = (max * (4 - i)) / 4;
      svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${gridColor()}" />`;
      svg += `<text x="${padL - 7}" y="${y + 3}" fill="${axisColor()}" font-size="9.5" text-anchor="end">${fmtCompact(
        value,
      )}</text>`;
    }

    days.forEach((day, index) => {
      const x = padL + index * (bw + gap);
      let yCursor = padT + innerH;
      const byKind = {};
      for (const provider of day.providers || []) {
        byKind[provider.kind] = (byKind[provider.kind] || 0) + provider.requests;
      }
      for (const kind of kinds) {
        const value = byKind[kind] || 0;
        if (value <= 0) continue;
        const h = (value / max) * innerH;
        yCursor -= h;
        svg += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(
          1,
        )}" height="${h.toFixed(1)}" rx="2" fill="${KIND_COLORS[kind]}"><title>${day.day} · ${
          KIND_LABELS[kind]
        }: ${fmtInt(value)}</title></rect>`;
      }
      const date = new Date(`${day.day}T00:00:00Z`);
      if (index % Math.max(1, Math.ceil(days.length / 7)) === 0 || index === days.length - 1) {
        svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${height - 7}" fill="${axisColor()}" font-size="9" text-anchor="middle">${date.toLocaleDateString(
          [],
          { month: "short", day: "numeric", timeZone: "UTC" },
        )}</text>`;
      }
    });
    svg += "</svg>";
    return svg;
  }

  function renderStack(data) {
    const wrap = $("ovStack");
    if (!wrap) return;
    const all = data.all || {};
    const days = (all.days || []).slice(-state.range);
    wrap.innerHTML = stackedChart(days);
    const legend = $("ovStackLegend");
    if (legend) {
      legend.textContent = "";
      const kinds = [...new Set(days.flatMap((day) => (day.providers || []).map((p) => p.kind)))];
      const ordered = ["free", "go", "zen", "external"].filter((kind) => kinds.includes(kind));
      for (const kind of ordered) {
        const item = node("span");
        const dot = node("i");
        dot.style.background = KIND_COLORS[kind];
        item.append(dot, KIND_LABELS[kind]);
        legend.append(item);
      }
    }
  }

  function renderDonut(data) {
    const all = data.all || {};
    const donut = $("ovDonut");
    const legend = $("ovDonutLegend");
    const total = $("ovDonutTotal");
    if (!donut || !legend) return;
    const providers = (all.providers || []).filter((provider) => provider.sharePct > 0);
    if (total) total.textContent = fmtCompact(all.last30Days ? all.last30Days.requests : 0);
    if (!providers.length) {
      donut.style.background = `conic-gradient(${
        isLight() ? "rgba(17,24,39,0.08)" : "rgba(255,255,255,0.07)"
      } 0 100%)`;
      legend.textContent = "";
      return;
    }
    let at = 0;
    const parts = [];
    providers.forEach((provider, index) => {
      const start = Math.min(100, at);
      at = Math.min(100, at + provider.sharePct);
      if (at <= start) return;
      parts.push(`${providerColor(provider.kind, index)} ${start.toFixed(2)}% ${at.toFixed(2)}%`);
    });
    donut.style.background = `conic-gradient(${parts.join(", ")})`;
    legend.textContent = "";
    providers.forEach((provider, index) => {
      const item = node("span");
      const dot = node("i");
      dot.style.background = providerColor(provider.kind, index);
      item.append(dot, `${provider.providerName} · ${fmtPct(provider.sharePct)}`);
      legend.append(item);
    });
  }

  function renderAlerts(data) {
    const wrap = $("ovAlerts");
    if (!wrap) return;
    wrap.textContent = "";
    const add = (tone, title, text) => {
      const el = node("div", `v2-alert ${tone || ""}`);
      el.append(node("span", "ico"), (() => {
        const body = node("div");
        body.append(node("strong", null, title), node("div", null, text));
        return body;
      })());
      wrap.append(el);
    };

    const go = data.go || {};
    const meta = data.meta || {};
    const server = data.server || {};
    if (meta.status === "limited" || meta.status === "limit-banner") {
      const reset = data.meta.resetAt
        ? `Resets ${new Date(data.meta.resetAt).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          })} UTC`
        : "Reset unknown";
      if (meta.status === "limit-banner") {
        add("warn", "Free tier recovered", `Free requests succeeded after the refusal. ${reset}.`);
      } else {
        add("bad", "Free tier is refused", `${reset}. Other plans are unaffected.`);
      }
    }
    if (go.detected && go.meters && go.meters.month) {
      const pct = go.meters.month.percent || 0;
      if (pct >= 90) {
        add(
          pct >= 100 ? "bad" : "warn",
          pct >= 100 ? "Go month limit reached" : "Go month near limit",
          `${fmtUsd(go.meters.month.usedUsd)} of ${fmtUsd(go.meters.month.limitUsd)} used.`,
        );
      }
    }
    if (go.stale) add("warn", "Go meters are saved", "Console sync is unavailable; the last snapshot is shown.");
    if (go.error) add("warn", "Go sync error", go.error);
    if (server.error) add("warn", "Console sync error", server.error);
    if (server.configured && !server.lastSyncAt) {
      add("warn", "Console never synced", "Press Sync Console to fetch the server-side view.");
    }
    if (!wrap.childElementCount) {
      add("", "All clear", "No refusals, no stale syncs, and no plan is near a limit.");
    }
  }

  function renderTopProviders(data) {
    const wrap = $("ovProviders");
    if (!wrap) return;
    wrap.textContent = "";
    const providers = (data.all || {}).providers || [];
    if (!providers.length) {
      wrap.append(node("div", "empty", "No provider usage yet."));
      return;
    }
    const max = Math.max(...providers.map((p) => p.sharePct || 0), 1);
    providers.slice(0, 6).forEach((provider, index) => {
      const row = node("div", "v2-provider-row");
      const name = node("div", "name");
      const dot = node("span", "dot");
      dot.style.background = providerColor(provider.kind, index);
      name.append(dot, node("span", null, provider.providerName));
      const bar = node("div", "bar");
      const fill = node("i");
      fill.style.width = `${Math.max(2, ((provider.sharePct || 0) / max) * 100)}%`;
      fill.style.background = providerColor(provider.kind, index);
      bar.append(fill);
      row.append(
        name,
        bar,
        node(
          "span",
          "num",
          `${fmtPct(provider.sharePct)} · ${fmtInt(provider.last30Days ? provider.last30Days.requests : 0)}`,
        ),
      );
      wrap.append(row);
    });
  }

  function renderOverview(data) {
    const all = data.all || {};
    const server = data.server || {};
    const sub = $("ovSub");
    if (sub) {
      const consoleState = !server.configured
        ? "local only"
        : server.error
          ? "Console error"
          : server.lastSyncAt
            ? "Console connected"
            : "Console awaiting sync";
      sub.textContent = `${all.providerCount || 0} providers · ${
        (all.plans || []).join(" + ") || "waiting for data"
      } · ${consoleState}`;
    }
    planChips(all);
    const todayReq = $("ovTodayReq");
    if (todayReq) todayReq.textContent = fmtInt(all.today ? all.today.requests : 0);
    const delta = $("ovTodayDelta");
    if (delta && all.days && all.days.length >= 2) {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const todayDay = all.days.find((day) => day.day === today);
      const yesterdayDay = all.days.find((day) => day.day === yesterday);
      const now = todayDay ? todayDay.requests : 0;
      const before = yesterdayDay ? yesterdayDay.requests : 0;
      if (before > 0) {
        const change = ((now - before) / before) * 100;
        delta.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs yesterday · ${fmtInt(
          before,
        )} yesterday`;
      } else {
        delta.textContent = `${fmtInt(now)} today · ${fmtCompact(all.today ? all.today.tokens.total : 0)} tokens`;
      }
    }
    renderKpis(data);
    renderStack(data);
    renderDonut(data);
    renderAlerts(data);
    renderTopProviders(data);
  }

  /* ---------------- Nav state ---------------- */

  function renderNav(data) {
    const all = data.all || {};
    const go = data.go || {};
    const free = $("v2FreeCount");
    if (free) free.textContent = fmtCompact(data.window ? data.window.usedRequests : 0);
    const goPct = $("v2GoPct");
    if (goPct) {
      goPct.textContent = go.meters && go.meters.month ? fmtPct(go.meters.month.percent) : "–";
    }
    const providerCount = $("v2ProviderCount");
    if (providerCount) providerCount.textContent = fmtInt(all.providerCount || 0);

    const goButton = document.querySelector('.v2-nav [data-view="go"]');
    if (goButton) goButton.hidden = !(go.detected === true);
    const providersButton = document.querySelector('.v2-nav [data-view="providers"]');
    if (providersButton) {
      providersButton.hidden =
        !(all.detected === true) ||
        ((all.providerCount || 0) <= 1 && !(all.kinds || []).some((kind) => kind !== "free"));
    }
    if (state.data && !availableViews().has(state.view)) setView("overview");
  }

  function v2Render(data) {
    state.data = data;
    renderNav(data);
    renderOverview(data);
  }

  /* ---------------- Wiring ---------------- */

  function initRange() {
    const toggle = $("ovRange");
    if (toggle) {
      toggle.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-ov-days]");
        if (!button) return;
        state.range = Number(button.dataset.ovDays);
        for (const option of toggle.querySelectorAll("button")) {
          option.classList.toggle("active", option === button);
        }
        if (state.data) renderStack(state.data);
      });
    }
  }

  function initThemeButton() {
    const button = $("v2ThemeBtn");
    if (button) {
      button.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
    }
  }

  function initSyncButton() {
    const button = $("v2SyncBtn");
    if (button) {
      button.addEventListener("click", () => {
        setView("console");
        const native = $("consoleSyncBtn");
        if (native) native.click();
      });
    }
  }

  function init() {
    initTheme();
    initView();
    initMobileNav();
    initCommand();
    initRange();
    initThemeButton();
    initSyncButton();
  }

  window.v2Render = v2Render;
  window.v2SetView = setView;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
