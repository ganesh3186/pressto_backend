# Frontend Checklist

**Source:** `frontend-audit.md`.
**Priorities:** P1 = high impact. P2 = medium. P3 = low. There are no P0 items; the frontend findings are about load and speed, not data loss or security.

## Admin Panel (`pressto-admin-panel`, this team)

### P1

- [ ] **Debounce the Manage Ticket text filters.** They send one request per keystroke. Raised from P2, because broad search terms caused the go-live slowdown. **Status: on `main` (`f34805dd`), not deployed. Waits 700 ms after typing.** `FE-ADM-001`
- [ ] **Debounce the Rider Management search.** Raised from P2 for the same reason. **Status: on `main` (`f34805dd`), not deployed. Waits 700 ms after typing.** `FE-ADM-002`
- [ ] **Stop fetching the whole order set when a payment filter is on.** Page on the server instead. **Status: on `main` (admin `f34805dd`, `a18622cd`; backend `2a96ef4`), not deployed. Deploy the backend first, or the filter does nothing. Across more than one store it covers up to 90 days, and the 10-second refresh stops while it is on. Next: check on staging with store, cluster, region and all-stores logins.** `FE-ADM-003`
- [ ] **Debounce the Manage Invoices, Order Summary and Pincode Mapping searches.** They sent a server search on every keystroke. **Status: on `main` (`711b1870`), not deployed. Waits 700 ms after typing.** Added after the audit.

### P2

- [ ] **Reduce the Order Invoice Dialog's polling** of 3 endpoints every 5 seconds. It adds up with many staff logged in. **Status: on `main` (`f34805dd`), not deployed. Now every 15 seconds, and paused in hidden or offline tabs.** `FE-ADM-004`
- [ ] **Add `React.memo` to polled list rows.** **Status: on `main` (`f34805dd`), not deployed.** `FE-ADM-008`
- [ ] **Remove Redux Toolkit, react-redux and redux-persist** if the single remaining use can go. **Status: on `main` (`f34805dd`), not deployed. Removed, along with the demo code that used them.** `FE-ADM-006`

### P3

- [ ] **Consolidate on one map library.** **Status: on `main` (`f34805dd`), not deployed. Kept Google Maps and removed Mapbox.** `FE-ADM-007`
- [ ] **Remove unrouted demo template code.** **Status: on `main` (`f34805dd`), not deployed. Removed 404 files, confirmed by a clean install and production build. After pulling, run `npm ci --legacy-peer-deps`.** `FE-ADM-009`
- [x] **Review page sizes and virtualization** if larger pages are requested. Reviewed: default page sizes stay 5, 10 and 25, so no virtualization is needed for now. `FE-ADM-005`

## Customer Web (`pressto-customer-web`, different team)

> This repo belongs to another team and is not edited from here. Hand this list to them.

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
