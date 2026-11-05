# Frontend Checklist

**Source:** `frontend-audit.md`.
**Priorities:** P1 = high impact. P2 = medium. P3 = low. There are no P0 items; the frontend findings are about load and speed, not data loss or security.

## Admin Panel (`pressto-admin-panel`, this team)

### P1

- [x] **Debounce the Manage Ticket text filters.** They send one request per keystroke. Raised from P2, because broad search terms caused the go-live slowdown. **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Waits 700 ms after typing. Still to verify: check in the browser.** `FE-ADM-001`
- [x] **Debounce the Rider Management search.** Raised from P2 for the same reason. **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Waits 700 ms after typing. Still to verify: check in the browser.** `FE-ADM-002`
- [x] **Stop fetching the whole order set when a payment filter is on.** Page on the server instead. **Status: Live on all 3 servers since Nov 4 (admin `f34805dd`, `a18622cd`; backend `2a96ef4`). Across more than one store it covers up to 90 days, and the 10-second refresh stops while it is on. Still to verify: check with store, cluster, region and all-stores logins.** `FE-ADM-003`
- [x] **Debounce the Manage Invoices, Order Summary and Pincode Mapping searches.** They sent a server search on every keystroke. **Status: Live on all 3 servers since Nov 4 (`711b1870`). Waits 700 ms after typing. Still to verify: check in the browser.** Added after the audit.

### P2

- [x] **Reduce the Order Invoice Dialog's polling** of 3 endpoints every 5 seconds. It adds up with many staff logged in. **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Now every 15 seconds, and paused in hidden or offline tabs. Still to verify: check in the browser.** `FE-ADM-004`
- [x] **Add `React.memo` to polled list rows.** **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Still to verify: check in the browser.** `FE-ADM-008`
- [x] **Remove Redux Toolkit, react-redux and redux-persist** if the single remaining use can go. **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Removed, along with the demo code that used them. Still to verify: check in the browser.** `FE-ADM-006`

### P3

- [x] **Consolidate on one map library.** **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Kept Google Maps and removed Mapbox. Still to verify: check in the browser.** `FE-ADM-007`
- [x] **Remove unrouted demo template code.** **Status: Live on all 3 servers since Nov 4 (`f34805dd`). Removed 404 files, confirmed by a clean install and production build. After pulling, run `npm ci --legacy-peer-deps`. Still to verify: check in the browser.** `FE-ADM-009`
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
