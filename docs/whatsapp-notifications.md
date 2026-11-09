# Customer WhatsApp notifications

## V2 update of existing flows 26 October 2026

This section is the current contract. The previous rollout notes below are retained as historical reference and are superseded where they differ.

Existing transaction owners and event hooks remain in place; repositories still only persist data. No new sending endpoint or frontend send button is added by this update.

| Event | V2 template | Body parameters in order |
| --- | --- | --- |
| Ticket created | pulse_order_created_221026 | First name, store name, ticket number, item count, due date |
| Whole counter-collection order ready | pulse_ready_for_collection_automatic_221026 | First name, item count, ticket number, store name, amount payable |
| Payment recorded against a generated invoice | pulse_payment_received_manual_221026 | First name, amount without a currency prefix (template supplies it), ticket number, mode, invoice number |
| Counter collection completed | pulse_delivery_to_customer_complete_221026 | First name, ticket number, collector name, actual date/time, store name |
| Pickup rider scheduled for today | pulse_rider_scheduled_221026 | First name, rider name, rider's primary phone, slot start-end |
| Rider delivery completed | pulse_delivery_by_rider_complete_221026 | First name, ticket number, delivering user/rider name, collector name, actual date/time, support phone |
| Wallet credited | pulse_wallet_recharge_221026 | First name, actual credited amount, transaction ID, balance |
| Wallet used for a ticket | pulse_wallet_redeem_221026 | First name, redeemed amount, ticket number, balance |
| Order payment link shared | pulse_paymentlink_221026 | First name, ticket number, amount, saved gateway URL, saved link expiry |
| Customer or rider login code requested | pulse_login_otp_221026 | Six-digit OTP, repeated in the Copy code button |
| Rider confirms pickup | pulse_rider_pickup_done_221026 | First name, rider name, pickup reference, confirmed item count |
| Paid ticket assigned for home delivery | pulse_ready_to_deliver_with_rider_details_221026 | First name, ticket number, rider name, delivery date and slot; invoice PDF header |
| Unpaid ticket assigned for home delivery | pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026 | First name, ticket number, rider name, delivery date and slot, outstanding amount, real gateway URL; invoice PDF header, or challan PDF when no invoice exists |
| Customer-actionable garment approval raised | pulse_cust_approval_221026 | First name, ticket number, item name, reason, additional charge or None |

The document lists pulse_ticket_created_221026, but Tata rejected that name with HTTP 400, "Template Not Found". At the user's request, the implementation uses pulse_order_created_221026, which Tata accepted with HTTP 200 using the same body and public sample PDF. Acceptance does not confirm delivery. There is no automatic template-name fallback.

The visible wallet-redemption body contains four placeholders and a fixed support number. The user confirmed that this body is authoritative, so this implementation sends four parameters and disregards the contradictory fifth variable-list entry.

Static MyAccount URL buttons and footers are configured on the approved provider template. These static buttons do not require extra body variables or invented runtime button parameters.

### Documents and flags

WHATSAPP_ENABLED=false blocks every notification send, PDF generation and notification-data preparation. Login codes are the one exception, and still go out. No credentials or flags in the actual .env are changed by this update.

WHATSAPP_ATTACHMENTS_ENABLED=true is now required for both ticket creation and payment confirmation. Ticket creation reuses OrderSummaryPdfService and sends its PDF URL as the document header, not as a body link. Its existing signed download route, storage and signing settings remain unchanged.

Payment confirmation requires an existing invoice and its actual invoice number. The shared OrderSummaryPdfService now generates an 80 mm TAX INVOICE PDF using the frontend thermal-receipt invoice format: company/store header, invoice and ticket metadata, customer, item/service/charge rows, returns, saved totals, taxes, payment/refund status and footer. It stores a unique file under STORAGE_DIRECTORY/invoices and attaches its signed HTTP/HTTPS URL. The PDF renderer does not mark the invoice printed or create an invoice record. Consolidated invoices resolve all linked tickets and include their items with ticket identifiers while retaining the persisted consolidated invoice totals. The payment business flow now automatically creates a regular invoice once confirmed payments fully cover the ticket, even before Ready, as explicitly requested. Partial payments without an existing invoice still skip the invoice-based notification; no deferred notification worker is added.

### Automatic invoices after full payment

OrderService owns the shared manual and automatic invoice record creation. Checkout and addPayment perform the fully-paid check inside their payment transaction, then dispatch notifications only after commit. Automatic creation ignores processing stage, but excludes Draft, Cancelled, Returned and On Account tickets; zero-value tickets without an actual received payment do not create an automatic invoice. Confirmed cheque/PDC approval, wallet amounts and split allocations use the existing backend balance calculation. Pending cheque/PDC promises do not count as received money. Historical paid tickets are not batch-backfilled by deployment.

The manual Generate Invoice API retains its Ready-or-later rule for a new manual invoice, and reuses an existing automatic invoice. Existing invoice payment balances are refreshed rather than issuing another invoice. Saved order totals/taxes are authoritative, including existing extras and discounts. Callbacks without an operator use the real saved challan issuer for generatedBy. Order row locks protect against duplicate invoice creation and stale concurrent payments. Regular and consolidated invoice creation share transaction-scoped invoice-number allocation; consolidated On Account billing otherwise retains its existing behavior. No new environment variable or schema migration is introduced.

Razorpay checkout verification now checks the payment signature, then fetches the provider's captured payment and verifies its ID, order ID, amount and INR currency. Signed webhook processing validates captured payment fields and, for payment_link.paid, the link's paid status and amount_paid against the saved link, before recording money. Gateway link row locks serialize repeat confirmations; order payments also deduplicate by gateway transaction reference. A payment_link.paid event for a partial ticket balance never substitutes for checking the whole ticket balance. Verification/status responses expose amountPaid, paymentApplied and, for ticket payments, totalCollected, balanceDue, invoiceId and invoiceNumber. An HTTP webhook acknowledgement is not a browser payment-success callback.

If Razorpay received funds but applying them to the ticket failed, the gateway record retains paid plus applicationError and paymentApplied is false. The UI shows a reconciliation message instead of success, and another gateway checkout/link for that ticket is blocked until the existing received payment is reconciled. A repeated valid confirmation can retry that failed application; successfully applied callbacks do not collect twice. The existing payment/invoice refresh handles counter payments; the open invoice dialog also revalidates order/invoice data every five seconds for asynchronous shared-link payments, and uses the persisted invoice to switch Generate Invoice to Invoice. It does not print automatically.

WHATSAPP_RECEIPT_DOCUMENT_URL_TEMPLATE and WHATSAPP_INVOICE_DOCUMENT_URL_TEMPLATE are no longer used. The invoice URL is generated by the backend from PUBLIC_DOCUMENT_BASE_URL (or API_ENDPOINT). It reuses ORDER_SUMMARY_URL_SIGNING_SECRET and ORDER_SUMMARY_LINK_TTL_SECONDS. GET /documents/invoices/{fileName}?expires=...&signature=... validates the signature/expiry before serving application/pdf. Invoice signatures use a different scope from ticket-summary signatures, so the links cannot be swapped between folders. Existing ticket-summary links remain compatible. Document URLs support HTTP and HTTPS to retain the existing deployment requirement. The provider must be able to fetch the PDF; localhost, private or authenticated-only links cannot serve a customer's attachment. URLs with embedded credentials or non-HTTP(S) schemes are rejected. Keep the existing shared storage and signing secret persistent across deployments/instances. General /files behavior remains unchanged, as previously requested.

Counter-collection and rider-delivery completion are now text-only and do not depend on WHATSAPP_ATTACHMENTS_ENABLED. They require the saved handover recipient and actual timestamp. Missing handover details skip the message rather than inventing a collector or using the retry time as the completion time. WHATSAPP_SUPPORT_PHONE defaults to 1800229199 for the rider-completion support parameter.

### Scope and retained behavior

- Ready-for-collection uses the existing full-order READY event, only for orders collected at the counter. A paid order supplies Nil, already paid. Home-delivery assignment uses the separate templates described below.
- The manual/partial-ready split-order template is intentionally excluded.
- Pickup assignment remains today-only in Asia/Kolkata and uses saved slot start/end times. It now looks up the assigned rider's primary user phone. Missing slot times/contact skip the message with a generic diagnostic.
- The existing pulse_pickupreq request-created confirmation is retained; v2 does not list a replacement for that event. It is distinct from the rider-pickup-completed message.
- Existing cancelled/draft, guest/WhatsApp-preference, order-only wallet-redemption and duplicate-suppression rules remain in force. Split/rework creation does not send another ticket-created message.
- Wallet amounts come from the successful business credit/debit; this update does not add a bonus scheme. Payment-link expiry comes from the original saved link, including when that link is reused.
- The manual/partial-ready split-order template remains intentionally excluded; the other v2 flows are implemented, with live provider approval/delivery verification still required.

### Remaining v2 flow integration

Rider pickup completion sends pulse_rider_pickup_done_221026 after the picked_up transaction commits. The shared PickupRequestService owns notification dispatch; rider confirmation and the admin status-update path call it after successful persistence. The message requires saved actualItemsByService with positive finite quantities, sums those real counts and never uses itemCountEstimate. It requires a saved customer with an active WhatsApp phone and the assigned rider name. Booking, rider assignment, unsuccessful pickup and return-to-store do not trigger pickup completion.

POST /orders/delivery-assignment dispatches through OrderService only after committing the Delivery run, its stops and any bag updates. WhatsAppService resolves persisted pending stops and checks the order still matches the run's rider, date, slot and home-delivery method. Both variants require WHATSAPP_ATTACHMENTS_ENABLED=true and a provider-accessible PDF URL. The paid variant requires an existing invoice. At the user's revised request, the unpaid payment-link variant again includes a document header: use its invoice when available, otherwise generate a CHALLAN PDF from the saved active numbered challan. The six text parameters remain unchanged; no PDF/body parameter or null header is added. Order creation normally creates that challan automatically. If neither document exists, or PDF preparation fails, skip the notification before creating a payment link. The shared 80mm renderer labels challans with their saved number/date and current order details/estimated totals, stores them under order-summaries and uses the existing signed summary download route. It does not create invoice/challan records, mark them printed or change UI printing. The invoice and ticket-summary rendering modes remain intact. Tata's template retains its document header; its static wording should cover the challan fallback rather than promise only an invoice. Slot IDs resolve to start/end times; legacy text slots retain their saved text, with the delivery date included. Already cancelled/completed runs, completed stops, stale assignments, missing recipient/schedule and disabled notifications are skipped.

The outstanding amount comes from OrderService.computeBalanceDue, including existing split allocations. Paid tickets receive the four-parameter invoice-only template. Unpaid tickets call the existing RazorpayService.createPaymentLink to create or reuse a valid link for the outstanding amount and receive the six-parameter template with the invoice/challan attachment. This does not call createAndSendPaymentLink, so it does not also send the separate payment-link notification. Gateway writes and PDF generation occur only after the assignment commits; failures skip that customer's notification without reverting assignment. No mock link or paid-template fallback is sent when gateway creation fails. A real link requires the existing Razorpay credentials/webhook setup; resolved staging DNS and publicly reachable PDF URLs remain required. Duplicate suppression is per run/order within the running process, as with existing notifications; no durable retry/outbox is added.

ApprovalService dispatches pulse_cust_approval_221026 after createRequest completes its required writes and garment hold. It reuses CUSTOMER_ACTIONS_BY_TYPE so internal approvals are not sent to customers. The persisted request must remain pending, garment-scoped and on hold; the order/customer/item/reason must be resolvable. Upgrade requests reuse getUpgradeView's pricing.difference (the same quote as the customer screen); positive differences are the additional charge, otherwise None. Process-at-risk has no additional charge. Existing item snapshots are preferred over catalog names. The static MyAccount button stays in the approved provider template. This integration does not change how customers respond to or resolve approvals, or add frontend screens, database columns, environment variables, services or repository-side business logic.

### Customer and rider login OTP

POST /auth/customer/send-otp and POST /auth/rider/send-otp retain their existing phone/countryCode request and account checks. Both now delegate to the existing OtpService: generate a cryptographically random six-digit code, save only its bcrypt hash in users.loginOtp and its ten-minute expiry in users.loginOtpExpires, then await the shared Tata transport. The approved pulse_login_otp_221026 authentication template receives the same code in its body and Copy code button (URL subtype, index 0). It has no attachment and does not depend on WHATSAPP_ATTACHMENTS_ENABLED.

Login codes go to the resolved user's login phone and country code, rather than an alternate number or customer notification contact. This is a user-requested login challenge for customers and riders, separate from customer notification preferences. Whatever WHATSAPP_ENABLED is set to, the send response is {message: "Login code requested on WhatsApp", expiresInSeconds: 600}, with no plaintext otp. Provider rejection, timeout or missing credentials returns HTTP 503; failures do not fall back to returning the code. Provider acceptance still does not confirm delivery. Only the hash and ten-minute expiry are saved in the database, and the verify-otp endpoints and login responses are unchanged. No SMS fallback, database migration, new service, PDF configuration or frontend admin change is added. Verify the template's approval, language and Copy code button in Tata before rollout.

## Previous rollout reference

One singleton WhatsAppService sends approved customer templates through Tata Omni.
The existing Karix payload has been replaced; these are different provider APIs.
Credentials belong only in the ignored backend .env. .env.example contains placeholders.
WHATSAPP_ENABLED=false disables notification sends; login codes still go out. No real messages are sent by validation.

`WHATSAPP_DELIVERY_PAYMENT_LINK_ENABLED=false` temporarily skips only
`pulse_ready_to_deliver_with_rider_details_with_paymentlink_221026` for unpaid
delivery assignments, before generating its PDF or creating/reusing a gateway link.
It also blocks direct sends of that template. The paid rider-details template and
the separately shared `pulse_paymentlink_221026` message remain unaffected, subject
to their existing global/attachment settings. `true` or an unset variable preserves
the existing behavior. Restart the backend after changing this flag.

## Current rollout: notifications without attachments

WHATSAPP_ATTACHMENTS_ENABLED defaults to false. These approved templates send in this mode:
- pulse_pickupreq: after a customer pickup request is saved successfully.
- pulse_riderscheduled: after rider assignment commits, when the pickup date is today in Asia/Kolkata.
- pulse_readyforcollection: after an order successfully changes to READY.
- pulse_ordercreated: after a new order commits. Six body parameters: customer name, ticket number, items, amount, expected delivery date, ticket-summary HTTP or HTTPS PDF URL.
- pulse_walletrecharge: after an admin recharge or a confirmed customer/gateway recharge succeeds. Parameters: customer name, recharge amount, date, available balance.
- pulse_walletredeem: after wallet payment for a ticket commits, including checkout and later payments. Parameters: customer name, ticket number, amount redeemed, date, available balance.
- pulse_paymentlink: after an order payment link is created/reused. Parameters: customer name, ticket number, requested payment amount, real Razorpay HTTPS payment URL.

All seven use body parameters only; no document/header component is sent.
The rider-scheduled time-slot parameter uses the referenced PickupDeliverySlot startTime and endTime (for example, 14:00 - 15:00), rather than its label. Legacy requests without an available slot/time range show Not specified and log a generic warning.
Existing admin/customer/rider entry points use the business services described below.
No new public message-sending endpoint is introduced; existing business APIs trigger the notifications.
The three attachment-based templates are skipped before loading their customer/document data, even if PDF URLs are configured.
Direct sendTemplateMessage calls also enforce this restriction. Text-only templates reject unexpected media.
Set WHATSAPP_ENABLED=true with a valid token to enable these notifications, then restart the backend.
HTTP acceptance does not confirm delivery; confirm on the receiving phone or through provider delivery status.

## Order-created PDF link

pulse_ordercreated now uses the confirmed six-parameter text template. Its sixth parameter contains the complete PDF URL; no media field, document header or null attachment is sent.
The backend PDF follows the frontend thermal-receipt.js ticket format: 80 mm paper with 6 mm side insets, company/store/GST header, ticket metadata, customer details, Description/HSN/Qty/Pending Qty/Rate/Amount columns, garment service/charge rows, estimated totals, payment information and receipt footer. It uses saved order financial totals and reads customer addresses, primary phone, wallet balance and brand/color names on the backend. It does not call frontend APIs or change frontend printing. Company values and the shared SAC currently mirror receipt-config.js; keep them aligned if that configuration changes.
Parameter 6 is the raw complete URL, not an HTML anchor or Markdown link. Clickability is handled by WhatsApp, and localhost URLs may remain plain text. A localhost link also cannot open this computer from a customer's phone. Use a publicly reachable HTTP or HTTPS backend address for customer use. A dedicated View Ticket button requires an approved URL button in the provider template; do not add an unapproved button to the current payload.
OrderSummaryPdfService generates a backend PDF from the existing order-detail read service and its saved financial totals, after the order commits and a customer WhatsApp recipient is found. It saves a unique PDF under the configured STORAGE_DIRECTORY/order-summaries (by default .sandbox/order-summaries), then supplies a signed HTTP or HTTPS link as parameter 6. No Media rows, challan/PDF relations or UI changes are introduced. The admin panel keeps its existing receipt rendering.
At startup the backend creates order-summaries, payment-receipts and invoices under STORAGE_DIRECTORY. Only order-summaries has a generator and signed download endpoint in this rollout; the other folders remain empty. General /files routes retain their existing behavior; folder restrictions are deferred. These routes can access generated PDFs by filename without enforcing signed-link expiry.
Configure PUBLIC_DOCUMENT_BASE_URL with the backend base, including any proxy prefix. Both HTTP and HTTPS are accepted in development and production. For local testing it is http://localhost:3040, for opening PDFs on the same computer; customers cannot open localhost links on their phones. Use the externally reachable backend address when deploying. It falls back to API_ENDPOINT when unset. Credentials, query strings, fragments and non-HTTP(S) schemes are rejected. This setting must point to this deployment, not an arbitrary PDF or storage site. The old WHATSAPP_TICKET_DOCUMENT_URL_TEMPLATE setting is no longer used.
Configure ORDER_SUMMARY_URL_SIGNING_SECRET with a unique random secret of at least 32 bytes. Use the same stable secret on every instance and deployment; rotating it invalidates existing links. ORDER_SUMMARY_LINK_TTL_SECONDS defaults to 604800 (7 days), accepts 60 through 31536000 seconds, and controls link expiry. The signed link grants access to that one document without an admin login, so treat it as confidential.
GET /documents/order-summaries/{fileName}?expires=...&signature=... validates the filename, signature and expiry before reading the PDF. Invalid links return 403, expired links 410, and missing files 404. Responses are application/pdf with private/no-store caching.
Missing/invalid configuration or generation/send failures skip the notification and log a generic error without rolling back the saved order. There is no automatic retry worker; an explicit service retry may generate another unique file. No placeholder or null URL is sent. WHATSAPP_ENABLED=false skips both PDF generation and messaging for this flow.
Mount STORAGE_DIRECTORY on persistent storage. Multiple backend instances must share that storage and signing secret so a customer request can reach any instance. Files remain until operational cleanup; do not remove a file while its link is still needed. Local .sandbox files are not database backups and must survive redeployments.
WHATSAPP_ATTACHMENTS_ENABLED=false does not block this text template. WHATSAPP_ENABLED=false still blocks this template.

## Wallet and PG-link behavior

Wallet recharge notifications run after the recharge has actually credited the wallet, not when a pending gateway recharge is initiated.
Wallet redemption notifications run explicitly after the order/payment transaction commits. Rollbacks and insufficient-balance failures do not notify.
Manual admin debit corrections have no ticket reference and are excluded because the approved redemption wording says the money was used for an order. Refund credits are not presented as recharges.
Amounts and the remaining wallet balance are captured by the business operation; the message does not recompute an order wallet deduction from later transactions.
The existing POST /payments/gateway-links/shareable endpoint now creates/reuses the real link and sends pulse_paymentlink from the backend. It requires the existing order:create permission and store visibility, matching ticket payment access.
The response retains link fields and adds whatsappAccepted and message. The new-ticket PG Link, invoice PG Link and invoice balance-link button stay in the admin screen and use this result for success/error feedback.
The selected customer must have an active saved WhatsApp number. Recipients are resolved from the ticket/customer records, not an arbitrary phone sent by the browser.
If WhatsApp fails, the ticket/link is retained. Retrying uses the existing valid Razorpay link rather than creating another charge. Payment is still applied only through the existing verified Razorpay confirmation flow.
Concurrent sends for the same event share the same pending request and result; successful sends are suppressed within this running instance. A provider-accepted result is not proof of delivery.
The separate frontend-only Club & Pay/draft sharing helpers are not gateway-backed and are outside this PG Link payment-method change.

## Event hooks

OrderService.createOrder: pulse_ordercreated, after transaction commit.
OrderService.notifyStatusChange: READY sends pulse_readyforcollection; DELIVERED sends pulse_deliveredcomplete.
Counter handover explicitly selects pulse_collectedcomplete after the handover and garment updates succeed.
OrderService status changes, delivery returns, ProcessService pipeline updates and GarmentController synchronization call that same business-service notification method after their writes succeed.
PaymentService.recordPayment persists the payment. The transaction owner explicitly calls PaymentService.notifyPaymentReceived after commit to send pulse_paymentreceived, excluding refunds and zero amounts.
Order checkout, wallet payments, subsequent payments and Club & Pay use PaymentService; existing refund writes remain notification-free.
PickupRequestService.createRequest: pulse_pickupreq, excluding cancelled/non-serviceable requests.
Admin, customer-app and rider pickup creation use PickupRequestService.
PickupRequestService.assignRiders owns the batch assignment transaction and dispatches pulse_riderscheduled after commit, only for pickups scheduled today in Asia/Kolkata. Repeating the same rider/date/slot does not schedule another notification.
Controllers keep their existing validation and permissions and delegate the shared operations to these services.
Rolled-back transactions never dispatch. Notification failures do not undo business writes.
Post-commit calls are explicit. PostgreSQL's transaction class comes from a different installed loopback-connector instance than the juggler observer implementation; it does not support the observe('after commit') hook. No transaction monkey-patching or observer hooks are used.
Repositories contain no WhatsApp dependencies or notification overrides. Direct repository writes, imports, raw SQL and replaceById do not send messages automatically.
New business flows must explicitly use the relevant service operation; adding a database write alone does not opt it into customer messaging.

## Recipients and template values

Only active, non-deleted customer_phone records marked isWhatsappNumber are used.
Prefer the primary flagged number. Never substitute a rider, employee, family contact or pickup handover phone.
Guest pickups with no customer ID/WhatsApp preference are skipped.
Numbers are normalized to international format. Approved template names and placeholder counts are validated.
Ticket balances follow split allocation and existing non-refund payment accounting.
New split/rework orders do not send a second order-created template.

## Attachments: confirmation required from senior/provider

The provided documents list template bodies, but do not provide approved header metadata or PDF endpoints.
The payment-received, delivered-complete and collected-complete bodies still explicitly promise attachments.
Those three notifications are deliberately disabled for the current rollout. Enabling them later requires WHATSAPP_ATTACHMENTS_ENABLED=true and a valid document URL, rather than promising a missing attachment.
The service supports a WhatsApp Cloud-style document header; Tata Omni must confirm this format for the approved templates.
Configure WHATSAPP_RECEIPT_DOCUMENT_URL_TEMPLATE and WHATSAPP_INVOICE_DOCUMENT_URL_TEMPLATE only with correct provider-accessible HTTPS PDFs. Order-created summaries use their own backend generator and signed body link.
Supported placeholders: {orderId}, {paymentId}, {invoiceId}. No authenticated admin JSON endpoint or browser blob URL is a PDF attachment.
No payment-receipt or invoice PDF generator/download endpoint is implemented by this rollout.

Questions for senior/provider:
1. Do pulse_paymentreceived, pulse_deliveredcomplete and pulse_collectedcomplete have approved DOCUMENT headers?
2. What are their exact language codes and document-header payload requirements? The supplied successful cURL uses en, but a different template.
3. Where should per-payment receipt and final invoice PDFs be generated, and how can Tata fetch them securely? Ticket summaries are now generated by the backend; deployment must provide publicly reachable routing and persistent storage.
4. For future-dated rider assignments, should a scheduled worker send on pickup day, or should a date-neutral template be approved? The approved text says today.
5. What is the preferred policy for guest customers and customers without a designated WhatsApp number?
6. Is durable delivery tracking/retry required? If so, add a transactional outbox and verified provider webhook contract.

## Acceptance, duplicate protection and operational limits

A 2xx response with an id records provider acceptance, not WhatsApp delivery.
No automatic HTTP retries: ambiguous timeouts can already have been accepted by the provider.
Bounded in-memory duplicate protection covers simultaneous/repeated events within one running instance (24 hours).
It is not a persistent outbox, is not shared across multiple instances, and does not guarantee exactly-once delivery.
Failures can be attempted again when the event is triggered again; there is no automatic recovery worker in this change.
Neither bearer tokens, customer phones, message bodies nor provider error bodies are logged.
Missing attachment/template configuration is reported without customer data.
