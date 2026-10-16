# Customer WhatsApp notifications

One singleton WhatsAppService sends approved customer templates through Tata Omni.
The existing Karix payload has been replaced; these are different provider APIs.
Credentials belong only in the ignored backend .env. .env.example contains placeholders.
WHATSAPP_ENABLED=false disables sends. No real messages are sent by validation.

## Current rollout: notifications without attachments

WHATSAPP_ATTACHMENTS_ENABLED defaults to false. These approved templates send in this mode:
- pulse_pickupreq: after a customer pickup request is saved successfully.
- pulse_riderscheduled: after rider assignment commits, when the pickup date is today in Asia/Kolkata.
- pulse_readyforcollection: after an order successfully changes to READY.
- pulse_ordercreated: after a new order commits. Six body parameters: customer name, ticket number, items, amount, expected delivery date, ticket-summary HTTPS PDF URL.
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
Parameter 6 is the raw complete URL, not an HTML anchor or Markdown link. Clickability is handled by WhatsApp, and localhost URLs may remain plain text. A localhost link also cannot open this computer from a customer's phone. Use a public HTTPS backend address for customer use. A dedicated View Ticket button requires an approved URL button in the provider template; do not add an unapproved button to the current payload.
OrderSummaryPdfService generates a backend PDF from the existing order-detail read service and its saved financial totals, after the order commits and a customer WhatsApp recipient is found. It saves a unique PDF under the configured STORAGE_DIRECTORY/order-summaries (by default .sandbox/order-summaries), then supplies a signed HTTPS link as parameter 6. No Media rows, challan/PDF relations or UI changes are introduced. The admin panel keeps its existing receipt rendering.
At startup the backend creates order-summaries, payment-receipts and invoices under STORAGE_DIRECTORY. Only order-summaries has a generator and signed download endpoint in this rollout; the other folders remain empty. General /files routes retain their existing behavior; folder restrictions are deferred. These routes can access generated PDFs by filename without enforcing signed-link expiry.
Configure PUBLIC_DOCUMENT_BASE_URL with the backend base, including any proxy prefix. For development it is http://localhost:3040: HTTP loopback addresses are permitted only outside NODE_ENV=production, for opening PDFs on the same computer. Customers cannot open localhost links on their phones. Change this setting to the externally reachable HTTPS backend address when deploying; production rejects localhost. It falls back to API_ENDPOINT when unset. This setting must point to this deployment, not an arbitrary PDF or storage site. The old WHATSAPP_TICKET_DOCUMENT_URL_TEMPLATE setting is no longer used.
Configure ORDER_SUMMARY_URL_SIGNING_SECRET with a unique random secret of at least 32 bytes. Use the same stable secret on every instance and deployment; rotating it invalidates existing links. ORDER_SUMMARY_LINK_TTL_SECONDS defaults to 604800 (7 days), accepts 60 through 31536000 seconds, and controls link expiry. The signed link grants access to that one document without an admin login, so treat it as confidential.
GET /documents/order-summaries/{fileName}?expires=...&signature=... validates the filename, signature and expiry before reading the PDF. Invalid links return 403, expired links 410, and missing files 404. Responses are application/pdf with private/no-store caching.
Missing/invalid configuration or generation/send failures skip the notification and log a generic error without rolling back the saved order. There is no automatic retry worker; an explicit service retry may generate another unique file. No placeholder or null URL is sent. WHATSAPP_ENABLED=false skips both PDF generation and messaging for this flow.
Mount STORAGE_DIRECTORY on persistent storage. Multiple backend instances must share that storage and signing secret so a customer request can reach any instance. Files remain until operational cleanup; do not remove a file while its link is still needed. Local .sandbox files are not database backups and must survive redeployments.
WHATSAPP_ATTACHMENTS_ENABLED=false does not block this text template. WHATSAPP_ENABLED=false still blocks all WhatsApp API calls.

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
3. Where should per-payment receipt and final invoice PDFs be generated, and how can Tata fetch them securely? Ticket summaries are now generated by the backend; deployment must provide public HTTPS routing and persistent storage.
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
