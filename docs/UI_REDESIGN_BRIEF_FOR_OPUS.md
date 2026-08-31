# Prompt: Redesign the frontend for the NetSuite Data Extractor

Copy everything below into a new conversation with Claude Opus.

---

## What this project is

A internal web tool called **NetSuite Data Extractor**, built for the "conversion team" at **MMC Convert**. The team is non-technical — they are not developers, so the UI has to be extremely simple, guided, and hard to get wrong. There is no training given beyond what's in the app itself.

**What it does:** connects to one or more NetSuite company accounts and exports financial records — Vendor Payments, Customer Payments, Deposit Applications, Journal Entries — as downloadable CSV/Excel files, filtered by date range and (optionally) by company/location ("subsidiary" in NetSuite terms).

## Who uses it and how

One shared login gets a user into the tool (single username/password, not per-person accounts). Once in, the entire job is three steps, done one at a time, never all on one page:

1. **Connect** — pick a NetSuite company from a list of already-saved companies (most days, there's only one or two) and click Connect. No typing, no credentials entered by the end user — those were set up once, in advance, by whoever administers the tool.
2. **Extract** — pick a date range, tick which record type(s) are wanted (Vendor Payments / Customer Payments / Deposit Applications / Journal Entries), optionally narrow to one company/location, click "Get My Data."
3. **Download** — watch a live progress indicator while NetSuite is queried (this can take anywhere from seconds to several minutes depending on record volume and NetSuite's own rate limits), then download the result as Excel or CSV.

Besides that core 3-step flow, there are three secondary things reachable from icon buttons in a top bar:

- **Help** — a short "how this works" explainer, written for a first-time non-technical user.
- **Export History** — a list of every file previously exported for the currently-connected company, each downloadable again.
- **Manage Companies** — where a company gets connected to the tool for the first time (a one-time setup per NetSuite account), and where a company can be removed. This is the most "setup-feeling" part of the app and is not something the day-to-day user touches often.

### Connecting a new company (detail, for context — not something to over-design)

Each NetSuite account has its own separate credentials. Connecting a new one is a short wizard:
1. Copy a "Redirect URI" the app shows you, and paste it into a NetSuite Integration Record (a manual step inside NetSuite itself — cannot be automated).
2. Enter a label and that company's NetSuite Account ID.
3. Paste the Client ID / Client Secret NetSuite generated, save — this redirects to a NetSuite login page, and on success the company is saved and ready to use from Step 1 going forward, for every user of the tool (it's shared, not per-person).

## Current technical shape (context, not a constraint)

- Plain Node.js/Express backend, plain static HTML/CSS/JS frontend — no framework, no build step, no bundler. Two small processes: an API server and a static file server.
- Backend exposes a REST API the frontend talks to. Full current surface, so you understand what's available to build against:
  - `POST /api/login`, `GET /api/session/status` — app-level login (shared credential, bearer token in `localStorage`, not cookies)
  - `GET /api/orgs`, `POST /api/orgs`, `POST /api/orgs/interactive`, `DELETE /api/orgs/:name` — manage saved companies
  - `POST /api/connect`, `POST /api/runtime/connect` — connect to a saved company
  - `GET /api/auth/login`, `GET /api/auth/callback`, `GET /api/auth/status`, `POST /api/auth/exchange` — NetSuite's own OAuth login handshake for a company
  - `POST /api/export`, `POST /api/runtime/export` — kick off an export job
  - `GET /api/jobs/:jobId` — poll job status/progress (`{ status, progress: { totalWritten, currentType, completedTypes, types }, outputFiles }`)
  - `GET /api/files`, `GET /api/files/download`, `GET /api/netsuite/files` — list and download past export files
- We are **not asking you to preserve this architecture**. If a different frontend architecture (e.g. a proper component structure, a lightweight framework, a different state model) would produce a better result, propose and use it. Treat the API list above as "what's available to call," not as a constraint on how the frontend is built.
- Existing (current, not mandatory) visual identity for reference only, if useful: NetSuite-style blue accent (`#0082ca`), warm off-white background, Georgia serif for headings paired with a system sans-serif for UI text, card-based layout with soft shadows, native `<dialog>` elements for modals. You do not have to keep any of this — a genuinely better direction is welcome. There is an existing small logo (a stylized "N" mark) that should stay in use for brand continuity; ask if you need to know more about it.

## What we want from you

Design and build **the best possible frontend UI** for this tool, from first principles — you can propose a different architecture than what exists today if it serves the product better. Think about it the way a product designer would: the audience is non-technical, the job is repetitive and needs to feel fast and safe (never ambiguous about what will happen when a button is clicked), and the "connect a company" setup flow should feel clearly secondary to the main "get my data" flow.

**Process:**
1. First, just give us a **single static HTML page (or a small set of them)** — a clickable prototype/mockup, real content (not lorem ipsum), no backend wiring needed yet. This is so we can see and react to the actual look and flow before anything is wired to real code.
2. We'll review, give feedback, and only after we sign off on the direction do we talk about wiring it to the real backend/API above.

Please lay out, before or alongside the HTML: a short explanation of the information architecture you chose (what's a full screen vs. a modal vs. inline, and why), and a one-paragraph rationale for the visual direction.
