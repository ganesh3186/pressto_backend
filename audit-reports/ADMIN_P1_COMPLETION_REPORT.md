# Admin frontend P1, P2 and P3 implementation report

Date: 2 November 2026.
Branch: `priority-points` in backend and admin panel.
Scope: all nine numbered admin findings, FE-ADM-001 through FE-ADM-009. Customer-web findings and the separate system-notification enhancement plan remain deferred. This original report filename is retained for continuity.

## Completed points

| ID | Change | Repositories | Status |
|---|---|---|---|
| FE-ADM-001 | Customer/mobile, ticket ID and invoice ID inputs wait 700ms after typing stops before changing the Manage Ticket query. Input updates remain immediate. Requests pause while the text settles, avoiding a request for the old search when the page resets. | Admin | Implemented and focused tests passed |
| FE-ADM-002 | Rider search waits 700ms, preserves existing pasted-phone normalization, resets to page one and retains server list/count pagination. | Admin | Implemented and focused tests passed |
| FE-ADM-003 | Manage Ticket always supplies page/page size. The backend accepts paymentStatus and filters in SQL before page/count. Frontend payment filtering/slicing is removed; the pager uses the backend count. Export batches use the same payment condition. | Backend + admin | Implemented; SQL, ORM and focused tests passed |
| FE-ADM-004 | Three invoice-dialog polls now run every 15 seconds instead of 5, stop when closed, do not refresh in hidden/offline tabs, revalidate on focus/reconnection and use a bounded retry count. Existing mutation handlers still refresh immediately. | Admin | Implemented; polling/approval regression test passed |
| FE-ADM-008 | Manage Ticket rows extracted into a memoized component; Rider rows memoized. Stable action handlers allow unchanged rows to skip rendering. Deep comparisons include all props so permissions, busy state, callbacks and changed values cannot silently stay stale. | Admin | Implemented; rendering/action regression tests passed |
| FE-ADM-006 | Removed the root Redux provider, demo-only checkout store/slice and four direct Redux dependencies after verifying their only consumers were unreachable demos. | Admin | Implemented; production build passed |
| FE-ADM-007 | Removed Mapbox code and its dependencies; retained Google Maps for customer addresses. Removed root Mapbox/editor/carousel CSS imports; editor/carousel styles are imported by their components. | Admin | Implemented; production build and entry-asset measurement passed |
| FE-ADM-009 | Removed 404 source files verified unused/unreachable, including demo screens/routes, isolated Mapbox/Redux helpers and inactive provider implementations. | Admin | Implemented; source parsing/import checks and production build passed |
| FE-ADM-005 | Reviewed the existing small 5/10/25 default page sizes. No virtualization implementation or extra dependency was justified. Existing larger-page screens were not rewritten without evidence of a rendering problem. | Admin | Review complete; no code change required |

## Correction to the original audit

FE-ADM-003 originally described an unbounded full-order fetch. The current backend actually defaults to 20 rows and caps requested pages at 100. Removing frontend pagination fetched that default page, then applied payment filtering to just those rows. This could omit matching tickets outside the first 20 and report an incorrect total. The implementation fixes that behavior without introducing an unbounded browser fetch.

## Payment behavior preserved

- Success, Partial, Pending and Cancelled remain the visible payment filter options.
- Success/Partial/Pending use the table's existing whole-rupee outstanding-balance semantics. This includes legacy decimal totals.
- Split children include allocated payment plus their own payments. Split parents use the allocated share, not their superseded original transactions.
- Refund transactions are excluded from collected totals, matching the existing order list calculation.
- Cancelled includes all cancelled tickets; a cancelled ticket with collected money can also appear under Success, matching the existing UI behavior.
- Drafts do not appear under Success/Partial/Pending. The API also accepts the legacy `unpaid` filter and `paid` alias.
- Payment-only queries return an exact matching count. The pre-existing 1000-match count cap for text/invoice searches is unchanged, including when those searches are combined with payment filters.
- Store permissions, deletion checks, date/order-status constraints and existing invoice search conditions continue to narrow results.
- No payment writes, gateway callbacks, invoice generation, refunds or delivery rules were changed.

## Query handling

Payment-only queries aggregate payment totals over the already scoped orders and reuse one materialized match set for page and count in a single SQL statement. Only IDs for the selected page are hydrated into the API response. This avoids the initial implementation's repeated per-order payment lookups for separate page/count queries.

Text/invoice searches retain the existing parameterized search path with the payment condition added before pagination. Cancelled filtering uses the ordinary order-status query without calculating payment totals.

The P1 payment-query change adds no dependencies, environment variables, tables or migrations and relies on the existing payment_transaction.orderid index. Manage Ticket's existing 10-second polling is unchanged. The P2 invoice refresh interval is now 15 seconds, as detailed below.

## P2/P3 implementation details

### Invoice polling and external payments

Polling means repeating API reads at a fixed interval. The invoice dialog previously made roughly 36 periodic reads per minute: three endpoints every five seconds. It now makes roughly 12 periodic reads per minute while visible and online: three endpoints every 15 seconds, about 67% fewer periodic requests. Initial loads, focus/reconnect, retries and user actions are additional to those figures.

All three snapshots remain periodically refreshed because a customer may pay a PG link outside the admin UI, or finance may change approval state elsewhere. Removing every poll or refreshing only after local clicks would leave these events stale. Payment actions retain their existing immediate refresh/printing path. Clearing a pending cheque/PDC approval still triggers immediate detail/invoice/challan refresh. Approval failures continue to disable unsafe payment actions and offer Retry.

### Row memoization

Memoization lets React reuse an unchanged row instead of rebuilding its chips, buttons and tooltips when its parent updates. Comparisons use existing individual-function `lodash/isEqual` imports, not a new dependency. Data values and all external action/permission/busy props participate in comparisons; callbacks are not deliberately ignored.

The original audit overstated SWR behavior: SWR can retain equal data across revalidation, so an unchanged network response does not inevitably rerender every row. The new memo boundaries protect rows when parent state or other rows change as well. No claim of measured browser frame-rate improvement is made without profiling actual store terminals.

### Source and dependency cleanup

- Parsed all 1,798 initial non-test JS/TS modules, including static imports, re-exports and literal dynamic imports. No non-literal dynamic imports or parse failures were found. Followed dependencies from the real app entry and checked incoming references before deleting demo files.
- Removed 404 source files. These cover the unused product/checkout, old mock-order, blog, mail, chat, kanban, tour, example/component-demo, contact/Mapbox and auth-demo surfaces, their unrouted page/route wrappers, and isolated unused provider code. Shared components, live operational screens and P1 changes are retained.
- Confirmed the root application and shared auth hook use JWT. Removed unused Auth0, Amplify and Firebase provider implementations/SDK dependencies; existing live JWT authentication is preserved. No production authentication mode was switched.
- Removed 10 direct dependencies: `@reduxjs/toolkit`, `react-redux`, `redux`, `redux-persist`, `mapbox-gl`, `react-map-gl`, `worker-loader`, `@auth0/auth0-react`, `@aws-amplify/auth`, `firebase`.
- Updated package.json, package-lock.json and yarn.lock through npm's dependency update. Preserved the user's existing package-name change.
- Retained Google Maps, editor and carousel packages where appropriate. Styles are no longer imported globally from App.js. Shared source that is not part of a verified unused demo family was not blanket-deleted.
- Checked remaining Lodash imports: no whole-package `lodash` imports were found; individual-function imports already use the appropriate pattern, so no rewrite was needed.

### Build measurements

Measured gzip sizes of the entrypoint files in the saved pre-cleanup build and the new production build:

| Entry asset | Before | After | Difference |
|---|---:|---:|---:|
| Initial JavaScript | 556,403 bytes | 540,818 bytes | -15,585 bytes, about 2.8% |
| Initial CSS | 16,238 bytes | 3,281 bytes | -12,957 bytes, about 79.8% |

These are entry assets, not the total of every lazy chunk and not end-to-end browser timings. The prior build predates the full current change set; the figures are not an isolated per-feature benchmark. The app still reports a large-bundle warning, so these improvements do not imply all bundle-size work is finished.

## Validation performed

| Check | Result |
|---|---|
| Backend TypeScript build | Passed |
| Frontend focused component tests | 8 passed across 4 suites, covering searches/pagination, memoized rows and invoice polling/approval refresh |
| Frontend debounce scenarios | Three Manage Ticket text fields; rider search; clearing search; resetting page; preserved phone normalization |
| Frontend payment pagination | Payment filter retains page/page size, moves to the next page and uses server total |
| Backend full unit suite (P1 validation run) | 360 passed; 2 existing shift collection/revenue tests still fail because their mocks lack repository.execute, required by an earlier main-branch SQL change. No backend application code changed during P2/P3. |
| Invoice-filter unit tests | Updated stale mocks for the existing SQL search path; both previously failing invoice-filter tests now pass |
| New backend payment tests | SQL filtering/scoping and page/count wiring, invalid-filter rejection, and export across multiple batches passed |
| PostgreSQL synthetic-fixture checks | Both grouped and combined-search SQL conditions passed for all supported filter categories, split allocation, refunds, zero/decimal totals, drafts, cancelled tickets, null legacy transaction types, store/deletion scope and pages beyond the first 20 |
| Real ORM/local restored database | Bounded payment pages/counts, combined invoice+payment filter and empty store scope passed using database-enforced read-only connections |
| Lint | Changed files checked; no new errors. One existing prefer-destructuring warning remains in order-status-view.js |
| Admin production build | Passed with existing lint, html5-qrcode source-map, outdated Browserslist and bundle-size warnings |
| Full frontend suite | 211 tests passed across 56 suites; one existing taffeta-manage-order-print suite remains blocked by the Axios ESM/Jest mock setup |
| Static cleanup verification | 1,394 non-test source modules remain; no parse failures or dangling imports into the removed source families were found |
| Dependency installation | npm updated dependency resolution and both lockfiles. Builds/tests used the existing installed module tree; a fresh clean install was not run in this shared development workspace. |

No business records were modified and no real notifications were sent during validation. Validation scripts under workspace tmp/ use local read-only connections and synthetic CTE fixtures.

The first local ORM implementation took roughly 4-7 seconds on a store with approximately 122,000 historical orders. Batching payment aggregation reduced the observed partial-filter request to roughly 2.9 seconds in a subsequent run, with other payment categories around 3-4 seconds. These are different local runs affected by caches and background work, not a controlled benchmark or production capacity result. Exact counts over large histories still have a cost; measure staging concurrency before claiming the wider traffic issue is solved.

## Remaining verification / deferred work

1. Browser smoke test on staging: combine payment with customer/ticket/invoice/date/store filters; compare rows, totals and Excel export across pages.
2. Multi-store load validation and query plans with representative production-size data.
3. Repair the two existing shift-report test mocks in the shift/backend workstream.
4. All customer-web points remain deferred, including FE-CW-001, FE-CW-002 and FE-CW-006.
5. All numbered admin P2/P3 findings are implemented or closed by review as described above. Browser visual/performance checks on staging remain necessary. Other locally filtered Manage Ticket fields such as source/placed-by are outside these changes and still require their own review.
6. Repair the existing frontend label-print suite's Axios mock setup before treating the full frontend suite as green.
7. Install dependencies from the updated lockfile before building on another machine/server. The lock update used legacy peer dependency resolution; use `npm ci --legacy-peer-deps` with the project's supported Node version, then `npm run build`. No new migration or environment variable is required for P2/P3.

Changes are local and uncommitted; nothing was pushed or deployed as part of this task. Existing local package.json and untracked reference/document files were preserved.
