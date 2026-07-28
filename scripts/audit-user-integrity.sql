-- ============================================================================
-- User/Employee/Customer identity integrity audit
-- ============================================================================
-- READ-ONLY. Nothing here writes to the database. Run each query separately
-- (e.g. in psql or a DB GUI) and review the output before deciding what to
-- fix manually — this script does not touch data because the right fix for
-- each row depends on judgment calls (which account is the "real" one, which
-- role was intended, etc.) that shouldn't be automated blindly.
--
-- Context: employees and customers are separate profile tables that both
-- point at a shared "users" table via a "userId" foreign key. A bug allowed
-- POST /employees to silently attach an employee profile to ANY existing
-- user matched by phone or email — including the super admin — and separately,
-- PATCH /employees/{id} and PATCH /customers/{id} let roleValues include
-- 'super_admin' with no guard. Both are now fixed in code; this script finds
-- rows already affected before the fix shipped.
--
-- Column names are quoted camelCase throughout (e.g. "isDeleted", "userId")
-- because this schema has no snake_case naming convention — LoopBack's
-- Postgres connector created columns using the exact property names from the
-- model classes, which Postgres then requires double-quotes to address.
-- ============================================================================


-- 1) How many super_admin accounts exist right now?
-- Expect exactly 1 row. More than 1 means extra super admins were created
-- through employee/customer role edits and need to be manually demoted.
SELECT u.id, u."fullName", u.email, u.phone, u."isActive", u."createdAt"
FROM users u
JOIN user_roles ur ON ur."usersId" = u.id AND ur."isDeleted" = false
JOIN roles r ON r.id = ur."rolesId"
WHERE r.value = 'super_admin'
ORDER BY u."createdAt" ASC;


-- 2) Users that are BOTH an employee AND a customer (same login, two profiles).
-- This is the exact shape of the incident: a phone/email match caused an
-- employee profile to be silently attached to someone else's existing login.
-- Review each row — if the two profiles clearly belong to different real
-- people, that user's account needs to be split (new user row for one of them).
SELECT
  u.id              AS user_id,
  u."fullName",
  u.email,
  u.phone,
  e.id              AS employee_id,
  e."employeeCode",
  e."firstName"     AS employee_first_name,
  e."lastName"      AS employee_last_name,
  c.id              AS customer_id,
  c."customerCode",
  c."firstName"     AS customer_first_name,
  c."lastName"      AS customer_last_name
FROM users u
JOIN employee e ON e."userId" = u.id AND e."isDeleted" = false
JOIN customer c ON c."userId" = u.id AND c."isDeleted" = false;


-- 3) THE critical one: any user who is an employee (or customer) AND also
-- currently holds the super_admin role. If this returns any row, that
-- person's Employee/Customer profile is sitting on top of the real super
-- admin account (or a super admin role got attached to a regular employee).
-- Do NOT edit that employee/customer's role in the admin panel until this is
-- resolved — before the fix, saving any role change there would have wiped
-- out the super_admin role via a delete-all-then-recreate.
SELECT
  u.id AS user_id, u."fullName", u.email, u.phone,
  e.id AS employee_id, e."employeeCode",
  c.id AS customer_id, c."customerCode"
FROM users u
JOIN user_roles ur ON ur."usersId" = u.id AND ur."isDeleted" = false
JOIN roles r ON r.id = ur."rolesId" AND r.value = 'super_admin'
LEFT JOIN employee e ON e."userId" = u.id AND e."isDeleted" = false
LEFT JOIN customer c ON c."userId" = u.id AND c."isDeleted" = false
WHERE e.id IS NOT NULL OR c.id IS NOT NULL;


-- 4) Duplicate phone numbers across users (should be impossible per the model,
-- but the unique index may not actually be applied to a table that pre-dated
-- it — see note at the bottom of this file).
SELECT phone, COUNT(*) AS accounts, array_agg(id) AS user_ids, array_agg("fullName") AS names
FROM users
WHERE "isDeleted" = false
GROUP BY phone
HAVING COUNT(*) > 1;


-- 5) Duplicate emails across users (same caveat as #4).
SELECT email, COUNT(*) AS accounts, array_agg(id) AS user_ids, array_agg("fullName") AS names
FROM users
WHERE "isDeleted" = false AND email IS NOT NULL
GROUP BY email
HAVING COUNT(*) > 1;


-- 6) Any user holding more than one role at once. Not necessarily wrong (an
-- employee legitimately holding two operational roles is fine), but worth a
-- glance if you weren't expecting multi-role accounts.
SELECT u.id, u."fullName", u.email, array_agg(r.value) AS roles
FROM users u
JOIN user_roles ur ON ur."usersId" = u.id AND ur."isDeleted" = false
JOIN roles r ON r.id = ur."rolesId"
GROUP BY u.id, u."fullName", u.email
HAVING COUNT(*) > 1;


-- ============================================================================
-- Note on the unique index gap
-- ============================================================================
-- The Users model declares unique indexes on username/email/phone, but this
-- project runs migrations with `migrate` (alter mode, see src/migrate.ts).
-- LoopBack's Postgres connector does not reliably add a *new* unique index to
-- an *existing* table in alter mode, especially if the table already has data
-- (and it will flatly refuse if that data already contains duplicates). If
-- query #4 or #5 above returns nothing, the index may still be missing —
-- confirm with:
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'users' AND (indexname ILIKE '%phone%' OR indexname ILIKE '%email%');
--
-- If the unique indexes aren't listed, they need to be added by hand
-- (CREATE UNIQUE INDEX ... ON users (phone) / (email)) *after* queries #4/#5
-- come back empty — a unique index cannot be created while duplicates exist.
-- ============================================================================
