# Pressto Frontend Performance Audit — Agent 3

Scope note (read first): Only two frontend repos exist locally — `pressto-admin-panel`
(CRA/React, package `@minimal-kit/cra-js`) and `pressto-customer-web` (Vite/React,
package `pressto-customer-web-app`). `pressto-admin-panel` is confirmed, from its own
routing (`src/routes/sections/dashboard.js`) and role-gated routes (`perm(...)` wrappers
keyed on permission strings like `rider:read`, `shift:read`, counter-role gates, etc.),
to serve BOTH the "admin panel" and "employee/counter-staff panel" roles via role-based
view gating inside one app — there is no separate employee-panel codebase.

**Open gap / explicit note**: There is no rider-facing frontend repo present locally.
Rider functionality that exists here is store/admin-side management of riders (rider
roster, assignment, tracking-from-the-store's-perspective) inside `pressto-admin-panel`
under `src/pages/riderManagement/*`, plus backend-only rider APIs documented in
`pressto_backend`'s `RIDER_APP_*.md` files. No rider mobile/web client was found to
audit; this is flagged as a gap for the lead to confirm with the rider-app team/repo,
not something this audit can cover from what's checked out.

All findings below are read-only static-analysis observations. No build was run and no
bundle-size numbers were measured — anywhere a size is relevant it is explicitly marked
"not measured."

---

## Admin/Employee Panel (pressto-admin-panel)

### A. API consumption

**FE-ADM-001 — Order "Manage Ticket" screen: text filters fire one request per
keystroke (no debounce)**
- Screen/file: `src/sections/orders/order-status/order-status-toolbar.js` (lines
  126–184, the Customer name/mobile, Ticket ID, and Invoice ID `TextField`s each call
  `onFilters(name, e.target.value)` directly in `onChange`), consumed by
  `src/sections/orders/order-status/order-status-view.js` lines 748–775 where
  `filters.customerName` / `filters.orderId` / `filters.invoiceNumber` feed straight into
  `useGetOrders({ search: ..., invoiceNumber: ... })`, which builds the SWR key from a
  URL built in `src/api/order.js` (`useGetOrders`, lines 79–123). Every SWR key change
  triggers a fresh GET against `/orders`.
- Evidence: no `useDebounce`/`setTimeout` anywhere in `order-status-toolbar.js` or the
  three handlers in `order-status-view.js` that set these filters (`handleFilters`,
  lines 835–851, fires on every `onFilters` call with no delay).
- Measured impact: not measured (no network trace run). By inspection: typing an 8-10
  character customer name produces 8-10 sequential GET `/orders` requests, each
  returning up to `rowsPerPage` (default 10) full mapped order rows.
- Why it matters: this is the primary "Manage Ticket" screen used continuously by
  counter staff; on a slow/metered connection or during peak store hours this adds
  avoidable backend load and visible input lag (each keystroke can trigger a
  loading-skeleton flash via `ordersLoading`).
- Severity: Medium
- Confidence: Confirmed (direct code read, no debounce layer present)
- Recommended improvement: wrap `customerName`/`orderId`/`invoiceNumber` through the
  same `useDebounce` hook already used elsewhere in this codebase
  (`src/hooks/use-debounce.js`), e.g. 300–400ms, before they reach `useGetOrders`.
- Dependencies/risks: none — `useDebounce` already exists and is used correctly
  elsewhere (see FE-ADM control note below).
- How to validate later: open browser devtools Network tab, type a 6-8 character
  customer name into the search field on `/dashboard/orders/status`, count GET
  `/orders` requests fired.

**FE-ADM-002 — Rider Management list: search field has no debounce**
- Screen/file: `src/pages/riderManagement/manage/rider-management-list-view.js`,
  lines 52–82: `search`/`setSearch` is plain `useState`, memoized into
  `riderSearchQuery` (lines 54–61) with no debounce, then passed directly as `query`
  into `useGetRiders({ ..., query: riderSearchQuery, ... })` (line 79), which is
  consumed by `useBackendPagination` (`src/hooks/use-backend-pagination.js`) — every
  render of `riderSearchQuery` with a new value changes the SWR key and fires a request.
- Evidence: no `useDebounce` import in this file (contrast with
  `user-management-list-view.js`, which does import and use it — see control note).
- Measured impact: not measured.
- Why it matters: same per-keystroke request pattern as FE-ADM-001, on a screen store
  managers/dispatchers use to find riders quickly.
- Severity: Medium
- Confidence: Confirmed
- Recommended improvement: same as FE-ADM-001 — debounce `search` before deriving
  `riderSearchQuery`.
- Dependencies/risks: none.
- How to validate later: Network tab trace while typing in the rider search box on the
  Rider Management list.

**FE-ADM-003 — "Manage Ticket" screen fetches the entire filtered order set into
memory when Payment filter is active, bypassing server-side pagination**
- Screen/file: `src/sections/orders/order-status/order-status-view.js`, lines 746 and
  753–775: `paginateFilteredPaymentsLocally = filters.paymentStatus !== 'all'`; when
  true, `page`/`rowsPerPage` passed to `useGetOrders` are both `undefined` (line
  755–756), which in `src/api/order.js` `useGetOrders` (lines 81–89) means no
  `limit`/`skip` query params are sent — the backend's default/unbounded response is
  fetched in one call. Pagination then happens client-side via `.slice()` at lines
  865–874, and the pager's `count` prop uses `sortedFiltered.length` instead of the
  server's `ordersCount` (line 1689).
- Measured impact: not measured — depends on how many orders match the non-payment
  filters at a given store/date range; could be hundreds to low thousands at a busy
  store with no date filter applied.
- Why it matters: this is exactly the "fetch everything, paginate client-side" anti-
  pattern called out in the audit brief; combined with the 10-second poll
  (`refreshInterval: 10000`, line 754) it means every 10 seconds the browser can
  re-fetch and re-map an unbounded order list whenever a Payment Status filter is set,
  on a screen staff may leave open all shift.
- Severity: High
- Confidence: Confirmed
- Recommended improvement: either (a) ask the backend to accept `paymentStatus` as a
  server-side filter parameter alongside the existing `status`/`search`/etc. params
  so pagination stays server-side, or (b) if that's not feasible soon, cap the
  unpaginated fetch with an explicit `limit` and surface a "narrow your filters" message
  past that cap rather than fetching unbounded.
- Dependencies/risks: requires a backend change to add `paymentStatus` to the `/orders`
  list endpoint's server-side filter set (coordinate with backend team / check
  `pressto_backend`'s order controller for existing filter support).
- How to validate later: set the Payment filter to a non-"All" value on
  `/dashboard/orders/status` with no other filters, inspect the Network tab response
  size/row count on the `/orders` GET.

**FE-ADM-004 — Order Invoice Dialog polls three endpoints every 5 seconds while open**
- Screen/file: `src/sections/orders/order-invoice/order-invoice-dialog.js`, lines
  169–195: `useGetOrderDetails(..., { refreshInterval: open ? 5000 : 0 })`,
  `useGetOrderInvoice(..., { refreshInterval: open ? 5000 : 0 })`, and
  `useGetApprovalRequests(..., { refreshInterval: 5000 })` (the third has no `open`
  gate directly, but is itself gated via `enabled: Boolean(isUuid && open)`).
- Measured impact: not measured; by inspection, ~3 GET requests every 5s for as long as
  this dialog (opened from the order list "View/Record Payment Invoice" action) stays
  open.
- Why it matters: appears deliberate (keeping cheque/PDC approval state and invoice
  state fresh during an active payment flow), but 3 concurrent 5s polls per open dialog,
  multiplied across however many store terminals have this dialog open at once during
  peak hours, is worth confirming the backend can absorb at scale.
- Severity: Medium
- Confidence: Confirmed (code), but whether this load level is actually a problem is
  Needs validation (depends on concurrent store/terminal count, not something static
  analysis can determine)
- Recommended improvement: if real-time approval status is the only reason for the
  5s interval, consider a single consolidated polling endpoint for this dialog, or push
  the cheque/PDC approval state over the app's existing SWR global mutate pattern
  (`globalMutate` is already used elsewhere, e.g. `src/api/order.js` line 410) instead of
  independent polls.
- Dependencies/risks: none for the recommendation itself; validating actual load impact
  needs backend request-rate metrics.
- How to validate later: open the invoice dialog on an order, watch Network tab for 30s,
  count requests; cross-reference with backend request logs during a real peak shift.

**FE-ADM control note (not a defect)**: `src/pages/userManagementMaster/user-management-list-view.js`
(lines 69–90) does this correctly — `useDebounce(searchQuery.trim(), 400)` before the
request, server-side `page`/`rowsPerPage` passed to `useGetUserManagementList`. Likewise
18 master-data screens (brand, store, rider type lists, warehouse, cluster, price-list,
service, item, etc. — see `src/hooks/use-backend-pagination.js` callers) use
`useBackendPagination`, which does correct server-side `skip`/`limit`/`where` filtering
via SWR. This shows the debounce/server-pagination pattern exists and is known in this
codebase — FE-ADM-001/002 are inconsistency gaps, not an unsolved problem.

---

### B. Pagination and listing performance

See FE-ADM-003 above (payment-filtered order list fetches everything client-side).

**FE-ADM-005 — Default table page sizes are small; no virtualization anywhere, but
this is currently low-risk**
- Screens/files: `src/components/table/table-pagination-custom.js` line 13:
  `rowsPerPageOptions = [5, 10, 25]` is the shared default used by essentially every
  list screen (`OrderStatusView`, `UserManagementListView`, rider/master-data lists).
  `grep` for `react-window`/`react-virtualized` across `src/` returns nothing.
- Why it matters / impact: with the default 5/10/25 row page sizes, an unvirtualized
  `<Table>` rendering 25 rows (each with several `Chip`/`Tooltip`/`IconButton` children,
  e.g. the "Manage Ticket" action column renders up to 8 icon buttons per row, lines
  1526–1676 of `order-status-view.js`) is not large enough to need virtualization today.
  This becomes relevant only if `rowsPerPageOptions` is ever widened (e.g. an "export
  all 500 rows to view inline" ask) or if FE-ADM-003's unpaginated fetch path is asked
  to render inline instead of via Excel export.
- Severity: Low (currently), would become Medium/High if page sizes grow
- Confidence: Confirmed (no virtualization present); severity judgment is Strong
  indication rather than measured, since no actual jank measurement was taken
- Recommended improvement: no action needed today; if any screen's page size is raised
  materially, revisit virtualization (`react-window`) for that screen specifically.
- Dependencies/risks: none.
- How to validate later: if `rowsPerPageOptions` changes, profile render time with
  React DevTools Profiler at the new max page size.

---

### C. Caching and state management

**FE-ADM-006 — Redux Toolkit + react-redux + redux-persist are shipped for a single
unused demo slice; real screens use SWR + local state instead**
- Files: `src/redux/store.js`, `src/redux/root-reducer.js` (lines 15-17: the entire
  `rootReducer` is `combineReducers({ checkout: persistReducer(...) })` — one slice),
  `src/redux/slices/checkout.js`. The `checkout` slice backs the minimal-kit template's
  e-commerce demo ("Shop"/"Checkout" pages under `src/sections/product/*`), which are
  not part of the real Pressto workflow (confirmed: the sibling demo page
  `src/sections/order/view/order-list-view.js`, which imports `_orders` from
  `src/_mock`, is NOT referenced by the real routing in
  `src/routes/sections/dashboard.js` — the real "Manage Ticket" screen is
  `OrderStatusView`, routed as `OrderStatusPage` at line 68/395 of `dashboard.js`).
  Meanwhile every real list/detail screen audited (orders, riders, users, master data)
  uses `useSWR` (via `src/api/*.js`) plus plain `useState`, never
  `useSelector`/`useDispatch` from this store.
- Measured impact: not measured (no bundle analysis run). By dependency inspection,
  `@reduxjs/toolkit`, `react-redux`, `redux`, and `redux-persist` are all listed as
  runtime `dependencies` in `package.json` and `ReduxProvider` is mounted unconditionally
  at the app root (`src/App.js` line 31 imports `src/redux/redux-provider`), so this
  code ships in the main bundle on every page load regardless of whether any routed
  screen uses Redux state.
- Why it matters: four dependencies' worth of JS (store setup, persist middleware,
  localStorage read/write on every state change) running for every real user even
  though nothing in their workflow touches Redux.
- Severity: Medium
- Confidence: Confirmed that the only reducer is the demo `checkout` slice; "unused in
  the real app" is Strong indication (based on `order-list-view.js`'s demo page not
  being routed) rather than an exhaustive grep of every `useSelector` call site — worth
  a quick confirmatory grep before removing.
- Recommended improvement: if the Shop/Checkout demo pages are confirmed unused,
  remove `ReduxProvider`, the `redux` family dependencies, and the demo pages/slice
  together; this is a deletion, not a rewrite, since the real app already runs entirely
  on SWR + local state.
- Dependencies/risks: must first confirm with a full-repo grep for `useSelector`/
  `useDispatch`/`react-redux` that no real (routed) screen depends on the `checkout`
  slice before deleting — this audit spot-checked but did not exhaustively verify every
  call site.
- How to validate later: `grep -rn "react-redux" src --include=*.js | grep -v _examples
  | grep -v sections/product`; if empty, safe to remove.

**FE-ADM-007 — Two full third-party map libraries shipped, plus several CSS files
imported unconditionally at the app root regardless of route**
- Files: `src/App.js` lines 13, 16, 19–20 import `mapbox-gl/dist/mapbox-gl.css`,
  `react-quill/dist/quill.snow.css`, and `slick-carousel/slick/slick.css` /
  `slick-theme.css` at the top of the app entry point, unconditionally for every route.
  Separately, `mapbox-gl`/`react-map-gl` are used in `src/components/map/*` and
  `src/sections/contact/contact-map.js` (the latter is the template's demo "Contact Us"
  map, likely unrouted in the real app — not confirmed exhaustively), while
  `@react-google-maps/api` is used independently in
  `src/sections/customers/customer-address-map.js` (a real, in-use feature: customer
  delivery-address picking).
- Measured impact: not measured (no bundle analyzer run) — flagging the presence of two
  independent mapping stacks (Mapbox GL JS + react-map-gl, and @react-google-maps/api)
  plus always-loaded CSS for quill/slick/mapbox as a bloat risk, not a quantified one.
- Why it matters: two mapping libraries do largely overlapping jobs; shipping both
  (even if code-split per-route) means duplicate map-rendering code paths to maintain,
  and the CSS imports at the App.js root load on literally every page view including
  login, regardless of whether that session ever opens a map.
- Severity: Medium
- Confidence: Strong indication (confirmed from imports; exact byte impact not measured)
- Recommended improvement: (1) move the mapbox-gl/quill/slick CSS imports into the
  specific lazy-loaded route chunks that actually render those components instead of
  `App.js`, if the build tooling (CRA/webpack) supports it; (2) decide on one mapping
  library for new map features going forward and plan to migrate the lesser-used one
  off (likely retire whichever backs the unrouted demo contact-map, keeping Google Maps
  for the live customer-address feature) rather than carrying both long-term.
- Dependencies/risks: CSS-import relocation needs testing per CRA's webpack config
  (CRA typically still extracts all imported CSS into one bundle regardless of where the
  `import` statement lives in the module graph unless the owning component is itself
  behind `React.lazy`), so the actual win depends on whether `contact-map.js` and
  `customer-address-map.js` are already behind lazy-loaded routes (they appear to be,
  since route-level code splitting is used throughout `dashboard.js`) — needs
  confirmation with a real bundle-analyzer run before committing to a specific fix.
- How to validate later: run `npm run build` with `source-map-explorer` or
  `webpack-bundle-analyzer` (not run as part of this read-only audit) and check whether
  mapbox-gl/quill/slick-carousel end up in the main chunk or a route chunk.

**FE-ADM control note (not a defect)**: no optimistic-update pattern was found in the
payment/stock-affecting flows checked (order payment recording, status transitions,
rider cash handover) — these all call the server (`axiosInstance.post/patch`) and only
update local/SWR state from the response or via `mutate()`/`refreshOrders()` afterwards
(e.g. `handleMarkReady`, `order-status-view.js` lines 809–833; the cancel-ticket flow,
lines 1181–1208). `grep` for `optimisticData` across `src/` returns no matches. This is
a positive finding worth recording since the audit brief specifically asked to check
for this risk — none found in the screens reviewed.

---

### D. Rendering and browser performance

**FE-ADM-008 — No `React.memo` on any list-row component; rows re-render on every
poll tick even when their data hasn't changed**
- Files: `grep -rn "memo(" src` across the real (non-illustration/non-icon) row
  components returns nothing for `src/sections/orders/order-table-row.js`,
  `src/pages/riderManagement/manage/rider-management-table-row.js`,
  `src/pages/userManagementMaster/user-management-table-row.js`, or the inline row JSX
  in `order-status-view.js` (lines 1298–1680). The only `memo(` hits in the codebase are
  in generic/shared infra (`components/chart/chart.js`, `components/scrollbar`,
  `nav-section`) and SVG illustration/icon files, not list rows.
- Evidence of impact: `OrderStatusView` polls every 10 seconds
  (`refreshInterval: 10000`, line 754) and on every successful revalidation, `orders`
  is recomputed via `.map(mapApiOrderToAppSchema)` (lines 777–783, memoized on
  `apiOrders` reference) — but because SWR returns a new array/object graph on each
  successful fetch (even when the underlying data is unchanged), and no row component is
  memoized, every visible row (each rendering ~8 `Tooltip`+`IconButton` pairs, multiple
  `Chip`s, and a `CustomerSensitivityMeter` with up to 10 child `Box` elements) fully
  re-renders every 10 seconds regardless of whether that specific order actually
  changed.
- Why it matters: on a screen staff leave open for a full shift, this is a steady
  10-second re-render of the entire visible table (up to 25 rows x ~20+ DOM nodes/row)
  purely from polling, even with no user interaction — a candidate for visible
  jank/battery drain on lower-end store terminals, though not measured directly.
- Severity: Medium
- Confidence: Strong indication (confirmed absence of memoization and presence of the
  10s poll; actual jank was not profiled with React DevTools in this audit)
- Recommended improvement: wrap row-rendering components in `React.memo` with a
  comparator on the row's own fields (or stable row ids + a shallow-equal custom
  compare), and/or have the SWR fetcher return referentially-stable row objects when
  content is unchanged (e.g. a `compare` function on `useSWR`, or diffing in
  `mapApiOrderToAppSchema`) so unaffected rows skip re-render.
- Dependencies/risks: moderate refactor — must verify memoized rows still pick up
  `isSuperAdmin`, `markingReadyOrderId`, and other row-external state used inside each
  row's action buttons (lines 1300–1676) via props rather than closures.
- How to validate later: React DevTools Profiler, record 15 seconds on
  `/dashboard/orders/status` with the tab focused and idle, count re-renders per row
  component across two poll cycles.

**FE-ADM-009 — Dead/unrouted template demo code still present (bundle and
maintenance cost, not confirmed user-facing)**
- Files: `src/sections/order/view/order-list-view.js` (uses `_mock._orders`, not
  routed — see FE-ADM-006), plus the broader minimal-kit demo surface (`src/sections/blog`,
  `mail`, `chat`, `kanban`, `product`, `tour`) still present in `src/sections` and
  `src/pages`.
- Why it matters: even though route-based `lazy()` splitting (confirmed present in
  `src/routes/sections/dashboard.js`, `main.js`, `components.js`, `auth-demo.js`) means
  these are likely separate chunks rather than bloating the main bundle, they remain
  part of the source tree, inflate build time, and risk confusing future contributors
  about which "Orders" screen is real (as this audit itself had to disambiguate).
- Severity: Low
- Confidence: Strong indication (confirmed unrouted for `order-list-view.js`
  specifically via the dashboard.js route table; the rest of the demo surface was not
  individually re-verified against every route file)
- Recommended improvement: confirm with the team whether `/components`-style demo
  routes are still intentionally reachable (e.g. for onboarding/QA reference) and, if
  not, delete the demo pages/sections to reduce source and build surface.
- Dependencies/risks: low risk to delete once confirmed unrouted; don't delete without
  checking `routes/sections/components.js`/`auth-demo.js` aren't still linked from a nav
  item somewhere.
- How to validate later: cross-reference every file under `src/sections/{blog,mail,chat,
  kanban,product,tour}` against all `routes/sections/*.js` route tables for a live path.

**No raw unoptimized `<img>` pattern found at scale**: `grep "<img "` across
`pressto-admin-panel/src` returns only 5 hits, all in QR/label-generation utilities
(`taffeta-label.js`, `transfer-bag-qr.js`, `bag-qr-dialog.js` — these render
small generated QR codes, not user-facing list imagery) or in demo/_examples files.
The app otherwise appears to route image rendering through `src/components/image`
and `react-lazy-load-image-component` (present in `package.json` and imported in
`App.js` line 23). Not a finding — recorded as a control check.

---

## Customer Web (pressto-customer-web)

### A. API consumption

**FE-CW-001 — Orders page fetches up to 200 orders per filter change, then paginates
5-per-page entirely client-side**
- Screen/file: `src/pages/app/Orders.jsx`, line 25: `const ORDERS_FETCH_LIMIT = 200;`
  line 24: `const PAGE_SIZE = 5;`. The fetch effect (lines 467–493) always sends
  `limit: ORDERS_FETCH_LIMIT, skip: 0` to `loadOrders`, regardless of how many orders
  actually exist; the result is then combined with pickup requests and paginated purely
  in-memory via `.slice()` at lines 564–572.
- Evidence: `loadOrders` → `fetchOrders` (`src/api/customer.js` lines 1480–1500) does
  support real server-side `limit`/`skip` params (the plumbing exists), but the caller
  always asks for up to 200 rows up front instead of `PAGE_SIZE` (5) rows per page, so
  the server-side pagination capability is not actually used for its intended purpose.
- Measured impact: not measured; for a long-tenured customer with >200 orders this is
  also an incomplete fix even for the "fetch everything" goal (stops at 200), while for
  the typical customer with few orders it's 200 rows requested to render 5.
  5
- Why it matters: this is the clearest instance in either app of the "fetch a large
  batch, paginate client-side" anti-pattern called out in the brief — on mobile/cellular
  connections (this is the customer-facing app, most likely accessed on phones) an
  over-sized response directly costs load time and data.
- Severity: High
- Confidence: Confirmed
- Recommended improvement: pass `limit: PAGE_SIZE, skip: safePage * PAGE_SIZE` (plus the
  existing filter params) to `loadOrders`, re-fetching on page change instead of
  re-slicing a 200-row local array; this does mean the combined order+pickup sort/merge
  (lines 499–562) needs rethinking since pickups currently aren't paginated server-side
  either (see FE-CW-003) — likely needs a combined-list endpoint or two independently
  paginated sections instead of one merged list if a true server-side fix is wanted.
- Dependencies/risks: the current UX intentionally interleaves orders and pickup
  requests into one sorted, paginated list — switching to server pagination per-source
  breaks that interleaving unless the backend can return a merged, paginated feed, or
  the UI is restructured into two separate paginated lists/tabs.
- How to validate later: Network tab on `/orders`, check response row count returned by
  the orders API call versus `PAGE_SIZE` actually rendered.

**FE-CW-002 — Pickup requests are always fetched in full (and as two parallel
requests) with no pagination, every time the Orders page loads**
- Files: `src/pages/app/Orders.jsx` lines 424–435 (`loadPickupRequests()` called with no
  params in a `useEffect` on every mount of the Orders page) →
  `src/context/SessionContext.jsx` `loadPickupRequests` (lines 1348–1365) →
  `src/api/customer.js` `fetchPickupRequests` (lines 692–705): when no `status` filter
  is passed (the Orders page never passes one), this function issues **two** parallel
  unpaginated requests (`fetchPickupRequestsOnce(token, params)` and a second call with
  `status: 'cancelled'` merged in) specifically so cancelled pickups aren't missed by
  whatever default filtering the backend list endpoint applies.
- Measured impact: not measured. By inspection: 2 full-table HTTP requests every time a
  customer opens "My Orders," with no `limit`/`skip` visible in this call path at all.
- Why it matters: compounds with FE-CW-001 — opening the Orders screen already issues an
  oversized orders request, and now also two full, unbounded pickup-request requests,
  all merged and re-filtered/re-sorted client-side (`combinedItems`, lines 499–562).
- Severity: High
- Confidence: Confirmed
- Recommended improvement: same direction as FE-CW-001 — add real `limit`/`skip` (and
  ideally a server-side "include cancelled" flag so the double-request workaround isn't
  needed) to the pickup-requests list endpoint and have the Orders page request only
  what it will render for the current page.
- Dependencies/risks: the double-request-for-cancelled workaround suggests the backend
  endpoint's default filtering behavior is itself a constraint — fixing this cleanly may
  require a backend change (an explicit "all statuses" mode) rather than just a frontend
  parameter tweak.
- How to validate later: Network tab on opening `/orders`; count and inspect the two
  pickup-request GET calls and their response sizes.

**FE-CW-003 — Session bootstrap fans out 7 parallel requests on every fresh login/
session establishment**
- File: `src/context/SessionContext.jsx`, `refreshCustomerData` (lines 320–450),
  specifically the `Promise.allSettled` at lines 340–353 firing
  `fetchCustomerProfile`, `fetchCustomerAddresses`, `fetchCustomerWallet`,
  `fetchOrders` (limit 50), `fetchOrdersSummary`, `fetchCustomerPhones`,
  `fetchCustomerContacts`, and `fetchCustomerPreferences` together. This is correctly
  guarded against re-running per token via `lastRefreshedTokenRef`/
  `refreshCustomerDataInflight` (lines 320–333, 452–463), so it is not a repeated-refetch
  problem — it's a "how much is on the critical path of first render after login"
  observation.
- Measured impact: not measured (would need a real network trace against the live API
  to know actual latency contribution).
- Why it matters: worth knowing as a baseline when diagnosing "app feels slow right
  after login" reports — 7 concurrent calls is reasonable for a hand-rolled session
  bootstrap, but it's exactly the kind of place a waterfall/slow endpoint would show up.
- Severity: Low (informational — no debounce/dedup defect found here)
- Confidence: Confirmed code pattern; performance impact Needs validation
- Recommended improvement: none required by default; if login-to-first-render latency
  is ever reported as slow, start here and check which of the 7 calls is the long pole.
- Dependencies/risks: none.
- How to validate later: Network tab waterfall immediately after OTP verification /
  login.

**FE-CW control note (not a defect)**: `Orders.jsx`'s own text search IS correctly
debounced (lines 449–454, 350ms `setTimeout`), and `src/utils/invoiceReceipt.js` line
419 dynamically `import()`s `html2pdf.js` on demand rather than bundling it eagerly —
both are good patterns, included here as positive contrast to FE-CW-001/002.

---

### B. Pagination and listing performance

Covered under FE-CW-001 and FE-CW-002 above — both the orders list and the pickup-
requests list that feed the one "My Orders" screen are effectively unpaginated at the
network layer, with a small (5-row) page only applied after the full set already landed
in the browser.

---

### C. Caching and state management

**FE-CW-004 — No shared data-fetching/caching library (SWR/React Query/etc.); a single
~2,500-line hand-rolled `SessionContext` does both session persistence and ad hoc
in-memory caching**
- File: `src/context/SessionContext.jsx` (entire file). `package.json` confirms no
  `swr`, `@tanstack/react-query`, or similar dependency — state management here is
  `useState`/`useContext` plus manual `localStorage` persistence (`loadStored`/
  `saveStored`, lines 134–173).
- Evidence of a real caching mechanism existing, but only for one data type: the
  "pending approvals" sweep has a genuine cache (`loadAllApprovalsCache`,
  `loadAllApprovalsDoneTokens`, `LOAD_ALL_APPROVALS_TTL_MS = 5 * 60 * 1000`, lines
  117–121 and 712–851) — a 5-minute TTL plus a hard "once per token" lock. No equivalent
  cache/TTL/dedup exists for `loadOrders`, `loadWallet`, `loadAddresses`,
  `loadPickupRequests`, etc. — each of these hits the network every time it's called,
  relying entirely on call sites to avoid calling them redundantly.
- Why it matters: reference/semi-static data (store-assigned pickup slots via
  `loadPickupSlots`, item categories, catalog/service lists via `loadCatalog`/
  `loadServices`) has no cache layer at all — e.g. `loadPickupSlots` (lines 1333–1346)
  always calls `fetchPickupSlots`; if multiple components on a page (or page
  re-mounts during navigation) each call this, it's a fresh network round-trip every
  time with no staleness check.
- Severity: Medium
- Confidence: Confirmed (direct code read of the whole file's caching surface)
- Recommended improvement: either introduce a lightweight data-fetching library (SWR is
  already a dependency one repo over, in `pressto-admin-panel` — reusing the same
  pattern here would also improve consistency across the two frontends), or generalize
  the existing `loadAllApprovalsCache` TTL/lock pattern into a small shared helper used
  by `loadPickupSlots`, `loadCatalog`, `loadServices`, and other rarely-changing data
  loaders.
- Dependencies/risks: moderate — touches a central, heavily-used context; should be
  done incrementally (one loader at a time) with manual testing per this project's
  current testing approach, not a single big-bang rewrite.
- How to validate later: Network tab across a normal "browse the app" session, watch for
  repeated identical GETs to `/pickup-slots`, `/catalog`, `/services`, etc.

**FE-CW-005 — No optimistic-update consistency risk found on the wallet-payment path
(positive finding)**
- File: `src/context/SessionContext.jsx`, `payOrderBill` (lines 1541–1613, the real
  `ORDERS_API_ENABLED && accessToken` branch specifically). This function `await`s
  `payOrderFromWallet` and only updates local wallet balance / order payment status
  (`balanceDue`, `totalCollected`, `paymentStatus`) from the server's own response
  (`result.balanceDue`, `result.totalCollected`, `result.walletAmountDeducted`) — it does
  not assume success and update the UI before the server confirms. The separate
  "offline/demo fallback" branch below it (used only when `ORDERS_API_ENABLED` is off or
  there's no token) does mutate local state speculatively, but that path cannot run
  against the real backend/production configuration.
- Why it matters: the audit brief specifically asked to flag optimistic updates on
  payment/stock-sensitive actions if they risk consistency — none were found on the
  real payment path. Recorded here so this is documented as checked, not skipped.
- Severity: N/A (control finding, not a defect)
- Confidence: Confirmed
- Recommended improvement: none needed; just confirm `ORDERS_API_ENABLED` is in fact
  `true` in the production build (`src/api/config.js`) so the demo fallback path is
  never reachable by real customers.
- Dependencies/risks: none.
- How to validate later: inspect `src/api/config.js` `ORDERS_API_ENABLED` value per
  environment/build config.

---

### D. Rendering and browser performance

**FE-CW-006 — No route-based code splitting anywhere; every page is statically
imported into the main bundle**
- File: `src/App.jsx` (lines 1–58): every single routed page/component — both auth
  pages (`Login`, `Otp`, `Register`, `Splash`) and the entire authenticated app surface
  (`Home`, `Orders`, `OrderDetail`, `OrderReprocess`, `Pricing`, `Wallet`, `Profile` (+ 3
  sub-exports), `ItemConditions`, `NotificationsPage`, `Messages` (+ 4 sub-exports),
  `Settings` (+ 3 sub-exports), `Approvals` (+ 3 sub-exports), `Legal`, the 8-screen
  order-booking flow (`OrderFlowPages`), and the 4-screen pickup-request flow
  (`PickupRequestFlow`) — are imported with plain static `import` statements. `grep` for
  `React.lazy`/`lazy((` across `pressto-customer-web/src` returns zero matches.
- Measured impact: not measured (no bundle analysis run); by inspection this means a
  first-time visitor hitting the `/login` splash screen downloads and parses JS for
  every authenticated-area screen (wallet, settings, messaging, the full order-booking
  wizard, etc.) before they've even signed in.
- Why it matters: this is a customer-facing app, most likely opened on mobile data; CRA/
  Vite route-level `React.lazy` + `<Suspense>` is a standard, low-risk win here, and the
  sibling `pressto-admin-panel` app already demonstrates the pattern throughout its
  route tables (`src/routes/sections/*.js`) — this app has none of it.
- Severity: High
- Confidence: Confirmed
- Recommended improvement: convert the route element imports in `App.jsx` to
  `React.lazy(() => import(...))` with a `<Suspense>` boundary (Vite supports this with
  zero extra config), starting with the heaviest/least-immediately-needed screens
  (order-booking flow, settings, messages) so the login/home critical path shrinks
  first.
- Dependencies/risks: low risk — React Router v6 (in use here, `react-router-dom`
  `^6.28.0`) supports lazy route elements natively; mainly needs a loading fallback UI
  decision and a smoke-test pass per route.
- How to validate later: run `npm run build` (Vite) and inspect `dist/assets` chunk
  list/sizes before and after — not run as part of this read-only audit.

**FE-CW-007 — Single raw `<img>` without a lazy-loading attribute (isolated, low
severity)**
- File: `src/components/SpecialInstructionsForm.jsx`, line 589:
  `<img src={activeItem.imageUrl} alt="" />` — no `loading="lazy"`.
- Why it matters: this is the only raw `<img>` found in the entire customer-web
  `src/` tree (`grep "<img "` returns exactly one hit); it renders a single garment-item
  preview image inside a form, not a list/gallery, so the practical impact is minimal.
- Severity: Low
- Confidence: Confirmed
- Recommended improvement: add `loading="lazy"` for consistency; not urgent given it's a
  single, non-list image.
- Dependencies/risks: none.
- How to validate later: n/a (trivial attribute add).

**FE-CW-008 — `OrderLiveMap` courier marker animation uses `setInterval`, not a real
location-tracking poll (needs validation of scope)**
- File: `src/components/OrderLiveMap.jsx`, line 130: `tickTimer = window.setInterval(...)`
  advances a simulated marker position along a precomputed route (`pointAlongRoute`)
  rather than polling a live rider-location endpoint. Actual order/garment tracking data
  (`fetchOrderTracking`) is fetched once per `loadOrder` call
  (`SessionContext.jsx` lines 588–591, inside a `Promise.all`, not on an interval) — no
  polling overhead was found for real tracking data.
- Why it matters: recorded because the audit brief asks about dashboard/map polling
  patterns; this one does NOT contact the network repeatedly — the interval is purely a
  client-side animation tick. No action needed on the networking side; flagging as
  "checked, found to be a non-issue" so it isn't re-investigated as if it were an open
  question.
- Severity: N/A (control finding)
- Confidence: Confirmed for the interval's local-only nature; whether `OrderLiveMap` is
  ever given a true live rider-location feed elsewhere (a future feature) was not fully
  traced beyond this component — Needs validation if rider live-tracking is a planned
  feature, to make sure it doesn't get added as a tight client poll without checking the
  backend's expected call rate.
- Recommended improvement: none now; if real-time rider location is added later, prefer
  a backend push/websocket or a conservative poll interval (e.g. 15-30s) with pause when
  the tab is hidden (`document.visibilityState`).
- Dependencies/risks: none currently.
- How to validate later: re-check `OrderLiveMap.jsx` and any new tracking feature work
  for an actual network poll interval if/when live rider tracking is built for
  customers.

---

## Dependency/bundle notes (not measured, flagged for a real bundle-analysis pass)

- `pressto-admin-panel`: no `moment.js` found (uses `date-fns`, a lighter choice); `lodash`
  is a `dependencies` entry and is imported in several real (non-demo) files
  (`src/utils/order-api-mapper.js`, `src/utils/shift-module.js`,
  `src/sections/pos/shift-close-view.js`, `src/sections/orders/order-status/hooks/
  use-order-approvals.js`, `src/sections/orders/new-order/hooks/*`,
  `src/sections/finance/refund-payout-approval-panel.js`) — whether these import the
  full `lodash` package or individual functions (`lodash/get` style) was not checked
  file-by-file in this pass; worth a quick follow-up grep for `from 'lodash'` (whole
  package) vs `from 'lodash/...'` (single function) before deciding whether this is a
  bundle-size concern.
- `pressto-admin-panel` ships both Firebase's full SDK (`firebase` ^9.22.2, used only in
  `src/auth/context/firebase/auth-provider.js`) and Auth0 (`@auth0/auth0-react`) and AWS
  Amplify Auth (`@aws-amplify/auth`) as dependencies — three separate auth provider
  integrations present in `package.json`; which one is actually active in production
  was not confirmed in this pass (check `src/auth/context/*` wiring and env config) —
  flagging as a follow-up since unused auth SDKs (especially Firebase's) are a known
  common source of avoidable bundle weight.
- `pressto-customer-web` has a notably lean dependency list (`axios`, `crypto-js`,
  `html2pdf.js` (dynamically imported — see FE-CW control note), `leaflet`,
  `react`/`react-dom`, `react-router-dom`) — no heavy UI framework, no duplicate map
  libraries, no state-management library. The main structural issue found here is
  FE-CW-006 (no code splitting), not dependency bloat.
- No `npm run build` / bundle analyzer was executed for either app as part of this
  audit (explicitly out of scope per the read-only/no-build-output instruction) — all
  of the above is from `package.json` + `grep` inspection, not measured bytes.
