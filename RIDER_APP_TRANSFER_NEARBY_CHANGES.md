# Rider App API Changes: Transfers & Nearby Stores

2026-11-11

Three rider APIs change. Transfer cards now carry both stores' map coordinates and where they came from, the rider confirms the item count when handing a transfer over, and a new search lists stores near a PIN code. The existing in-transit call is unchanged, so current app versions keep working.

## At a glance

| # | API | What changed | App work |
| --- | --- | --- | --- |
| 1 | `GET /rider/transfers` | `fromStore` and `toStore` now carry `pincode`, `latitude`, `longitude` and `coordinateSource`. Transfers also carry the delivery fields, and `tab=completed` now includes `delivered`. | Update the store and transfer models. Show approximate pins, and hide navigation when a store has no location. |
| 2 | `PATCH /rider/transfers/{transferId}/status` | New `status: "delivered"` with `deliveredItemCount`, plus `discrepancyReason` when the count differs. The `in_transit` request is unchanged. | Add the handover step: count entry, the reason prompt on a mismatch, then the result. |
| 3 | `GET /rider/stores/nearby?pincode=400001` | New endpoint. | Add a PIN code store search with distances, an empty state and error states. |

All three use the rider's existing login token (`Authorization: Bearer <token>`). Any other account gets HTTP 403.

## 1. Transfer list: GET /rider/transfers

Every transfer now has `fromStore` and `toStore` objects carrying the store's map location and where it came from. Use them for map pins and the navigate button. The request is unchanged (`?tab=pending`, `?tab=completed` or `?status=`).

| Field | Type | Meaning |
| --- | --- | --- |
| `fromStore`, `toStore` | object, always present | Origin and destination store |
| `.id` | string (uuid) | Store id |
| `.name` | string or null | Store name. Null only if the store was deleted. |
| `.pincode` | string or null | Store PIN code |
| `.latitude`, `.longitude` | number or null | Map location. Both are set or both are null. |
| `.coordinateSource` | `"store"`, `"pincode"` or null | `store`: the store's saved location (exact). `pincode`: the centre of the store's PIN code area (approximate). null: no location available. |

```json
{
  "transfers": [
    {
      "id": "8f1c2a7e-4b1d-4c5e-9a3f-2d6b7e8f9a01",
      "transitId": "TR-ANW-BAN-1111-3",
      "status": "in_transit",
      "itemCount": 10,
      "bagNumbers": [101, 102],
      "fromStore": {
        "id": "0b7d4c1e-2f3a-4b5c-8d9e-1a2b3c4d5e6f",
        "name": "Andheri West",
        "pincode": "400053",
        "latitude": 19.1364,
        "longitude": 72.8296,
        "coordinateSource": "store"
      },
      "toStore": {
        "id": "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
        "name": "Bandra",
        "pincode": "400050",
        "latitude": 19.0596,
        "longitude": 72.8295,
        "coordinateSource": "pincode"
      },
      "deliveredAt": null,
      "deliveredItemCount": null,
      "deliveryCountStatus": null,
      "deliveryDiscrepancyReason": null,
      "deliveryCountReviewRequired": false
    }
  ]
}
```

The sample is trimmed. Every other transfer field is unchanged.

**How to implement**

1. Make every location field nullable in the Dart store model, and parse `latitude`/`longitude` as `num`, then `toDouble()`.
2. `coordinateSource: "store"`: normal pin and navigation.
3. `coordinateSource: "pincode"`: show the pin with an "Approximate location" label. Navigation goes to the PIN code area, not the shop door.
4. `coordinateSource: null`: no pin. Disable navigation and show the store name and PIN code instead. Treat any unknown value the same way.
5. Add `delivered` to the transfer status enum, with a safe fallback for unknown values. `tab=completed` now returns `delivered` transfers alongside `received`, `discrepancy` and `resolved`.
6. Add the new nullable transfer fields: `dispatchedItemCount`, `deliveredAt`, `deliveredByRiderId`, `deliveredItemCount`, `deliveryCountStatus` (`matched`, `short` or `excess`), `deliveryDiscrepancyReason` and `deliveryCountReviewRequired`. They stay null (the flag false) until the transfer is marked delivered.
7. The detail call `GET /rider/transfers/{id}` returns the same `fromStore`/`toStore` objects, with the same PIN code fallback, so one store model serves both screens.

## 2. Mark delivered: PATCH /rider/transfers/{transferId}/status

When the rider hands the bags over at the destination store, the app sends `status: "delivered"` with the number of individual items handed over. The server compares it with the dispatched count and answers `matched`, `short` or `excess`. `{transferId}` accepts the transfer `id` (uuid) or its `transitId`.

The `in_transit` call does not change: `{"status": "in_transit", "bagIds": [...]}`, with optional `itemCount`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `"delivered"` | Yes | The transfer must be `in_transit`. |
| `deliveredItemCount` | integer, 0 to 2147483647 | Yes | Total individual items (garments) handed over, across all bags of the transfer. |
| `discrepancyReason` | string or null | Only when the count differs | Why the count differs. Blank, spaces or `null` count as missing. |

Matched count (10 dispatched, 10 handed over):

```json
{ "status": "delivered", "deliveredItemCount": 10 }
```

Mismatch (10 dispatched, 8 handed over), sent with a reason:

```json
{ "status": "delivered", "deliveredItemCount": 8, "discrepancyReason": "Two shirts left at the origin store" }
```

HTTP 200 for both. A matched delivery returns `difference: 0`, `countVerificationStatus: "matched"`, `discrepancyReason: null` and `storeReviewRequired: false`.

```json
{
  "message": "Transfer delivered with an item count mismatch — flagged for store review.",
  "transferId": "8f1c2a7e-4b1d-4c5e-9a3f-2d6b7e8f9a01",
  "transitId": "TR-ANW-BAN-1111-3",
  "status": "delivered",
  "deliveredAt": "2026-11-11T09:42:10.123Z",
  "expectedItemCount": 10,
  "deliveredItemCount": 8,
  "difference": -2,
  "countVerificationStatus": "short",
  "discrepancyReason": "Two shirts left at the origin store",
  "storeReviewRequired": true
}
```

HTTP 422 when the count differs and no reason was sent. The status stays `in_transit` and nothing is saved. `details` carries the comparison for the reason prompt:

```json
{
  "error": {
    "statusCode": 422,
    "name": "UnprocessableEntityError",
    "message": "Item count is short: 8 handed over, 10 dispatched. Provide discrepancyReason to complete the delivery.",
    "code": "DISCREPANCY_REASON_REQUIRED",
    "details": { "expectedItemCount": 10, "deliveredItemCount": 8, "difference": -2, "countVerificationStatus": "short" }
  }
}
```

`difference` is `deliveredItemCount - expectedItemCount`: negative means `short`, positive means `excess`.

Optional fields (`discrepancyReason`, `bagIds`, `itemCount`) may be sent as `null`.

**How to implement**

1. Ask for the count as a whole number, 0 or more. Don't pre-fill or show the expected count first: the server owns it and returns it in the response.
2. Send `delivered` with the count only.
3. On 422 `DISCREPANCY_REASON_REQUIRED`, show `details` (expected, handed over, difference) and ask for a reason. Resend with a reason. The rider may recount and send a corrected count instead, because nothing was saved.
4. On a timeout or network error, resend the identical body. An identical retry returns the same 200 response, so the handover is never recorded twice. Don't change the count or reason after a 200.
5. On 200, show the result. Matched means done. Short or excess means delivered and flagged for store review. Then refresh the list: the transfer moves to the Completed tab.
6. The store then receives the transfer as usual. Inventory corrections stay with the store's reconciliation, not the app.

## Delivery handover flow

The handover is saved only when the count matches or a reason is sent.

```
Rider counts items ──► Send delivered ──► Count matches? ──yes──► 200 matched (saved, leg complete)
                          ▲                    │ no
                          │                    ▼
                resend with a reason      Reason sent? ──yes──► 200 flagged (saved, store reviews)
                          │                    │ no
                          └──── 422 ask reason ◄┘   (nothing saved)
```

A timeout or network error is not a separate path: resend the identical body and the server returns the same 200. A 409 means the transfer changed elsewhere, so refresh it (see Errors).

## 3. Nearby stores: GET /rider/stores/nearby?pincode=400001

This new call returns active stores within the server's search radius (15 km today) of a PIN code, nearest first, with straight-line distances. Stores in other PIN codes are included. Stores with no known location are left out.

| Parameter | Rule |
| --- | --- |
| `pincode` (query, required) | Six digits, not starting with 0. Validate in the app with `^[1-9][0-9]{5}$` before calling. |

```json
{
  "pincode": "400001",
  "radiusKm": 15,
  "stores": [
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "name": "Fort",
      "pincode": "400001",
      "latitude": 18.9388,
      "longitude": 72.8354,
      "coordinateSource": "store",
      "distanceKm": 0.42
    },
    {
      "id": "f6e5d4c3-b2a1-4f0e-9d8c-7b6a5f4e3d2c",
      "name": "Worli",
      "pincode": "400018",
      "latitude": 19.0176,
      "longitude": 72.8172,
      "coordinateSource": "pincode",
      "distanceKm": 8.97
    }
  ]
}
```

**How to implement**

1. Show `distanceKm` as straight-line distance ("8.97 km away"), not road distance. It is rounded to 2 decimals.
2. Label the list from `radiusKm` ("Stores within 15 km of 400001"). Never hardcode 15: the radius is a server setting and can change.
3. Treat `coordinateSource` as in section 1: `pincode` means an approximate pin. Every listed store has coordinates.
4. `stores: []` with HTTP 200 is a normal result. Show an empty state such as "No stores within 15 km of 400001".
5. HTTP 400 `INVALID_PINCODE`: show it inline. App-side validation should prevent it.
6. HTTP 422 `PINCODE_NOT_FOUND`: the format is valid, but the PIN code doesn't exist. Ask the rider to check it.
7. HTTP 503: the PIN code lookup is temporarily down. Show "Try again" with a retry button; the server keeps answering 503 for up to a minute after an outage. This response has no `code`, so branch on the HTTP status.

## Errors

Branch on the HTTP status and `error.code`, and show `error.message` only as a fallback. Every error has the same shape: `{"error": {"statusCode", "name", "message", "code"?, "details"?}}`. `code` and `details` appear only on the 4xx responses listed here. 5xx responses carry only `statusCode`, `name` and `message`.

| HTTP | `code` | API | When | App action |
| --- | --- | --- | --- | --- |
| 400 | `INVALID_DELIVERED_ITEM_COUNT` | Mark delivered | Count missing, negative, a decimal, a string or above 2147483647 | Fix the input. App validation should prevent this. |
| 400 | none | Mark delivered | Transfer is not `in_transit` yet (for example `rider_assigned`) | Refresh the transfer. Start transit first. |
| 403 | none | Transfer calls | Transfer is assigned to another rider, or the account isn't an active rider | Refresh the list. |
| 404 | none | Transfer calls | No transfer with that id or `transitId` | Refresh the list. |
| 409 | `DISPATCH_BASELINE_UNAVAILABLE` | Mark delivered | The server can't work out the dispatched count. Status unchanged. | Tell the rider to contact the store. Don't auto-retry. |
| 409 | `TRANSFER_ALREADY_DELIVERED` | Mark delivered | Already recorded with a different count or reason. `details` holds what was recorded. | Show the recorded values and refresh. |
| 409 | `TRANSFER_ALREADY_RECEIVED` | Mark delivered | The store already received this transfer | Refresh. Nothing left to do. |
| 409 | `TRANSFER_STATUS_CHANGED` | Mark delivered | The status changed while the request was running | Refresh, then retry if still `in_transit`. |
| 422 | `DISCREPANCY_REASON_REQUIRED` | Mark delivered | Count differs and no reason was sent. `details` holds the comparison. | Ask for a reason and resend. |
| 422 | `VALIDATION_FAILED` | Status calls | Malformed body: unknown `status`, `bagIds` missing on `in_transit`, `discrepancyReason` not a string | App bug. Log it. |
| 400 | `INVALID_PINCODE` | Nearby stores | Missing, not six digits, or starts with 0 | Inline validation message |
| 422 | `PINCODE_NOT_FOUND` | Nearby stores | Valid format, unknown PIN code | "PIN code not found" |
| 503 | none | Nearby stores | PIN code lookup temporarily unavailable | "Try again" with retry |

## Rollout and checklist

No forced update is needed. The backend ships first, and app versions already in the field keep working:

- The `in_transit` call is unchanged.
- Older apps never send `delivered`. The store can still receive a transfer straight from `in_transit`, so the handover step is optional until every rider updates.
- New response fields are additions. Check that the Dart models ignore unknown keys and don't fail on extra fields.
- A `delivered` status appears only on transfers marked delivered by an updated app.

App tasks:

- [ ] Store model: nullable `pincode`, `latitude`, `longitude` and `coordinateSource` on `fromStore`/`toStore`
- [ ] Transfer status enum: add `delivered`, with a safe fallback for unknown values
- [ ] Transfer model: the new nullable delivery fields from section 1
- [ ] Map: exact pin for `store`, labelled approximate pin for `pincode`, no pin and no navigation for null
- [ ] Handover screen: whole-number count entry, then the `delivered` call
- [ ] Reason prompt on 422 `DISCREPANCY_REASON_REQUIRED`, using `details`
- [ ] Retry with the identical body on network failure, and handle each 409 `code`
- [ ] Nearby store search: PIN validation, list with `distanceKm`, radius label from `radiusKm`, empty state, and 400/422/503 handling
- [ ] QA: matched, short and excess counts; missing reason; a repeated request; nearby search with results, empty, invalid PIN, unknown PIN and lookup down
