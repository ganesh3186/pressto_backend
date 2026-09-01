# Rider API Changes — Latest

Changes for the rider app: optional photos on a pickup's actual-service
remark, a mandatory bag-scan gate before starting transit on an interstore
transfer, one exclusive bag per service on pickup confirmation, and a
QR/code-scan confirm for rider-to-rider cash handover. §5 is not a change
— it's the pre-existing "handover orders" flow, included as a reference
since it's the same code/QR pattern as the cash-handover change in §4.

---

## 1. Optional photos alongside a pickup's actual-service remark

```
PATCH /rider/pickup-requests/{id}/status
```

When confirming pickup (`status: "picked_up"`), each line in
`itemsByService[]` now accepts an optional `mediaIds` array alongside the
existing `remarks`:

```json
{
  "status": "picked_up",
  "itemsByService": [
    {
      "serviceId": "c84dfe93-f45f-48bc-86d3-4710264eb200",
      "quantity": 3,
      "deliverySpeed": "express",
      "remarks": "2 shirts have a small stain near the collar",
      "mediaIds": ["7c2b...", "9f1a..."],
      "bagId": "a1b2..."
    },
    { "serviceId": "00354f2b-363f-4a8f-9e68-44cab7256c3a", "quantity": 1, "bagId": "e5f6..." }
  ]
}
```
(`bagId` here moved off the top level and into each line — see §3 below,
a later change than this one.)

**How to send photos:** upload each one first via the existing
`POST /files` endpoint (multipart), which returns:

```json
{ "files": [{ "id": "7c2b...", "fileUrl": "...", "fileName": "..." }] }
```

Collect the `id`s and pass them as `mediaIds` for that line — don't
upload after confirming pickup, upload first.

`mediaIds` is optional and independent per line, same as `remarks`.
Stored in `PickupRequest.actualItemsByService[].mediaIds`. These photos
now show up on the admin panel's Receive Items screen as a small
thumbnail next to that service's remark.

Docs updated: `RIDER_PICKUP_API.md`.

---

## 2. Every transfer bag must be scanned before starting transit

```
GET /rider/transfers/{id}
```

Response now also includes `bags` — the full checklist of bags in this
transfer, with real bag numbers to scan against:

```json
{
  "transfer": { "...": "..." },
  "items": [ "...": "..." ],
  "bags": [
    { "id": "uuid-of-bag-1", "bagNumber": 1042 },
    { "id": "uuid-of-bag-2", "bagNumber": 1043 }
  ]
}
```

Match each physical scan locally against this list and collect the
matching `id`s — no separate per-scan API call needed.

```
PATCH /rider/transfers/{id}/status
```

Marking a transfer in transit now **requires** `bagIds`, covering every
bag from the list above:

```json
{ "status": "in_transit", "bagIds": ["uuid-of-bag-1", "uuid-of-bag-2"] }
```

If any bag hasn't been scanned, the call is rejected — no partial or
force option:

```json
400 { "error": { "message": "Scan every bag in this transfer before starting transit — still missing: 1042, 1043." } }
```

Everything else about this endpoint is unchanged: only riders assigned
to the transfer can call it, and the transfer must currently be
`rider_assigned`.

Docs updated: `RIDER_APP_TRANSFER_API.md`.

---

## 3. One exclusive bag per service on pickup confirmation

```
PATCH /rider/pickup-requests/{id}/status
```

Bag was previously one per whole pickup (a single top-level `bagId`,
shared across every service). Now **each service scans and sends its own
bag** — `bagId` moved off the top level and into every `itemsByService[]`
line, where it's **required**:

```json
{
  "status": "picked_up",
  "itemsByService": [
    { "serviceId": "c84dfe93-f45f-48bc-86d3-4710264eb200", "quantity": 3, "deliverySpeed": "express", "bagId": "a1b2..." },
    { "serviceId": "00354f2b-363f-4a8f-9e68-44cab7256c3a", "quantity": 1, "deliverySpeed": "standard", "bagId": "e5f6..." }
  ]
}
```

Rules, enforced server-side:
- Every line must have a `bagId` — `400` if any line is missing one.
- No two lines may share a bag — `400` if the same `bagId` appears on
  more than one line ("The same bag was scanned for more than one
  service — each service needs its own bag.").
- Each `bagId` still comes from `GET /rider/bags/lookup?q=<bag number or
  uuid>` — scan a **separate** physical bag for each service before
  sending this.

`PickupRequest.bagId` (top level) still exists but is now just a
first/primary-bag snapshot for back-compat display — the real, per-service
breakdown is `actualItemsByService[].bagId`. Nothing else about this
endpoint changed (`deliverySpeed`/`remarks`/`mediaIds` per line all work
exactly as in §1).

Docs updated: `RIDER_PICKUP_API.md`.

---

## 4. QR/code-scan confirm for rider-to-rider cash handover

Cash handover already let a rider hand a batch to a store or to another
rider/van, with a 6-digit `handoverCode` generated for exactly this
purpose — but the rider-to-rider confirm only worked by tapping an item
already sitting in your own incoming list (`{id}`-based). The code itself
was never actually usable for a cold QR scan. Now it is, matching how
pickup handover already works:

```
POST /rider/cash-handovers/confirm
{ "code": "482913" }
```

Same effect as the existing `POST /rider/cash-handovers/{id}/confirm` —
reassigns every underlying `PaymentTransaction` in the batch to you and
marks the batch confirmed — but resolves the batch **by its
`handoverCode`** instead of an `id`, so you can scan the sender's QR cold,
without the batch needing to already be visible in your
`GET /rider/cash-handovers/incoming` list first.

Use whichever fits the flow:
- Already looking at your incoming list → tap it → `POST
  /rider/cash-handovers/{id}/confirm` (unchanged, still works).
- Scanning the sender's QR cold → `POST /rider/cash-handovers/confirm`
  with the scanned `code` (new).

Same `403` ("This handover was not directed to you.") / `400` (already
confirmed) behavior on both routes; the new one also returns `404` if no
pending batch matches the code.

Docs updated: `RIDER_APP_CASH_HANDOVER_API.md`.

---

## 5. Handover orders — already built, unchanged (included for reference)

Not a change in this batch — nothing here was touched. Included so
whoever's integrating §3 above has the whole "handover a batch, get a
code, receiver scans it" picture in one place, since it's the exact same
pattern applied to picked-up garments instead of cash.

A rider batches several of their own `picked_up` pickup requests, picks
who it's going to, and submits:

```
GET /rider/pickup-requests/handover-eligible
```
Your own `picked_up` pickups not already sitting in a pending batch.

```
POST /rider/pickup-handovers
{ "pickupRequestIds": ["..."], "handoverToType": "store", "handoverToStoreId": "..." }
```
or `"handoverToType": "rider"` + `"handoverToRiderId"` for a rider/van
target (covers both "Rider" and "Van" in the app UI — same field,
distinguished by that rider's own `riderType`). Returns a `handoverCode` —
show it as text + QR.

```
GET /rider/pickup-handovers/incoming?tab=pending|completed
```
Batches directed at you by another rider (only ever non-empty for a
rider/van target — a store-targeted batch is received by store staff on
the admin panel instead).

```
POST /rider/pickup-handovers/confirm
{ "code": "954229" }
```
Scan the sender's QR (or type the code manually) — resolves the batch by
code, no id needed up front. Confirming reassigns each pickup to you
(`assignedRiderId`); it immediately reappears in your own
`handover-eligible` list above, ready to be handed off again.

Full reference (incl. store-side receive, and the separate "raise to
support" escalation flow in the same doc): `RIDER_APP_PICKUP_HANDOVER_API.md`.
