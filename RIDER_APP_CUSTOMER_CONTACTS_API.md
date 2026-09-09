# Rider App — Household Contacts & Family Members API

For the rider app team. Covers the "Household"/"Family" options on the
delivery `deliverTo` picker (`RIDER_APP_DELIVERY_API.md` §5) — a rider
needs to see the customer's saved household contacts and family group
members, and add a new one on the spot if the customer wants to name
someone who isn't saved yet. Same underlying data the customer manages
themselves on the customer-web app; this is the rider-scoped view of it.

**Source**: `src/controllers/rider-customer-contacts.controller.ts`
**Auth**: `Authorization: Bearer <rider JWT>`, `rider` role.

List-and-add only — riders can list and create, but can't edit or remove
a customer's saved contacts/family members (only the customer or admin
can). All four endpoints take `customerId` as a path param — the
customer the order/delivery belongs to, not the rider themselves.

---

## Household contacts

### `GET /rider/customers/{customerId}/contacts`

**Response `200`**
```json
{
  "contacts": [
    {
      "id": "255e072b-cbe2-4220-92ac-2765ec856728",
      "customerId": "1a4152f2-f89c-4273-a673-a2c02b4b243a",
      "name": "Daddy",
      "phone": "9876543210",
      "email": null,
      "relationship": "father",
      "isPrimary": false,
      "isActive": true
    }
  ]
}
```

### `POST /rider/customers/{customerId}/contacts`

```json
{
  "name": "Ramesh Kulkarni",
  "phone": "9812345678",
  "relationship": "friend",
  "email": "optional",
  "isPrimary": false
}
```
`name`, `phone`, `relationship` required.

**Response `200`**
```json
{ "message": "Contact added.", "contact": { "id": "uuid", "customerId": "...", "name": "Ramesh Kulkarni", "phone": "9812345678", "relationship": "friend", ... } }
```
The returned `contact.id` is what goes into
`deliverTo.customerContactId` on the `deliver` call (or `handoverBy`'s
household-contact picker on the pickup side) — no need to re-fetch the
list after adding.

---

## Family group members

### `GET /rider/customers/{customerId}/family-members`

**Response `200`**
```json
{
  "members": [
    { "id": "0d3124b6-d672-471d-904e-f183546ec3c7", "groupId": "uuid", "name": "Deepak Yadav", "phone": "9900011122", "relationship": "brother", "isActive": true }
  ]
}
```
`members: []` if the customer has no family group yet (never set one up
on customer-web) — not a `404`. Nothing further to call before the `POST`
below; it creates the group automatically if needed.

### `POST /rider/customers/{customerId}/family-members`

```json
{
  "name": "Anita Sharma",
  "phone": "9911223344",
  "relationship": "sister"
}
```
`name`, `relationship` required, `phone` optional. Creates the customer's
family group on the fly if this is their first-ever member — the rider
never needs to call a separate "create group" endpoint.

**Response `200`**
```json
{ "message": "Family member added.", "member": { "id": "uuid", "groupId": "uuid", "name": "Anita Sharma", "phone": "9911223344", "relationship": "sister", ... } }
```
The returned `member.id` is what goes into `deliverTo.familyGroupMemberId`.

---

## Typical flow — the "Deliver to" picker

1. Rider taps **Household** or **Family** on the deliverTo screen.
2. `GET /rider/customers/{customerId}/contacts` (or `.../family-members`)
   → show the saved list.
3. If the person isn't in the list: `POST` the matching endpoint → use
   the returned id immediately.
4. `POST /rider/deliveries/{id}/orders/{orderId}/deliver` with
   `deliverTo: {"collectorType": "contact", "customerContactId": "<id from step 2 or 3>"}`
   (or `"collectorType": "family_member", "familyGroupMemberId": "<id>"`).

**`relationship`** (`ContactRelationship`, shared across both lists) —
`wife` · `husband` · `son` · `daughter` · `father` · `mother` · `brother` ·
`sister` · `driver` · `colleague` · `friend` · `househelp` · `other`.
