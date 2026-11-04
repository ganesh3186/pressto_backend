# System-wide admin audit logging plan

Status: Proposed design; implementation not started.
Date: 2 November 2026.
Scope: Backend business events and one permission-controlled admin audit screen, including record navigation. Covers actions initiated from admin, relevant callbacks and automated jobs so the history remains accurate regardless of entry point. Customer-web UI work is outside this plan.

This is the single implementation plan for the feature. Every new field, endpoint, route and file described below is proposed unless identified as existing. Creating this document does not implement the feature or mean all current actions are already logged.

## Objective

Answer: Who did what, on which record, for which store, when, what changed, and why?

Examples:
- Employee A created ticket ST… at Store X.
- Finance user B approved approval request AR… for a refund of ₹250 against ticket ST….
- Staff C changed a customer's phone number, with the permitted old/new values visible in detail.
- A verified payment-provider callback applied a payment; the actor is the provider/system, not a fabricated employee.

## Existing implementation to reuse

- `src/models/audit-log.model.ts`: audit_log already has id, entityType, entityId, actionType, before/after JSONB, performedBy, performedAt and remarks.
- `src/services/audit.service.ts`: central log writer exists, currently without transaction options, actor snapshots, store scope or field-redaction policy.
- `src/controllers/audit.controller.ts`: GET /audit-logs already requires JWT and audit:read (with super-admin bypass), but currently reads all matching entries without pagination or store scope.
- Separate approval_audit_log, order_status_history, garment_status_history and transfer/delivery custody histories already serve domain-specific timelines.
- Some approval actions and partial-handover updates already write general audit entries. Logging is not yet comprehensive across all admin mutations.

Extend the existing AuditLog table/service/API. Preserve existing domain histories; do not delete them or create a second generic table holding the same events without a defined migration strategy.

### What exists versus what needs extending

| Part | What we have | Required work |
|---|---|---|
| General audit storage | Existing audit_log model and repository. | Extend event metadata, actor handling, scope and indexes; preserve old rows. |
| Central writer | AuditService.log is called by selected approval paths. Some other flows write audit_log directly. | Establish one event contract and transaction-aware writer, sanitize fields, and migrate direct writers to the shared path without duplicate events. |
| Action coverage | Selected general audit entries plus separate domain histories. | Inventory and instrument all agreed successful mutations; no claim of complete current coverage. |
| Read API | Existing GET /audit-logs with entity/action/user filters. | Add authorization scope, bounded pagination, date/reference/module filters, safe projections and event details. |
| Permission checks | Existing endpoint uses audit:read; existing roles/permission framework can control a menu. | Verify permission registration/assignment, add the sidebar/route guard, and enforce record scope on both list and detail APIs. |
| Central admin UI | No central Audit Logs screen was found during this review. | Add the table, filters, states and detail drawer. |
| View Record | Notifications already support pathname navigation. | Introduce/reuse a shared typed entity-navigation resolver; connect audit events to exact records with destination permission checks. |
| Existing record histories | Order, garment, approval and custody histories support their own workflows. | Keep them working; define how the central audit references them and avoids duplicate rows. |
| Historical data | Some old rows have actor/time/references; other actions have no reliable retained event. | Show available history honestly and backfill only verified fields with provenance. |

## Proposed event fields

Keep existing fields and add the minimum metadata needed for reliable filtering, historical interpretation and navigation. New fields should initially be nullable for legacy rows.

| Field | Purpose |
|---|---|
| id | Unique immutable audit event UUID. |
| entityType / entityId | Primary affected record; retain internal ID independently of display numbers. |
| actionType | Stable business action, such as order_created, approval_approved or role_permissions_updated. |
| module | Filterable domain, such as orders, finance, customers, masters or logistics. |
| entityNumber | Historical human-readable ticket/invoice/approval reference, where available. |
| performedBy | Authenticated user UUID for human actors. Allow an explicit system/provider actor design instead of inventing a UUID. |
| actorType | admin, employee, rider, customer, system or provider, as applicable to the event source. |
| actorName / actorRole snapshot | Preserve the displayed actor identity at the time of action, even if later renamed/reassigned. Read access to these snapshots must still be permission-controlled. |
| store scope | Origin store and any genuinely related stores, e.g. transfer destination. Define scope per event; do not blindly use the viewer's selected store or give both stores unrestricted financial details. |
| performedAt | Server-generated timestamp; store consistently and display in the intended local timezone. |
| before / after or field changes | Allowlisted changes needed to explain the action. Avoid full unfiltered entity/request snapshots. |
| remarks / reason | Business reason supplied for approvals, cancellations, overrides and corrections. |
| related references | Related order, approval, invoice, payment, transfer etc. so one action can be traced across records. |
| requestId / correlationId | Group events from the same request/workflow without assuming one request creates only one event. |
| source | admin_panel, rider_api, provider_callback, scheduled_job etc. |
| schemaVersion | Permit controlled evolution of event payloads/rendering. |
| eventKey (where needed) | Stable deduplication key for retried callbacks or commands. Distinct legitimate actions must remain distinct events. |

Prefer typed target/reference metadata for navigation over frontend URLs stored on every event. entityId is currently required UUID; events without a valid business entity need an explicit schema decision, not fake placeholder IDs.

### Migration approach

1. Add metadata columns with backward-compatible nullability for existing rows. New-event validation can require fields appropriate to that event even while legacy rows lack them.
2. Define human versus system/provider actors. The current required performedBy UUID cannot honestly represent a provider without a user account; adjust nullability/validation deliberately and retain actorType/source.
3. Add a primary store snapshot for store-bound events. For events legitimately visible to multiple stores, use a defined scope relationship and field-visibility policy; if a normalized event-store link table is required, add it as scope metadata, not a competing audit-event store.
4. Give global settings/access-management events explicit global scope. A missing legacy store must mean unknown scope, not unrestricted visibility.
5. Add model-declared indexes and an additive migration script. Build large indexes without blocking normal traffic where supported and do not rebuild/drop the existing table.
6. Backfill actor/reference/scope metadata only where existing historical evidence supports it. Leave other values labelled Unknown or Legacy.
7. Verify existing timelines and API consumers before enabling the new screen for staff.

## Recording events reliably

1. Resolve actor identity from validated backend authentication/context, never from an arbitrary performedBy supplied by the UI.
2. For an action performed on behalf of someone else, record both the actual actor and represented customer/user.
3. Capture the relevant before state while applying the domain's existing locking/transaction rules.
4. Apply the business action.
5. Append one canonical successful business event using the same transaction, then commit both together. Rollback must not leave an audit entry falsely stating that an action succeeded.
6. Extend AuditService.log to accept transaction options and a shared typed/sanitized event contract. Keep orchestration in services; repositories remain persistence-only.
7. Where work is inherently asynchronous or spans transactions, use a transactional outbox/event handoff with idempotency rather than an untracked fire-and-forget promise.

Logging a successful financial operation must be part of its durable transaction. Establish and test the failure policy before rollout; do not silently swallow required audit-write failures. Failed attempts cannot be logged inside a transaction that is then rolled back; operational/security attempt logging needs a separate durable policy and must never masquerade as a successful business event.

A generic interceptor can supply request context and technical timings, but HTTP method/URL logging alone cannot explain an approval, a refund or a split. Explicit business events belong at the service/action boundary, covering all entry points without duplicating events in both controllers and services.

## Coverage inventory

Create an action-by-action coverage matrix before implementation. For every action, record its entry points, responsible service, existing history, transaction, required actor, scope, payload policy and verification scenario.

| Domain | Actions to include |
|---|---|
| Orders | Create/draft save/submit, edit, status transition, split, cancel, reprocess, return, sales return, handover and delivery. |
| Finance | Approval request/approve/reject/revert, payment collection/correction, gateway application/reconciliation, refunds, invoice/challan generation and adjustments, credit notes, wallet recharge/debit and cash handovers. |
| Shift/petty cash | Open/close/reopen if supported, cash adjustments, expense submissions and finance resolutions. |
| Logistics | Pickup creation/assignment/reschedule/cancel, delivery assignment/reassignment/return, transfer out/receive/discrepancy resolution, bag/custody changes. |
| Customers/riders/employees | Create/edit/activate/deactivate/delete/link roles and changes to relevant contact/address data. |
| Masters/configuration | Create/edit/delete/status changes, prices, taxes, coupons, store mappings and business settings. |
| Access management | Role/permission grants/removals and employee store/cluster/region assignments. |
| Sensitive reads/exports | Explicitly identify which exports/downloads merit audit events; do not audit every harmless list GET or poll. |

Keep technical exceptions, request-performance telemetry and notification delivery tracking separate from this business audit screen. Link them by request/correlation ID when useful.

## Backend read APIs and authorization

- Extend GET /audit-logs with bounded cursor pagination, date range, module/action, actor, store and entity/reference filters. Sort by performedAt + id for stable navigation.
- Add GET /audit-logs/{id} for a permitted detail view, including sanitized field differences and related references.
- Optionally reuse the existing listing API for a record-specific timeline through entity/related-record filters.
- Use audit:read through existing roles/permissions management. Add audit:export only if export is in scope. Broader cross-store audit visibility should be an explicit grant, not a side effect of opening the screen.
- Apply store/region/cluster scope before pagination, counts and detail retrieval. Global permission checks alone are insufficient. Define visibility for global configuration events separately.
- Receiving an audit event does not grant access to its target. The destination API must independently check its own module permissions and record scope.
- Project lightweight list fields; load before/after data only on detail. Batch actor lookups or use safe snapshots instead of one query per row.
- Add model-declared indexes matching the final queries: performedAt/id, store/date, entity/date and actor/date, as justified by EXPLAIN. Avoid indexing large JSON blobs by default.
- Bound date/search inputs and exports. Do not reproduce whole-history reads, per-row lookups or 20-second full-log polling.

## Admin screen and navigation

Add an Audit Logs navigation item and permission-guarded route using the existing sidebar/role system.

Table columns: date/time, user, module, action, store, reference and short summary. Filters: date range, store, user, module/action and reference, with debounced text search and backend pagination/sorting.

Clicking a row opens audit details: actor, action, reason, changed fields, related records and a View Record action. Keep audit inspection available even when the record has been deleted; show its preserved permitted snapshot/reference and disable unavailable navigation.

Use one shared entity-navigation resolver based on the app's existing paths. It should resolve order/approval/invoice/customer/transfer references and support selection/query parameters for screens without dedicated detail routes. Related entity IDs must open the actual record, not merely a generic module home page. Reuse this resolver with notifications where compatible so URL construction is not duplicated in every writer.

Frontend checks decide whether to show a navigation button; backend checks remain authoritative. No arbitrary external redirect URLs from event payloads.

### Where it appears

- Add a distinct **Audit Logs** sidebar entry with an appropriate icon, using the existing navigation configuration and audit:read permission.
- Proposed route: `/dashboard/system/audit-logs`, exposed through the existing frontend paths helper. Confirm the exact route convention during implementation; it does not exist yet.
- This screen is a history viewer, not a notification inbox: no unread badge or mandatory notification polling.
- An individual ticket/customer/approval page may later offer a filtered Audit History link to this same screen. A second independent logging system is unnecessary.

### Screen structure

```text
Audit Logs                                      Refresh

Date range | Store | User | Module | Action | Reference search

Date/time   User       Module    Action           Store    Reference
10:15 AM    Employee A Orders    Created ticket   Bandra   ST...
10:20 AM    Finance B  Finance   Approved refund  Bandra   AR...
10:25 AM    System     Payments  Applied payment  Bandra   ST...

Previous / Next page                            Page size
```

Each row includes a concise summary such as "Approved INR 250 refund against ticket ST...". The precise display fields depend on the event; unrelated fields should not produce misleading placeholders or invented facts.

Proposed initial behavior:

- Open with a bounded recent date range and the caller's allowed store scope. Last seven days is a proposed default, not a committed business retention policy.
- Debounce free-text reference search using the app's existing pattern. Dropdown/date/page changes request the appropriate server page.
- Use backend sorting, filtering and pagination before returning rows. A cursor-based first version can use Previous/Next and hasMore without an expensive exact count on every request.
- Maintain filters in the URL where useful so a record-specific history link is shareable within the admin panel. URLs must not carry secrets or sensitive snapshots.
- Refresh on opening, user request and appropriate focus/reconnect events. Do not repeatedly download the whole log history in the background.
- Show loading, empty and failed-request states distinctly. Retain previously loaded data with an explicit stale/error indication when a refresh fails.

### Detail drawer

Selecting a row opens a drawer on the same page. It shows:

1. Human-readable action and reference.
2. Actor name/role at the time, source and server timestamp.
3. Store, business reason and relevant amount/status.
4. A changed-fields table with Field / Previous value / New value. For example, approval status Pending -> Approved.
5. Related ticket, approval, payment, invoice or transfer references when present.
6. View Record actions for permitted destinations.

Render field labels and values in a readable form; resolve IDs in batches or from saved snapshots. Mask fields according to permissions. Raw before/after JSON is not the default user-facing view.

For a deleted record, the event remains inspectable using its permitted stored reference/changes. The button shows Record unavailable rather than navigating to an unrelated page. If the user can read the audit but not the target module, omit/disable View Record with a clear explanation.

### Navigation examples

| Event | Primary destination | Related navigation |
|---|---|---|
| Ticket created/edited/delivered | Exact Manage Ticket detail | Relevant invoice/approval if recorded and permitted. |
| Finance approval resolved | Exact approval detail or the correct approval tab with the request selected | Associated ticket/refund/payment. |
| Invoice generated | Exact invoice view/dialog for that invoice | Associated ticket or consolidated order references. |
| Customer edited | Exact customer detail | Filtered customer audit history. |
| Transfer received | Exact transfer detail | Item/custody history where available. |
| Master or role changed | Correct master/detail screen or list with that record selected | Field changes remain available in the audit drawer even if no dedicated detail route exists. |

The resolver must be maintained when new destination types are added. A backend helper cannot infer frontend routing automatically. Keep this mapping in one place rather than copying route strings into every action service.

## Proposed API contract

These names and examples are design proposals, not currently implemented endpoints/contracts.

| API | Purpose | Main rules |
|---|---|---|
| GET /audit-logs | Lightweight, authorized event page. | Date range, module/action, performedBy, store and reference/entity filters; bounded limit and validated cursor. |
| GET /audit-logs/{id} | Drawer details. | Independently authorize the event; return sanitized changes and related references. |
| Existing list filtered by entity | Record-specific timeline/link. | Match primary and agreed related references without widening authorization. |
| Export endpoint, if later required | Download selected permitted history. | Separate permission, bounded/queued export, no full-history browser fetch. Not required for the first release. |

Example first-page response shape:

```json
{
  "rows": [
    {
      "id": "event-uuid",
      "performedAt": "2026-11-02T04:50:00Z",
      "actor": {"type": "employee", "id": "user-uuid", "name": "Finance B"},
      "module": "finance",
      "actionType": "approval_approved",
      "summary": "Approved INR 250 refund against ticket ST...",
      "store": {"id": "store-uuid", "name": "Bandra"},
      "reference": "AR...",
      "target": {"entityType": "approval_request", "entityId": "approval-uuid"}
    }
  ],
  "nextCursor": "opaque-server-cursor",
  "hasMore": true
}
```

The example uses descriptive placeholders, not valid production IDs. Before/after snapshots are omitted from list rows; fetch permitted details only when the drawer opens. Record IDs and summaries are server-derived, not trusted frontend assertions.

## End-to-end example: financial approval

1. A finance employee opens the existing approval screen and approves a request with a reason.
2. The backend authenticates the actor, checks the existing business permission and record/store scope, and locks/revalidates the request.
3. The service applies the approved financial effects using the existing transaction rules.
4. The same transaction writes the canonical audit event with actual actor, approval/order references, amount, old/new status and reason.
5. On commit, the existing approval UI reports success. A rolled-back attempt cannot appear as a successful approval in the business audit.
6. An authorized user opens Audit Logs and filters Finance / Approved / Store / Date.
7. The row opens its drawer; View Record opens that exact approval, and a related link opens the ticket if the user has permission.
8. An automatic approval uses the system actor/source rather than attributing it to an unrelated finance employee.

## Files and layers expected to change

All frontend paths below are proposed locations following the current project organization; verify naming conventions before creating files.

| Repository/layer | Existing or proposed area | Responsibility |
|---|---|---|
| Backend model/repository | Existing src/models/audit-log.model.ts and audit-log repository | Metadata, scope relationships and indexes; repository stays focused on persistence. |
| Backend shared service | Existing src/services/audit.service.ts | Event validation, actor/scope metadata, redaction and transactional append. |
| Backend controllers/read service | Existing src/controllers/audit.controller.ts; dedicated query service if needed | Scoped list/detail queries, pagination, filters and safe projections. |
| Backend business services | Orders, approvals, finance, wallet, logistics, masters and user/role operations | Emit meaningful events at the canonical operation boundary. |
| Backend request context | Existing middleware/interceptor integration | Request/correlation IDs and validated actor/source context; not business-event inference. |
| Backend migration/permissions | Additive migration script and existing permission registration/seeding | Schema/index deployment and audit permission availability. |
| Admin API | Proposed src/api/audit.js | Shared SWR list/detail hooks and endpoint query parameters. |
| Admin screen | Proposed src/sections/audit/ view, toolbar, table row and drawer | Presentation, filters, loading/error states and readable changed fields. |
| Admin navigation | Existing routes/paths, dashboard routes and sidebar configuration | Permission-gated Audit Logs entry and route. |
| Admin record navigation | Shared entity-navigation utility using existing paths | View Record links and compatible reuse by notifications. |
| Tests/docs | Existing test conventions plus audit coverage matrix | Actor, transactions, scope, redaction, pagination, navigation and performance checks. |

No UI logging calls should be added after every Save/Approve button. That would miss callbacks/jobs and allow actions to succeed without reliable audit history if the browser disconnects.

## Data protection, integrity and growth

- Treat the audit store as append-only for application users: no ordinary edit/delete endpoints. Corrections are new events referencing the original.
- Use database privileges/roles to enforce append-only writes where practicable. This is not the same as proving tamper resistance against database administrators; stronger requirements need separate storage/signing controls.
- Explicitly exclude passwords/hashes, access tokens, OTPs, signing secrets, provider credentials and raw sensitive payment payloads. Mask personal data based on approved field policies and reader permissions.
- Preserve server actor/time/source. Use stable IDs and name/reference snapshots so account changes do not rewrite history.
- Decide retention/archive requirements with the business. Measure volume, use relevant indexes and introduce date partitioning only if justified. No production-load values are assumed here.
- Existing rows may lack store/actor snapshots. Backfill only what can be established from reliable historical sources. Mark unknown/migrated provenance; do not infer the creator from today's user or fabricate historical approvers.

## Suggested rollout

1. Inventory existing logs and all mutation entry points. Agree event schema, actor/scope rules, sensitive fields and failure behavior.
2. Extend the existing model/service and migration; harden paginated read APIs and authorization. Add the audit UI with detail/navigation.
3. Cover orders, payments, approvals, invoices, wallet, refunds, sales returns and shifts first.
4. Expand to logistics, customer/rider/employee masters, prices/configuration and role/permission administration.
5. Validate coverage, retries, rollback, navigation, visibility and load. Document historical gaps and deploy with monitoring.

This is one central infrastructure plus explicit instrumentation in each meaningful action. New CRUD modules may share safe common helpers, but new business workflows still need an intentional event definition; no helper can infer every business meaning automatically.

### Deliverables per stage

| Stage | Deliverable | Completion criterion |
|---|---|---|
| 1: Inventory/design | Coverage matrix and agreed schema/field policies. | Every admin mutation is classified; existing versus missing logs are identified. |
| 2: Foundation/UI | Additive model migration, scoped paged APIs, read-only UI and shared navigation. | Permitted users can inspect available events safely, with historical gaps labelled. |
| 3: Financial/order coverage | Instrument critical order/finance operations and alternate entry points. | Transaction/rollback/retry tests prove reliable actor and event recording. |
| 4: Remaining modules | Logistics, masters, configuration and access-management coverage. | Agreed matrix has no uninstrumented in-scope action. |
| 5: Validation/release | Staging smoke/load results, deployment/retention notes and monitored rollout. | No scope leaks, false successful events, duplicate canonical events or unacceptable write/read overhead. |

## Decisions to settle before implementation

- Which roles may read store-level events, global settings events and sensitive financial field changes?
- Which exports/downloads and authentication/security attempts belong in audit scope? General request logging remains separate.
- What history retention/archive period is required, and who may perform controlled archival?
- Which identity fields may be snapshotted/displayed, and which contact/financial values must be masked?
- Which multi-store events are visible to both stores, and what fields can each see?
- Is first-release audit export required, or should it remain a later addition?

Routine UI/file naming and default page-size decisions can be made within the existing project conventions. Do not invent historical facts, retention rules or cross-store financial access to fill missing requirements.

## Acceptance checks

- A successful action and its audit entry commit together; failed/rolled-back work does not appear as successful.
- Retried payment callbacks do not create duplicate financial application or duplicate canonical audit events.
- Every in-scope mutation has coverage, including automatic/alternate entry points.
- Actual actor and any represented customer are both correct; system work is labelled honestly.
- Store/cluster users cannot read another scope's audit data or bypass authorization through View Record.
- Search/page/count operate on authorized matching records; no unbounded history fetches.
- Detail views show useful changes without credentials or prohibited sensitive fields.
- View Record opens the right entity; deleted/unavailable records degrade clearly without losing history.
- Existing order/approval/custody timelines remain correct, and the UI does not display duplicated events from parallel history stores.
- Production-size read/write tests measure audit write overhead, pool use, index growth and list latency before rollout.
