# System notification enhancement plan

Status: Proposed future work; not implemented.
Recorded: 2 November 2026.

## Goal

Make the admin notification tab, sidebar badge and notification icon responsive while reducing repeated API calls, response sizes and database work across multiple stores.

This plan concerns in-app system notifications. WhatsApp notification delivery is outside its scope.

## Current behavior

- `pressto-admin-panel/src/api/system-notification.js` uses SWR to refresh the current user's notifications every 20 seconds and on window focus.
- Sidebar navigation, the dashboard layout and notification popover consume this hook. Matching SWR keys can share/deduplicate requests within the same browser cache; multiple components do not necessarily produce separate calls.
- Separate browsers and tabs can still create separate polling traffic.
- `pressto_backend/src/controllers/system-notification.controller.ts` serves `/system-notifications` using a notification-list query, unread count and total count. The current-user list has no default pagination limit.
- `src/models/system-notification.model.ts` currently has no declared supporting user/status/date indexes.

Recheck these details against the latest code before implementation.

## Recommended approach

Improve the existing polling implementation first. Add Server-Sent Events (SSE) later if immediate delivery is required. SSE suits this primarily server-to-browser flow; WebSockets are unnecessary unless two-way real-time features are introduced.

### Phase 1: Lightweight polling and paginated history

| Change | Proposed behavior | Benefit |
|---|---|---|
| Lightweight summary | Poll unread count and, if useful, a small latest-notification page. Avoid returning full history or recalculating a total the badge does not need. | Smaller payloads and less repeated work. |
| Backend history pagination | Request bounded pages only when the notification tab/popover opens or the user loads more. Use stable ordering by creation date and ID. Prefer cursor pagination for a changing feed. | Old notification history does not slow every refresh. |
| Supporting indexes | Evaluate user + creation date + ID for lists and user + status for unread counts, accounting for soft-deletion predicates. Declare indexes on the model and provide a migration. Verify query plans before choosing final definitions. | Faster scoped reads and counts. |
| Visibility-aware refresh | Explicitly avoid polling hidden tabs. Refresh/reconcile on return and check SWR's existing visibility behavior before adding duplicate listeners. | Less background traffic. |
| Immediate read-state updates | Update cached rows/badge immediately after read actions, with rollback/revalidation on failure. Reconcile with authoritative backend state. | Smooth UI without waiting for the next polling interval. |
| Controlled failure handling | Keep the last successful data visible; use bounded retry/backoff and avoid aggressive retries during outages. | Clearer behavior and less overload amplification. |
| Shared cache and invalidation | Use consistent keys across badge, icon and tab. Update/revalidate the relevant summary/history caches after mark-read actions. | Consistent counts and fewer duplicate fetches. |

Keep history responses separate from summary polling. Final endpoint names, page sizes, refresh intervals and index definitions should be decided during implementation, not treated as requirements from this document.

### Phase 2: Real-time updates with SSE

1. Persist the notification in PostgreSQL; keep the database as the source of truth.
2. Publish an event only after the business transaction commits successfully.
3. Deliver the event to the appropriate authenticated user's SSE connection.
4. Update or invalidate the shared frontend notification cache. Event payloads can be minimal; the UI can fetch authoritative data when needed.
5. On reconnect, reconcile unread count and the latest page so missed events do not leave the UI stale.
6. Retain slower polling as a fallback and ensure reconnects do not cause request bursts.

#### Multiple PM2 workers

The backend now supports multiple PM2 workers. An in-memory event emitter inside one worker cannot deliver events to connections owned by another worker.

Use shared event distribution, such as Redis Pub/Sub, between workers. Redis Pub/Sub alone is not durable: disconnected clients must reconcile against persisted notifications. If durable publication/replay is required, evaluate a transactional outbox and a durable event stream.

#### Connection and authorization details

- Authenticate the stream and scope all events to the correct user and permitted store context.
- Native browser `EventSource` does not directly support custom Authorization headers. The existing Bearer-token authentication needs an explicit design, such as an authenticated fetch-based SSE client or an appropriate secure cookie/session mechanism. Do not expose the normal access token in a URL.
- Close/recreate connections correctly on logout, user change, expired authentication and role/scope changes.
- Configure proxy buffering, idle timeouts, heartbeat messages and graceful worker restarts for long-lived streams.
- Deduplicate event IDs and read-state updates. Redis/SSE failures must not roll back an already-created order or notification.
- Consider cross-tab connection sharing later only if measured connection volume justifies it.

## Validation before release

- Unread counts stay consistent across the icon, sidebar badge and notification tab.
- Mark-one and mark-all actions update immediately; failed actions recover correctly.
- Large histories use bounded responses and indexed queries.
- Multiple active stores/users cannot receive each other's events or notification data.
- Hidden tabs, reconnects and network failures do not create request storms.
- Multi-worker tests confirm that an event created on one worker reaches a client connected to another.
- Restarting a worker or losing an event does not lose persisted notification history; reconciliation restores the correct count.
- Measure requests per active session, payload sizes, query count/time, pool waits, connection count and CPU/memory before and after the change.

## Implementation boundaries

- No application behavior, API contract, database schema or environment configuration was changed by creating this plan.
- Start with Phase 1 and measure the improvement before introducing Redis/SSE infrastructure.
- Existing WhatsApp services remain separate from this work.
