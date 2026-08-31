// Local dev serves the frontend on its own explicit port (e.g. :9191) with
// the backend on a different one (:9090) — no proxy between them, so the
// port has to be hardcoded here. A real deployment behind a reverse proxy
// serves everything on the standard port (443/80), so the URL has no explicit
// port at all; there, calls should go to the *same* origin the page loaded
// from and let the proxy route /api/* to the backend.
const API_BASE = window.location.port
  ? window.location.protocol + "//" + window.location.hostname + ":9090"
  : "";
let authToken = localStorage.getItem("appAuthToken") || "";

const TYPES = [
  { id: "vendorpayment", name: "Vendor payments" },
  { id: "customerpayment", name: "Customer payments" },
  { id: "depositapplication", name: "Deposit applications" },
  { id: "journalentry", name: "Journal entries" }
];
function typeById(id) {
  return TYPES.find((t) => t.id === id);
}

let orgs = []; // [{name, accountId, authMethod}]
let orgAuthMethods = {};
let currentJobId = "";
let pollTimer = null;
let runClockTimer = null;
let runStartedAt = 0;

const state = {
  companyName: "",
  from: "",
  to: "",
  types: ["vendorpayment"],
  sub: "",
  connected: false,
  farms: [],
  farmSource: "",
  farmWarning: "",
  results: null
};

// There is no database behind this tool — the backend keeps jobs in memory and
// the page keeps everything else in this `state` object. So a browser refresh
// would otherwise lose the connected company and the run in progress. We stash
// the light stuff (company, farms, filters) here, and ask the backend for the
// authoritative answer on whether an export is actually still running.
const SESSION_KEY = "nsExtractorSession";

function saveSession() {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        companyName: state.companyName,
        farms: state.farms,
        farmSource: state.farmSource,
        from: state.from,
        to: state.to,
        types: state.types,
        sub: state.sub,
        // So a refresh reconnects to *this browser's own* run and not
        // whichever export happens to be running now that more than one
        // can be active at once.
        jobId: currentJobId
      })
    );
  } catch {
    // storage disabled or full — losing this only costs a re-connect
  }
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing to do
  }
}

function $(sel, root) {
  return (root || document).querySelector(sel);
}
function $all(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------
// Session / auth
// ---------------------------------------------------------------
async function apiFetch(path, options) {
  const opts = { ...(options || {}) };
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${authToken}` };
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (resp.status === 401 && path !== "/api/login" && path !== "/api/session/status") {
    showSignIn("Your session expired. Please sign in again.");
  }
  return resp;
}

function showSignIn(message) {
  authToken = "";
  localStorage.removeItem("appAuthToken");
  $("#app").classList.remove("is-on");
  $("#signin").classList.add("is-on");
  const s = $("#si-status");
  s.className = message ? "status err" : "status";
  s.textContent = message || "";
}

function showApp() {
  $("#signin").classList.remove("is-on", "is-leaving");
  $("#app").classList.add("is-on");
}

// Animated hand-off used after a fresh sign-in: the two card halves fold
// together, the merged card sinks away, then the app rises in. Restoring an
// existing session still uses showApp() directly — no animation on page load.
const SIGNIN_EXIT_MS = 520;
function revealAppAnimated() {
  return new Promise((resolve) => {
    const signin = $("#signin");
    const app = $("#app");
    const skip =
      !signin.classList.contains("is-on") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (skip) {
      showApp();
      resolve();
      return;
    }
    signin.classList.add("is-leaving");
    setTimeout(() => {
      showApp();
      app.classList.add("is-entering");
      app.addEventListener("animationend", () => app.classList.remove("is-entering"), {
        once: true
      });
      resolve();
    }, SIGNIN_EXIT_MS);
  });
}

async function attemptLogin() {
  const status = $("#si-status");
  status.className = "status";
  status.textContent = "Signing in…";
  const btn = $("#si-go");
  btn.disabled = true;
  try {
    const resp = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: String($("#si-user").value || ""),
        password: String($("#si-pass").value || "")
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      status.className = "status err";
      status.textContent = data.error || "Sign in failed.";
      return;
    }
    authToken = data.token;
    localStorage.setItem("appAuthToken", authToken);
    $("#si-pass").value = "";
    status.textContent = "";
    // Load the app's data while the exit animation plays, so the two overlap
    // instead of the user waiting out the animation and then a blank screen.
    await Promise.all([revealAppAnimated(), initApp()]);
  } catch (error) {
    status.className = "status err";
    status.textContent = `Sign in failed: ${error.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
function formatBytes(size) {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function toDateInputValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fromDateInputValue(s) {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
function daysBetween(a, b) {
  const d = (fromDateInputValue(b) - fromDateInputValue(a)) / 86400000;
  return isNaN(d) ? 0 : Math.round(d) + 1;
}
const PAYMENT_TYPE_LABELS = {
  vendorpayment: "Vendor Payments",
  customerpayment: "Customer Payments",
  depositapplication: "Deposit Applications",
  journalentry: "Journal Entries"
};
function friendlyFileLabel(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("raw_")) return { label: "Raw NetSuite Data", sublabel: name };
  for (const [key, label] of Object.entries(PAYMENT_TYPE_LABELS)) {
    if (lower.includes(key)) return { label, sublabel: name };
  }
  return { label: name, sublabel: "" };
}

// Downloads must go through apiFetch() (carries the login session token) rather
// than a plain <a href>, since a browser navigation can't attach custom headers.
async function triggerDownload(path) {
  const resp = await apiFetch(path);
  if (!resp.ok) {
    let message = "Download failed.";
    try {
      const data = await resp.json();
      message = data.error || message;
    } catch {
      // response wasn't JSON; keep the generic message
    }
    alert(message);
    return;
  }
  const blob = await resp.blob();
  const disposition = resp.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match ? match[1] : "download";
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

// Raw .jsonl side files are no longer generated, but older exports may still
// have them on disk — keep them out of the lists so only spreadsheets show.
function isSpreadsheetFile(f) {
  return !String(f.name || "").toLowerCase().endsWith(".jsonl");
}

function buildFileCard(f) {
  const { label, sublabel } = friendlyFileLabel(f.name);
  const card = el("div", "file");

  const glyph = el("span", "file__glyph file__glyph--xlsx", "XLSX");
  const main = el("span", "file__main");
  main.appendChild(el("span", "file__name", label));
  main.appendChild(el("span", "file__filename", sublabel || f.name));
  main.appendChild(el("span", "file__specs", formatBytes(f.sizeBytes) + " · " + f.modifiedAt));

  const dl = el("span", "file__dl");
  const xlsxBtn = el("button", "minibtn", "Download Excel");
  xlsxBtn.type = "button";
  xlsxBtn.addEventListener("click", () => triggerDownload(`/api/files/download?name=${encodeURIComponent(f.name)}&format=xlsx`));
  dl.appendChild(xlsxBtn);

  card.appendChild(glyph);
  card.appendChild(main);
  card.appendChild(dl);
  return card;
}

function buildLedgerRow(f) {
  const { label, sublabel } = friendlyFileLabel(f.name);
  const row = el("div", "ledger__row");

  const top = el("div", "ledger__top");
  top.appendChild(el("span", "ledger__co", label));
  top.appendChild(el("span", "ledger__when", f.modifiedAt));
  row.appendChild(top);

  row.appendChild(el("div", "ledger__what", sublabel || f.name));

  const foot = el("div", "ledger__foot");
  foot.appendChild(el("span", "ledger__rows", formatBytes(f.sizeBytes)));
  const acts = el("span", "ledger__acts");
  const xlsxBtn = el("button", "minibtn", "Download Excel");
  xlsxBtn.type = "button";
  xlsxBtn.addEventListener("click", () => triggerDownload(`/api/files/download?name=${encodeURIComponent(f.name)}&format=xlsx`));
  acts.appendChild(xlsxBtn);
  foot.appendChild(acts);
  row.appendChild(foot);

  return row;
}

// ---------------------------------------------------------------
// Run sheet (rail)
// ---------------------------------------------------------------
function setStub(n, lines) {
  const wrap = $("#stub-" + n);
  wrap.innerHTML = "";
  lines.forEach((l) => wrap.appendChild(el("div", "stub__entry" + (l.muted ? " stub__entry--muted" : ""), l.t)));
}

function renderRail(step, opts) {
  opts = opts || {};
  $all(".stub__row").forEach((r) => {
    const n = parseInt(r.getAttribute("data-stub"), 10);
    r.classList.toggle("is-current", n === step && !opts.allDone);
    r.classList.toggle("is-done", Boolean(n < step || (opts.allDone && n <= 3)));
  });

  if (state.connected) {
    setStub(1, [{ t: state.companyName }]);
  } else {
    setStub(1, [{ t: "No company yet", muted: true }]);
  }

  if (step >= 2 && (step > 2 || opts.showStep2)) {
    const lines = [{ t: fmtDate(state.from) + " – " + fmtDate(state.to) }];
    lines.push({ t: state.types.length + " record " + (state.types.length === 1 ? "type" : "types") });
    if (state.sub) {
      const farm = state.farms.find((f) => f.id === state.sub);
      if (farm) lines.push({ t: farm.name });
    }
    setStub(2, lines);
  } else if (step >= 2) {
    setStub(2, [{ t: "Choose dates and records", muted: true }]);
  } else {
    setStub(2, [{ t: "Not chosen yet", muted: true }]);
  }

  if (state.results && state.results.total > 0) {
    setStub(3, [{ t: state.results.total.toLocaleString() + " rows" }, { t: "Ready to download" }]);
  } else if (state.results) {
    setStub(3, [{ t: "0 rows found" }]);
  } else {
    setStub(3, [{ t: "No file yet", muted: true }]);
  }
}

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
function goStep(n) {
  clearRunTimers();
  $("#step1").hidden = n !== 1;
  $("#step2").hidden = n !== 2;
  $("#step3").hidden = n !== 3;
  $(".work").scrollTop = 0;
  if (n === 2) {
    renderTypes();
    renderSubs();
    syncStep2();
  } else {
    renderRail(n);
  }
}

// ---------------------------------------------------------------
// Step 1 — Connect
// ---------------------------------------------------------------
function renderCompanyPicks() {
  const wrap = $("#colist-pick");
  wrap.innerHTML = "";
  $("#colist-empty").classList.toggle("hidden", orgs.length > 0);
  $("#btn-connect").disabled = orgs.length === 0;

  orgs.forEach((o, i) => {
    const label = el("label", "pick__item");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "company";
    input.value = o.name;
    if (i === 0) input.checked = true;
    input.addEventListener("change", () => $("#connect-error").innerHTML = "");
    label.appendChild(input);

    const main = el("span", "pick__main");
    main.appendChild(el("span", "pick__name", o.name));
    main.appendChild(el("span", "pick__meta", "Account " + o.accountId));
    label.appendChild(main);
    wrap.appendChild(label);
  });
}

function showConnectError(message) {
  const wrap = $("#connect-error");
  wrap.innerHTML = "";
  const notice = el("div", "notice notice--error");
  notice.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7.5v5.5"/><path d="M12 16.6h.01"/><circle cx="12" cy="12" r="9"/></svg>';
  const textWrap = document.createElement("div");
  textWrap.appendChild(el("div", "notice__title", "NetSuite turned down the connection"));
  const text = el("div", "notice__text", message + " ");
  const link = el("button", "linkish", "Companies");
  link.type = "button";
  link.addEventListener("click", () => openDrawer("companies"));
  text.appendChild(document.createTextNode("An admin may need to check its credentials under "));
  text.appendChild(link);
  text.appendChild(document.createTextNode("."));
  textWrap.appendChild(text);
  notice.appendChild(textWrap);
  wrap.appendChild(notice);
}

async function doConnect() {
  const selected = $('input[name="company"]:checked');
  if (!selected) return;
  const orgName = selected.value;
  $("#connect-error").innerHTML = "";

  if (orgAuthMethods[orgName] === "interactive") {
    window.location.href = `${API_BASE}/api/auth/login?orgName=${encodeURIComponent(orgName)}`;
    return;
  }

  const btn = $("#btn-connect");
  const label = $("#btn-connect-label");
  btn.disabled = true;
  label.textContent = "Connecting…";
  try {
    const resp = await apiFetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      showConnectError(data.error || "Unknown error.");
      return;
    }
    state.companyName = orgName;
    state.connected = true;
    state.farms = data.farms || [];
    state.farmSource = data.farmSource || "";
    state.farmWarning = data.farmWarning || "";
    state.results = null;
    saveSession();
    goStep(2);
  } catch (error) {
    showConnectError(error.message);
  } finally {
    btn.disabled = orgs.length === 0;
    label.textContent = "Connect";
  }
}

async function finishInteractiveConnect(orgName) {
  try {
    const resp = await apiFetch(`/api/auth/status?orgName=${encodeURIComponent(orgName)}`);
    const data = await resp.json();
    if (!resp.ok || !data.connected) {
      showConnectError(data.error || "Sign-in with NetSuite did not complete.");
      return false;
    }
    state.companyName = orgName;
    state.connected = true;
    state.farms = data.farms || [];
    state.farmSource = data.farmSource || "";
    state.farmWarning = data.farmWarning || "";
    state.results = null;
    saveSession();
    goStep(2);
    return true;
  } catch (error) {
    showConnectError(error.message);
    return false;
  }
}

async function handleAuthRedirectReturn() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get("auth");
  if (!auth) return false;
  const cleanUrl = window.location.pathname;
  window.history.replaceState(null, "", cleanUrl);
  if (auth === "ok") {
    const orgName = params.get("org") || "";
    if (orgName) return await finishInteractiveConnect(orgName);
    return false;
  }
  showConnectError(params.get("message") || "NetSuite sign-in failed.");
  return false;
}

// ---------------------------------------------------------------
// Step 2 — Choose data
// ---------------------------------------------------------------
function renderTypes() {
  const wrap = $("#typelist");
  wrap.innerHTML = "";
  TYPES.forEach((t) => {
    const label = el("label", "typelist__item");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = t.id;
    input.checked = state.types.includes(t.id);
    input.addEventListener("change", (e) => {
      const i = state.types.indexOf(t.id);
      if (e.target.checked) {
        if (i < 0) state.types.push(t.id);
      } else if (i > -1) {
        state.types.splice(i, 1);
      }
      saveSession();
      syncStep2();
    });
    label.appendChild(input);
    label.appendChild(el("span", "typelist__name", t.name));
    wrap.appendChild(label);
  });
}

function renderSubs() {
  const menu = $("#sub-menu");
  menu.innerHTML = "";
  const options = [{ id: "", name: "All companies and locations" }, ...state.farms];

  options.forEach((o) => {
    const opt = el("button", "combo__opt" + (o.id === state.sub ? " is-sel" : ""), o.name);
    opt.type = "button";
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", o.id === state.sub ? "true" : "false");
    opt.addEventListener("click", () => {
      state.sub = o.id;
      closeCombo();
      saveSession();
      renderSubs();
      renderRail(2, { showStep2: true });
    });
    menu.appendChild(opt);
  });

  const current = options.find((o) => o.id === state.sub) || options[0];
  $("#sub-value").textContent = current.name;

  const status = $("#sub-status");
  if (!state.farms.length) {
    status.className = "status";
    status.textContent = "";
    return;
  }
  // The export filters on transaction.subsidiary. If this list came from the
  // location table instead (subsidiary query was refused for this role), the
  // ids are location ids and the filter would silently mismatch — say so
  // rather than let someone trust a wrong result.
  if (state.farmSource === "location") {
    status.className = "status err";
    status.textContent =
      `Loaded ${state.farms.length} locations, not subsidiaries — this NetSuite role could not read the subsidiary list. ` +
      `Filtering by one of these will not work correctly. Leave it on "All" and ask an admin to grant subsidiary access.`;
    return;
  }
  status.className = "status";
  status.textContent = `Loaded ${state.farms.length} subsidiaries.`;
}

function setDefaultDatesIfEmpty() {
  if (state.from && state.to) return;
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  state.from = toDateInputValue(firstOfMonth);
  state.to = toDateInputValue(today);
}

function syncStep2() {
  setDefaultDatesIfEmpty();
  $("#d-from").value = state.from;
  $("#d-to").value = state.to;

  const echo = $("#date-echo");
  const btn = $("#btn-extract");
  const note = $("#extract-note");
  const d = daysBetween(state.from, state.to);

  if (!state.from || !state.to || d <= 0) {
    echo.innerHTML = "Set a <strong>To</strong> date that comes after the <strong>From</strong> date.";
    echo.style.borderLeftColor = "var(--red)";
    echo.style.background = "var(--red-tint)";
    echo.style.color = "var(--red)";
  } else {
    echo.style.borderLeftColor = "var(--green)";
    echo.style.background = "var(--green-tint)";
    echo.style.color = "var(--green-2)";
    echo.innerHTML =
      "Records dated <span class='figure'>" + fmtDate(state.from) + "</span> to <span class='figure'>" +
      fmtDate(state.to) + "</span> — <span class='figure'>" + d + "</span> days.";
  }

  const ok = state.types.length > 0 && d > 0;
  btn.disabled = !ok;
  if (state.types.length === 0) {
    note.innerHTML = "<strong>Tick at least one record type</strong> above to carry on.";
    note.style.color = "var(--red)";
  } else if (d <= 0) {
    note.innerHTML = "<strong>Check your dates</strong> before carrying on.";
    note.style.color = "var(--red)";
  } else {
    note.style.color = "var(--ink-3)";
    note.textContent = d > 200
      ? "That's a long range — expect a few minutes. You can leave this tab open and come back."
      : "Large date ranges take longer. You can leave this tab open and come back.";
  }
  renderRail(2, { showStep2: true });
}


// ---------------------------------------------------------------
// Step 3 — Run + download
// ---------------------------------------------------------------
function clearRunTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (runClockTimer) {
    clearInterval(runClockTimer);
    runClockTimer = null;
  }
}

// Paced to the NetSuite account's own ceiling. The Integration Record for these
// accounts shows MAX CONCURRENCY LIMIT = 3, and that pool is shared with every
// other integration on the account — so we stay at 3, never above. The interval
// is the real throughput lever: it's a global gap between every request, so
// 375ms ≈ 2.7 req/sec. If NetSuite starts returning 429s, safeSignedRequest()
// widens this interval on its own up to maxRequestIntervalMs and eases back
// down once the throttling stops.
function speedOptions() {
  return {
    concurrency: 3,
    minRequestIntervalMs: 375,
    maxRequestIntervalMs: 20000,
    depositappMaxConcurrency: 2
  };
}

async function startRun() {
  // state.sub is kept current by the dropdown itself as the user picks.
  saveSession();
  const picked = state.types.map(typeById).filter(Boolean);
  if (!picked.length) return;

  const btn = $("#btn-extract");
  const note = $("#extract-note");
  btn.disabled = true;

  const payload = {
    orgName: state.companyName,
    connectionMode: orgAuthMethods[state.companyName] === "interactive" ? "interactive" : "saved",
    farmId: state.sub,
    startDate: state.from,
    endDate: state.to,
    paymentTypes: state.types,
    // Excel only — don't generate the raw .jsonl side files at all.
    rawJsonEnabled: false,
    rawJsonMax: 0,
    ...speedOptions()
  };

  let resp, data;
  try {
    resp = await apiFetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    data = await resp.json();
  } catch (error) {
    note.style.color = "var(--red)";
    note.textContent = `Could not start: ${error.message}`;
    btn.disabled = false;
    return;
  }
  if (!resp.ok || !data.ok) {
    note.style.color = "var(--red)";
    note.textContent = `Could not start: ${data.error || "unknown error"}`;
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  currentJobId = data.jobId;
  saveSession();
  state.results = null;
  goStep(3);
  startRunUi(picked);

  pollTimer = setInterval(() => pollJob(picked), 1500);
  pollJob(picked);
}

// `startedAtMs` lets a reconnected run show its real elapsed time rather than
// restarting the clock from zero at the moment the page happened to load.
function startRunUi(picked, startedAtMs) {
  $("#s3-running").hidden = false;
  $("#s3-done").hidden = true;
  $("#s3-empty").hidden = true;
  $("#s3-title").textContent = "Pulling your records.";
  $("#s3-lede").textContent = "This can take a few minutes — keep this tab open and we'll tell you the moment it's ready.";
  $("#run-total").textContent = "0";
  $("#run-total-label").textContent = "rows found so far";
  $("#meter-what").textContent = "Starting up…";
  $("#pulse-track").classList.remove("is-determinate");
  $("#pulse-fill").style.width = "0%";

  const rows = $("#runrows");
  rows.innerHTML = "";
  picked.forEach((t) => {
    const row = el("div", "runrow");
    row.dataset.type = t.id;
    row.appendChild(el("div", "runrow__name", t.name));
    row.appendChild(el("div", "runrow__rows", "—"));
    row.appendChild(el("div", "runrow__state", "Queued"));
    rows.appendChild(row);
  });

  runStartedAt = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  updateClock();
  runClockTimer = setInterval(updateClock, 1000);

  resetStopRow();
}

// ---------------------------------------------------------------
// Stop this export (wrong dates picked, etc.)
// ---------------------------------------------------------------
function resetStopRow() {
  const row = $("#runstop-row");
  if (!row) return;
  row.classList.remove("is-confirm");
  row.innerHTML = "";
  const main = el("span", "corow__main");
  main.appendChild(el("span", "corow__name", "Started the wrong export?"));
  main.appendChild(el("span", "corow__meta", "Rows already found are kept. You can start again right away with new dates."));
  row.appendChild(main);
  const stopBtn = el("button", "btn btn--ghost", "Stop this export");
  stopBtn.type = "button";
  stopBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
  stopBtn.addEventListener("click", showStopConfirm);
  row.appendChild(stopBtn);
}

function showStopConfirm() {
  const row = $("#runstop-row");
  row.classList.add("is-confirm");
  row.innerHTML = "";
  row.appendChild(
    el("span", "corow__confirm-text", "Are you sure? You can continue later by running the same company and dates again.")
  );
  const acts = el("span", "corow__confirm-acts");
  const cancelBtn = el("button", "btn btn--ghost", "Keep running");
  cancelBtn.type = "button";
  cancelBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
  cancelBtn.addEventListener("click", resetStopRow);
  const confirmBtn = el("button", "btn btn--danger", "Yes, stop it");
  confirmBtn.type = "button";
  confirmBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
  confirmBtn.addEventListener("click", stopRunConfirmed);
  acts.appendChild(cancelBtn);
  acts.appendChild(confirmBtn);
  row.appendChild(acts);
}

async function stopRunConfirmed() {
  const row = $("#runstop-row");
  row.innerHTML = "";
  row.appendChild(el("span", "corow__confirm-text", "Stopping…"));
  try {
    const resp = await apiFetch(`/api/jobs/${encodeURIComponent(currentJobId)}/cancel`, { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      row.innerHTML = "";
      row.appendChild(el("span", "corow__confirm-text", `Could not stop it: ${data.error || "unknown error"}`));
      const acts = el("span", "corow__confirm-acts");
      const backBtn = el("button", "btn btn--ghost", "Back");
      backBtn.type = "button";
      backBtn.addEventListener("click", resetStopRow);
      acts.appendChild(backBtn);
      row.appendChild(acts);
      return;
    }
    // The regular 1.5s poll (already running) picks up status:"cancelled" on
    // its next tick and calls finishRun() — nothing else to do here.
  } catch (error) {
    row.innerHTML = "";
    row.appendChild(el("span", "corow__confirm-text", `Could not stop it: ${error.message}`));
  }
}

function updateClock() {
  const s = Math.floor((Date.now() - runStartedAt) / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  $("#run-clock").textContent = m + ":" + (ss < 10 ? "0" : "") + ss;
}

async function pollJob(picked) {
  let resp, data;
  try {
    resp = await apiFetch(`/api/jobs/${encodeURIComponent(currentJobId)}`);
    data = await resp.json();
  } catch {
    return;
  }
  if (!resp.ok) return;

  const progress = data.progress || {};
  const perType = progress.perTypeWritten || {};
  const perTypeExpected = progress.perTypeExpected || {};
  const completed = progress.completedTypes || [];
  const current = progress.currentType || "";
  const typeIndex = (progress.types || []).indexOf(current);

  const totalWritten = progress.totalWritten || 0;
  const totalExpected = progress.totalExpected || 0;
  $("#run-total").textContent = totalWritten.toLocaleString();
  const track = $("#pulse-track");
  if (totalExpected > 0) {
    track.classList.add("is-determinate");
    const pct = Math.min(100, Math.round((totalWritten / totalExpected) * 100));
    $("#pulse-fill").style.width = pct + "%";
    $("#run-total-label").textContent = `of ${totalExpected.toLocaleString()} rows found`;
  } else {
    track.classList.remove("is-determinate");
    $("#run-total-label").textContent = "rows found so far";
  }
  if (data.status === "running") {
    const label = (typeById(current) || {}).name || current;
    $("#meter-what").textContent = label
      ? `Reading ${label.toLowerCase()} — record type ${typeIndex + 1} of ${(progress.types || []).length}`
      : "Starting up…";
  }

  picked.forEach((t) => {
    const row = $(`.runrow[data-type="${t.id}"]`);
    if (!row) return;
    const rowsCell = row.querySelector(".runrow__rows");
    const stateCell = row.querySelector(".runrow__state");
    const nameCell = row.querySelector(".runrow__name");
    const count = perType[t.id];
    const expected = perTypeExpected[t.id];
    const rowsText = (n) => (expected ? `${(n || 0).toLocaleString()} of ${expected.toLocaleString()}` : (n || 0).toLocaleString());
    if (completed.includes(t.id)) {
      row.classList.remove("is-active");
      row.classList.add("is-done");
      nameCell.innerHTML = '<svg class="minitick" viewBox="0 0 24 24"><path d="M3.6 12.6c2.7 1.6 4.6 3.9 5.9 6.6C12.6 12 16.4 6.7 21.2 3.4"/></svg>';
      nameCell.appendChild(document.createTextNode(t.name));
      stateCell.textContent = "Done";
      rowsCell.textContent = rowsText(count);
    } else if (t.id === current) {
      row.classList.add("is-active");
      nameCell.innerHTML = '<span class="dotspin"></span>';
      nameCell.appendChild(document.createTextNode(t.name));
      stateCell.textContent = "Reading";
      rowsCell.textContent = rowsText(count);
    } else if (count !== undefined) {
      rowsCell.textContent = rowsText(count);
    }
  });

  if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
    clearRunTimers();
    finishRun(data);
  }
}

function finishRun(data) {
  // This browser's run is over — drop the jobId so a later refresh doesn't
  // try to reconnect to it (or, worse, to someone else's still-running job).
  currentJobId = "";
  saveSession();
  const outputFiles = (data.outputFiles || []).filter(isSpreadsheetFile);
  const total = Number((data.progress || {}).totalWritten) || 0;
  state.results = { total, outputFiles };

  if (data.status === "cancelled") {
    $("#s3-running").hidden = true;
    $("#s3-empty").hidden = false;
    $("#s3-title").textContent = "Export stopped.";
    $("#s3-lede").textContent = "You stopped this one — nothing else to do here.";
    $("#empty-title").textContent = "This export was stopped";
    $("#empty-text").textContent =
      total > 0
        ? `${total.toLocaleString()} row(s) were already found. Run the same company and dates again later to continue, or pick different dates to start over.`
        : "Pick different dates and start again whenever you're ready.";
    renderRail(3, { allDone: true });
    return;
  }

  if (data.status === "failed") {
    $("#s3-running").hidden = true;
    $("#s3-empty").hidden = false;
    $("#s3-title").textContent = "The extract stopped early.";
    $("#s3-lede").textContent = "Something went wrong partway through.";
    $("#empty-title").textContent = "The extract didn't finish";
    $("#empty-text").textContent = Number(data.failedCount) > 0
      ? `${data.failedCount} record(s) failed to fetch after retries, and the run stopped. Try again — NetSuite's own rate limits are the usual cause.`
      : "NetSuite closed the connection partway through. Try again with the same settings.";
    renderRail(3, { allDone: true });
    return;
  }

  if (!outputFiles.length || total === 0) {
    $("#s3-running").hidden = true;
    $("#s3-empty").hidden = false;
    $("#s3-title").textContent = "Nothing came back.";
    $("#s3-lede").textContent = "The connection worked — there just aren't any matching records.";
    $("#empty-title").textContent = "No records in that date range";
    $("#empty-text").textContent = "NetSuite returned nothing for these dates. Widen the range, or check whether the records sit under a different company or location.";
    renderRail(3, { allDone: true });
    return;
  }

  $("#s3-running").hidden = true;
  $("#s3-done").hidden = false;
  $("#s3-title").textContent = "Your data is ready.";
  $("#s3-lede").textContent = "It's also saved under Export history, so you can grab it again later.";

  const subLine = state.sub ? (() => {
    const farm = state.farms.find((f) => f.id === state.sub);
    return farm ? ` Limited to ${farm.name}.` : "";
  })() : "";
  $("#done-summary").textContent =
    `${total.toLocaleString()} rows from ${state.companyName}, dated ${fmtDate(state.from)} to ${fmtDate(state.to)}.${subLine}`;

  const filesWrap = $("#done-files");
  filesWrap.innerHTML = "";
  outputFiles.forEach((f) => filesWrap.appendChild(buildFileCard(f)));

  renderRail(3, { allDone: true });
}

// ---------------------------------------------------------------
// History drawer
// ---------------------------------------------------------------
async function renderHistory() {
  const note = $("#history-note");
  const list = $("#historylist");
  const empty = $("#history-empty");
  list.innerHTML = "";
  empty.classList.add("hidden");

  if (!state.connected) {
    note.textContent = "Connect to a company to see its past exports.";
    return;
  }
  note.textContent = `All past exports for ${state.companyName}.`;
  try {
    const resp = await apiFetch(`/api/files?orgName=${encodeURIComponent(state.companyName)}`);
    const data = await resp.json();
    const files = (data.files || []).filter(isSpreadsheetFile);
    if (!files.length) {
      empty.classList.remove("hidden");
      return;
    }
    files.forEach((f) => list.appendChild(buildLedgerRow(f)));
  } catch {
    empty.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------
// Companies drawer
// ---------------------------------------------------------------
async function loadOrgs() {
  try {
    const resp = await apiFetch("/api/orgs");
    const data = await resp.json();
    orgs = data.orgs || [];
    orgAuthMethods = {};
    orgs.forEach((o) => {
      orgAuthMethods[o.name] = o.authMethod === "interactive" ? "interactive" : "m2m";
    });
  } catch {
    orgs = [];
    orgAuthMethods = {};
  }
}

function renderCompanies() {
  const wrap = $("#companylist");
  wrap.innerHTML = "";
  $("#companylist-empty").classList.toggle("hidden", orgs.length > 0);
  orgs.forEach((o) => {
    const row = el("div", "corow");
    row.dataset.orgName = o.name;

    const main = el("span", "corow__main");
    main.appendChild(el("span", "corow__name", o.name));
    main.appendChild(el("span", "corow__meta", "Account " + o.accountId + " · " + (o.authMethod === "interactive" ? "Login with NetSuite" : "Certificate login")));
    row.appendChild(main);

    const removeBtn = el("button", "btn btn--danger", "Remove");
    removeBtn.type = "button";
    removeBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
    removeBtn.addEventListener("click", () => startRemoveConfirm(row, o.name));
    row.appendChild(removeBtn);

    wrap.appendChild(row);
  });
}

function startRemoveConfirm(row, orgName) {
  row.classList.add("is-confirm");
  row.innerHTML = "";
  row.appendChild(el("span", "corow__confirm-text", `Remove "${orgName}"? Past exports stay in Export history.`));
  const acts = el("span", "corow__confirm-acts");
  const cancelBtn = el("button", "btn btn--ghost", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
  cancelBtn.addEventListener("click", renderCompanies);
  const confirmBtn = el("button", "btn btn--danger", "Yes, remove");
  confirmBtn.type = "button";
  confirmBtn.style.cssText = "height:36px;padding:0 13px;font-size:13.5px";
  confirmBtn.addEventListener("click", () => removeOrg(orgName, row));
  acts.appendChild(cancelBtn);
  acts.appendChild(confirmBtn);
  row.appendChild(acts);
}

async function removeOrg(orgName, row) {
  try {
    const resp = await apiFetch(`/api/orgs/${encodeURIComponent(orgName)}`, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      row.querySelector(".corow__confirm-text").textContent = `Remove failed: ${data.error || "unknown error"}`;
      return;
    }
  } catch (error) {
    row.querySelector(".corow__confirm-text").textContent = `Remove failed: ${error.message}`;
    return;
  }
  if (state.companyName === orgName) {
    clearRunTimers();
    state.connected = false;
    state.companyName = "";
    state.results = null;
  }
  await loadOrgs();
  renderCompanyPicks();
  renderCompanies();
}

// ---------------------------------------------------------------
// Add-company wizard
// ---------------------------------------------------------------
let wizStep = 1;
function openWizard() {
  closeAll();
  wizStep = 1;
  $("#w-name").value = "";
  $("#w-acct").value = "";
  $("#w-cid").value = "";
  $("#w-cs").value = "";
  $("#w-step2-status").textContent = "";
  $("#w-step3-status").textContent = "";
  $("#w-redirect").value = `${API_BASE}/api/auth/callback`;
  renderWiz();
  $("#wizard").classList.add("is-on");
  $("#scrim").classList.add("is-on");
}
function renderWiz() {
  $all(".wizpane").forEach((p) => (p.hidden = parseInt(p.getAttribute("data-wp"), 10) !== wizStep));
  $all(".wizdot").forEach((d) => d.classList.toggle("is-on", parseInt(d.getAttribute("data-wd"), 10) <= wizStep));
  $("#wiz-back").hidden = wizStep === 1;
  $("#wiz-next").textContent = wizStep === 3 ? "Save & continue to NetSuite" : "Continue";
}

async function wizNext() {
  if (wizStep === 1) {
    wizStep = 2;
    renderWiz();
    return;
  }
  if (wizStep === 2) {
    const status = $("#w-step2-status");
    if (!$("#w-name").value.trim() || !$("#w-acct").value.trim()) {
      status.className = "status err";
      status.textContent = "Enter both the company name and Account ID to continue.";
      return;
    }
    status.textContent = "";
    wizStep = 3;
    renderWiz();
    return;
  }
  // wizStep === 3: save and redirect to NetSuite
  const status = $("#w-step3-status");
  status.className = "status";
  status.textContent = "Saving…";
  const payload = {
    orgName: $("#w-name").value.trim(),
    accountId: $("#w-acct").value.trim(),
    clientId: $("#w-cid").value.trim(),
    clientSecret: $("#w-cs").value.trim()
  };
  try {
    const resp = await apiFetch("/api/orgs/interactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      status.className = "status err";
      status.textContent = `Save failed: ${data.error || "unknown error"}`;
      return;
    }
    status.className = "status ok";
    status.textContent = `Saved "${payload.orgName}" — redirecting to NetSuite…`;
    window.location.href = `${API_BASE}/api/auth/login?orgName=${encodeURIComponent(payload.orgName)}`;
  } catch (error) {
    status.className = "status err";
    status.textContent = `Save failed: ${error.message}`;
  }
}

// ---------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------
function openDrawer(name) {
  closeAll();
  const d = $("#drawer-" + name);
  if (!d) return;
  if (name === "history") renderHistory();
  if (name === "companies") renderCompanies();
  d.classList.add("is-on");
  $("#scrim").classList.add("is-on");
}
function closeAll() {
  $all(".drawer").forEach((d) => d.classList.remove("is-on"));
  $all(".modal").forEach((m) => m.classList.remove("is-on"));
  $("#scrim").classList.remove("is-on");
}

// Generic "are you sure?" popup, reused wherever a click needs confirming
// first. Cancel, Escape, and clicking outside all just dismiss it — only the
// confirm button runs the action.
function showConfirm(title, text, confirmLabel, onConfirm) {
  closeAll();
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = confirmLabel || "Yes";
  $("#confirm-modal").classList.add("is-on");
  $("#scrim").classList.add("is-on");
  // Plain assignment (not addEventListener) so re-opening this popup for a
  // different action never stacks a second stale handler on top of the last.
  $("#confirm-ok").onclick = () => {
    closeAll();
    onConfirm();
  };
  $("#confirm-cancel").onclick = () => closeAll();
}

// ---------------------------------------------------------------
// Boot / wiring
// ---------------------------------------------------------------
// The export lives in the backend, not the page. If one is still running when
// the page loads (refresh, closed tab, different tab), rejoin it and show live
// progress rather than dropping the user back at step 1 with no sign of it.
async function restoreRunningJob() {
  const saved = loadSession() || {};
  let job = null;

  // Multiple exports can run at once now, so the safe reconnect is to the
  // exact jobId this browser started — never a guess at "the" active job.
  if (saved.jobId) {
    try {
      const resp = await apiFetch(`/api/jobs/${encodeURIComponent(saved.jobId)}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "running") job = { jobId: saved.jobId, ...data };
      }
    } catch {
      // fall through to the no-jobId path below
    }
  }

  if (!job) {
    // No jobId on file for this browser (cleared storage, very old session).
    // Only auto-reconnect when there's exactly one export running anywhere —
    // with more than one in flight, guessing could hand this browser someone
    // else's in-progress run.
    try {
      const resp = await apiFetch("/api/jobs/active");
      if (resp.ok) {
        const data = await resp.json();
        const running = data.jobs || [];
        if (running.length === 1) job = running[0];
      }
    } catch {
      // no reconnect — falls through to the normal step-1 start below
    }
  }

  if (!job || !job.jobId) return false;
  state.companyName = job.orgName || saved.companyName || "";
  state.from = job.startDate || saved.from || "";
  state.to = job.endDate || saved.to || "";
  state.sub = job.farmId || saved.sub || "";
  state.types = (job.progress && job.progress.types) || saved.types || [];
  // Farms aren't worth another NetSuite round-trip just to redraw a dropdown.
  state.farms = saved.farms || [];
  state.farmSource = saved.farmSource || "";
  state.connected = true;
  state.results = null;
  currentJobId = job.jobId;

  const picked = state.types.map(typeById).filter(Boolean);
  goStep(3);
  startRunUi(picked, job.startedAt ? new Date(job.startedAt).getTime() : undefined);
  pollTimer = setInterval(() => pollJob(picked), 1500);
  pollJob(picked);
  return true;
}

async function initApp() {
  await loadOrgs();
  renderCompanyPicks();
  const redirected = await handleAuthRedirectReturn();
  if (redirected) return;
  if (await restoreRunningJob()) return;
  goStep(1);
}

$all("[data-open]").forEach((b) => b.addEventListener("click", () => openDrawer(b.getAttribute("data-open"))));
$all("[data-close]").forEach((b) => b.addEventListener("click", closeAll));
$("#scrim").addEventListener("click", closeAll);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAll();
    closeCombo();
  }
});

$("#si-go").addEventListener("click", attemptLogin);
$("#si-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptLogin();
});
$("#signout").addEventListener("click", () => {
  clearRunTimers();
  state.connected = false;
  state.companyName = "";
  state.results = null;
  clearSession();
  showSignIn("");
});

$("#btn-connect").addEventListener("click", doConnect);
function resetToStep1() {
  clearRunTimers();
  state.connected = false;
  state.companyName = "";
  state.results = null;
  clearSession();
  $("#connect-error").innerHTML = "";
  goStep(1);
}
$("#startover").addEventListener("click", () => {
  showConfirm(
    "Start over?",
    "This clears your company, dates, and record types. It will not stop an export that is already running.",
    "Yes, start over",
    resetToStep1
  );
});

$("#d-from").addEventListener("change", () => {
  state.from = $("#d-from").value;
  saveSession();
  syncStep2();
});
$("#d-to").addEventListener("change", () => {
  state.to = $("#d-to").value;
  saveSession();
  syncStep2();
});
// Custom dropdown open/close. Selection itself is wired per-option in renderSubs().
function openCombo() {
  $("#sub-combo").classList.add("is-open");
  $("#sub-menu").hidden = false;
  $("#sub-btn").setAttribute("aria-expanded", "true");
}
function closeCombo() {
  $("#sub-combo").classList.remove("is-open");
  $("#sub-menu").hidden = true;
  $("#sub-btn").setAttribute("aria-expanded", "false");
}
$("#sub-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#sub-combo").classList.contains("is-open")) closeCombo();
  else openCombo();
});
// Clicks inside the panel shouldn't bubble up to the close-on-outside-click handler.
$("#sub-menu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeCombo);

$("#btn-extract").addEventListener("click", startRun);
$("#btn-again").addEventListener("click", () => {
  state.results = null;
  goStep(2);
});
$("#btn-back2").addEventListener("click", () => {
  state.results = null;
  goStep(2);
});

$("#btn-addco").addEventListener("click", openWizard);
$("#wiz-x").addEventListener("click", closeAll);
$("#wiz-back").addEventListener("click", () => {
  if (wizStep > 1) {
    wizStep--;
    renderWiz();
  }
});
$("#wiz-next").addEventListener("click", wizNext);
$("#w-copy").addEventListener("click", async () => {
  const input = $("#w-redirect");
  try {
    await navigator.clipboard.writeText(input.value);
    $("#w-copy").textContent = "Copied!";
  } catch {
    input.select();
    $("#w-copy").textContent = "Select & copy";
  }
  setTimeout(() => ($("#w-copy").textContent = "Copy"), 1500);
});

// "How to connect" guide: same Redirect URI the add-company wizard shows, so
// someone can read the whole setup before starting the wizard.
$("#guide-redirect").value = `${API_BASE}/api/auth/callback`;
$("#guide-copy").addEventListener("click", async () => {
  const input = $("#guide-redirect");
  const btn = $("#guide-copy");
  try {
    await navigator.clipboard.writeText(input.value);
    btn.textContent = "Copied!";
  } catch {
    input.select();
    btn.textContent = "Select & copy";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1500);
});
$("#guide-open-companies").addEventListener("click", () => openDrawer("companies"));

(async () => {
  if (authToken) {
    try {
      const resp = await fetch(`${API_BASE}/api/session/status`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await resp.json();
      if (data.authenticated) {
        showApp();
        await initApp();
        return;
      }
    } catch {
      // fall through to sign-in screen
    }
  }
  showSignIn("");
})();
