# Rider App — Pickup Handover & Escalation Integration Guide

For the rider app team. Covers two flows: "Handover orders" (garments a
rider has picked up, handed off to a store/rider/van) and "Raise to
support" (a pickup-side issue report). All in
`rider-pickup-handover.controller.ts` (rider) and
`pickup-handover.controller.ts` (admin, store-side receive) for the first;
the escalation endpoints live in `rider-pickup.controller.ts` (rider) and
`pickup-escalation.controller.ts` (admin).

**Auth**: same as the rest of the rider app — `Authorization: Bearer <jwt>`
with the `rider` role.

---

## 1. Handover orders — overview

Structurally the garment-side twin of the cash-handover flow
(`RIDER_APP_CASH_HANDOVER_API.md`): a rider batches several of their own
**picked-up** pickup requests, picks who it's going to, and submits them.
The one real difference: **confirmation is QR/code-based, not
tap-to-confirm** — the app shows a 6-digit `handoverCode` as text and
encodes it into a QR; the receiver resolves by that code, not by browsing
a list and tapping an id, since they may not have anything on hand until
they scan.

| App UI option | `handoverToType` | Target id field |
|---|---|---|
| Washing facility | `store` | `handoverToStoreId` |
| Rider | `rider` | `handoverToRiderId` (rider whose `riderType` is `rider`) |
| Van | `rider` | `handoverToRiderId` (rider whose `riderType` is `van-rider`) |

---

## 2. Eligible pickups

```
GET /rider/pickup-requests/handover-eligible
```
The rider's own `picked_up` pickup requests **not already sitting in a
pending handover batch**. Once a pickup is included in a submitted batch,
it drops off this list until/unless that batch is never confirmed (there's
no expiry — if you need to undo one, that's a support-side manual fix for
now, same posture as cash handover).

**Response `200`**: `{ "pickupRequests": [ /* same shape as GET /rider/pickup-requests */ ] }`

---

## 3. Submit a handover batch

```
POST /rider/pickup-handovers
```
```json
{
  "pickupRequestIds": ["uuid-from-handover-eligible", "..."],
  "handoverToType": "store",
  "handoverToStoreId": "uuid-of-target-store"
}
```
or for a rider/van target:
```json
{
  "pickupRequestIds": ["uuid-from-handover-eligible", "..."],
  "handoverToType": "rider",
  "handoverToRiderId": "uuid-of-target-rider"
}
```
`400` if any id isn't yours, isn't `picked_up`, or is already in a pending
batch. `400` on `handoverToRiderId === your own id`.

**Response `200`**
```json
{
  "message": "Pickup handover submitted.",
  "handover": {
    "id": "uuid",
    "handoverNumber": "PH-RID001-2208-3",
    "handoverCode": "954229",
    "status": "pending",
    "riderId": "uuid",
    "riderName": "Rohan Sharma",
    "riderCode": "RID001",
    "itemCount": 2,
    "handoverToType": "store",
    "handoverToStoreId": "uuid",
    "handoverToName": "Andheri Store",
    "submittedAt": "2026-08-23T10:05:00.000Z"
  }
}
```
Show `handoverCode` as text and as a QR (encode the same string) on the
"Please show this code to receiver" screen.

---

## 4. Your own batch history

```
GET /rider/pickup-handovers?status=<optional>
```
Same shape as §3's response, one entry per batch, each with its `items`
(`pickupRequestId`, `pickupNumber`, `customerName`) attached.

---

## 5. Receiving a batch handed to YOU by another rider

Only relevant if this rider is ever picked as a "Rider"/"Van" target.
A store-targeted batch is received by store staff on the admin panel
instead — it never appears here.

```
GET /rider/pickup-handovers/incoming?tab=pending|completed
```
Same tab shape as every other rider list in this app.

```
POST /rider/pickup-handovers/confirm
```
```json
{"code": "954229"}
```
Whatever value the scanner reads off the sender's QR (or whatever the
receiver types in manually) — same field either way. `403` if the code
resolves to a batch not directed at you. `400` if already confirmed.

**Response `200`**: `{ "message": "Pickup handover confirmed received." }`

**Not a final settlement** — confirming reassigns each linked pickup
request to *you* (`assignedRiderId`/`assignedRiderName`); its `status`
stays `picked_up`, unchanged. They immediately reappear in your own §2
`handover-eligible` list, ready to be handed off again.

---

## 6. Store-side receive (admin panel, for reference)

```
GET /pickup-handovers/lookup?code=954229
```
Resolves a scanned/entered code to the batch + its items, **read-only** —
lets the store preview before receiving. `400` if the code belongs to a
rider-targeted batch (must be confirmed by that rider, not here).

```
POST /pickup-handovers/{id}/confirm
```
Uses the `id` from the lookup response. Moves every linked pickup request
to `received_at_store` and releases its bag, exactly like the rider's own
`received_at_store` self-report — this is just the store-verified version
of the same transition. `400` on a rider-targeted batch, or one already
confirmed.

---

## 7. Raise to support (pickup escalation)

A side-channel issue report against one of the rider's own pickups —
filing one does **not** block, cancel, or change that pickup's own
status/transitions, it's purely a queue for the support team.

```
POST /rider/pickup-requests/{id}/escalations
```
```json
{
  "reason": "Customer not reachable",
  "remark": "Called twice, no answer",
  "mediaIds": ["uuid-of-uploaded-photo"]
}
```
`reason` is required (free text — not a fixed enum, so the app's dropdown
values are yours to define/change without a backend change). `remark` and
`mediaIds` are optional. `403` if the pickup isn't assigned to you.

**Response `200`**: `{ "message": "Escalation raised.", "escalation": {...} }`

```
GET /rider/pickup-requests/{id}/escalations
```
The escalations *you* raised for this specific pickup.

**Admin side** (for reference — support triage queue):
`GET /pickup-escalations?status=open|resolved` to list,
`PATCH /pickup-escalations/{id}/resolve` (optional `{"resolutionRemark": "..."}`
body) to close one out.

---

## Typical flow, end to end

**Handing garments to a store:**
1. `GET /rider/pickup-requests/handover-eligible` → pick which picked-up requests to batch.
2. `POST /rider/pickup-handovers` with `handoverToType: "store"` → show the returned `handoverCode` as text + QR.
3. Store staff scan/enter it on the admin panel (§6) — nothing further for the rider app to do.

**Handing garments to another rider/van:**
1. Same §2 → §3, with `handoverToType: "rider"`.
2. The **receiving** rider scans/enters the code via §5's confirm — the batch then shows up in their own `handover-eligible` list, carried forward from there.

**Filing an issue mid-pickup:** `POST /rider/pickup-requests/{id}/escalations` any time — doesn't interrupt the pickup's own flow.
