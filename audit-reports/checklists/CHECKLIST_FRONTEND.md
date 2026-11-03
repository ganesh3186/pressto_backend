# Frontend Checklist

**Source:** `frontend-audit.md`.
**Priorities:** P1 = high impact. P2 = medium. P3 = low. There are no P0 items; the frontend findings are about load and speed, not data loss or security.

## Admin Panel (`pressto-admin-panel`, this team)

### P1

- [x] **Debounce the Manage Ticket text filters.** Implemented 700ms debounce for customer/mobile, ticket ID and invoice ID; retain immediate input updates and reset pagination. `FE-ADM-001`
- [x] **Debounce the Rider Management search.** Implemented 700ms debounce, preserving phone normalization and server pagination. `FE-ADM-002`
- [x] **Keep payment-filtered Manage Ticket pagination on the server.** Payment conditions now run before page/count, and export uses the same condition. Correction to the original audit: omitting pagination previously fetched the backend default 20 rows, not all orders; filtering those rows locally made results incomplete. `FE-ADM-003`

Implementation/validation report: [ADMIN_P1_COMPLETION_REPORT.md](../ADMIN_P1_COMPLETION_REPORT.md). Implemented locally on `priority-points`; staging multi-store validation remains outstanding.

### P2

- [x] **Reduce the Order Invoice Dialog's polling.** Changed three 5-second polls to 15 seconds, paused hidden/offline refresh, bounded retries, retained focus/reconnect and immediate payment/approval refreshes. `FE-ADM-004`
- [x] **Add `React.memo` to polled list rows.** Extracted memoized Manage Ticket rows and memoized Rider rows, with stable callbacks and comparisons covering row data, permissions, busy state and handlers. `FE-ADM-008`
- [x] **Remove Redux Toolkit, react-redux and redux-persist.** Verified Redux served only unreachable product/checkout demos, removed their code and root provider, and updated dependencies/lockfiles. `FE-ADM-006`

### P3

- [x] **Consolidate on one map library.** Retained live Google Maps; removed unreachable Mapbox code/dependencies and root Mapbox CSS. Moved editor/carousel styles to their owning components. `FE-ADM-007`
- [x] **Remove unrouted demo template code.** Used an import graph to verify reachability, then removed unused demo screens, routes and their isolated helpers. `FE-ADM-009`
- [x] **Review page sizes and virtualization.** Reviewed: shared default remains 5/10/25 rows, so no virtualization library is needed for this scope. Revisit if actual page sizes/render measurements justify it. `FE-ADM-005`

## Customer Web (`pressto-customer-web`, different team)

> This repo belongs to another team and is not edited from here. Hand this list to them.
> All customer-web findings are explicitly deferred for this task; none were changed or marked complete.

### P1

- [ ] **Paginate the Orders page properly.** It fetches up to 200 orders per filter change. `FE-CW-001`
- [ ] **Paginate pickup requests.** They are always fetched in full, as two parallel calls. Needs backend support. `FE-CW-002`
- [ ] **Add route-based code splitting.** Every page is loaded up front. `FE-CW-006`

### P2

- [ ] **Reduce the 7 parallel requests on session start.** `FE-CW-003`

### P3

- [ ] **Adopt a shared data-fetching and caching library.** `FE-CW-004`
- [ ] **Add lazy loading to the raw `<img>`.** `FE-CW-007`
- [ ] **Replace the `setInterval` courier marker animation in `OrderLiveMap`.** `FE-CW-008`

### No action needed

- `FE-CW-005`: no optimistic-update risk found on the wallet payment path.

---

Priorities for `FE-ADM-004`, `FE-ADM-005`, `FE-CW-003`, `FE-CW-004`, `FE-CW-007` and `FE-CW-008` weren't set in the audit report; they are my judgment.
