# Completing a partially collected ticket

An existing handover no longer prevents collection when eligible Ready or
Out for Delivery garments remain. The same rule applies to migrated tickets and
future tickets; it is not restricted to a migration remark or a list of IDs.

The existing Collect from Store action records the newly selected collector,
logged-in employee, time and remarks. It updates the current `order_handover`
row in place, retaining its ID and the existing unique index. Obsolete contact,
family, relationship, photo and remark values are cleared when omitted by the
new collection. The previous full snapshot is retained in `audit_log` under
`handover_updated`, with the new snapshot and newly delivered garment IDs.
Previous collection details also appear in the existing ticket activity log.

The order and garment rows are locked before checking current status, readiness,
pending damage approvals and transfer custody. Collector changes, audit, ticket
status, garment statuses and histories use one database transaction. Failure
rolls them back; notifications occur after commit. Already delivered, damaged
and returned garments are not re-delivered. Duplicate completion is rejected.
Unpaid balances and invoice/payment data retain the existing behavior.

Rider recipient capture uses the same transactional completion and updates the
active delivery stop. The controller does not apply the delivered transition
twice. Older rider clients without recipient details keep their existing status
completion path. Optional rider payment recording remains before recipient
completion, as before; it is not part of the handover transaction.

No new tables, schema migration, environment variables or frontend fields are
needed. Restart the backend to load the change. The 458 existing mixed-state
tickets are not updated in bulk: each changes when staff submits its collection.
