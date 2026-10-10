# Customer WhatsApp notifications

One singleton WhatsAppService sends approved customer templates through Tata Omni.
The existing Karix payload has been replaced; these are different provider APIs.
Credentials belong only in the ignored backend .env. .env.example contains placeholders.
WHATSAPP_ENABLED=false disables sends. No real messages are sent by validation.

## Event hooks

OrderService.createOrder: pulse_ordercreated, after transaction commit.
OrderService.notifyStatusChange: READY sends pulse_readyforcollection; DELIVERED sends pulse_deliveredcomplete.
Counter handover explicitly selects pulse_collectedcomplete after the handover and garment updates succeed.
OrderService status changes, delivery returns, ProcessService pipeline updates and GarmentController synchronization call that same business-service notification method after their writes succeed.
PaymentService.recordPayment: pulse_paymentreceived after commit, excluding refunds and zero amounts.
Order checkout, wallet payments, subsequent payments and Club & Pay use PaymentService; existing refund writes remain notification-free.
PickupRequestService.createRequest: pulse_pickupreq, excluding cancelled/non-serviceable requests.
Admin, customer-app and rider pickup creation use PickupRequestService.
PickupRequestService.assignRider: pulse_riderscheduled after assignment commit, only for pickups scheduled today in Asia/Kolkata. Repeating the same rider/date/slot does not schedule another notification.
Controllers keep their existing validation and permissions and delegate the shared operations to these services.
Rolled-back transactions never dispatch. Notification failures do not undo business writes.
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
The order-created, payment-received, delivered-complete and collected-complete bodies explicitly promise attachments.
Those four notifications are deliberately skipped until a document URL is available, rather than promising a missing attachment.
The service supports a WhatsApp Cloud-style document header; Tata Omni must confirm this format for the approved templates.
Configure WHATSAPP_TICKET_DOCUMENT_URL_TEMPLATE, WHATSAPP_RECEIPT_DOCUMENT_URL_TEMPLATE and WHATSAPP_INVOICE_DOCUMENT_URL_TEMPLATE only with correct provider-accessible HTTPS PDFs.
Supported placeholders: {orderId}, {paymentId}, {invoiceId}. No authenticated admin JSON endpoint or browser blob URL is a PDF attachment.
Prefer an existing signed short-lived document URL mechanism. This change does not invent a public invoice endpoint or generate PDFs.

Questions for senior/provider:
1. Do pulse_ordercreated, pulse_paymentreceived, pulse_deliveredcomplete and pulse_collectedcomplete have approved DOCUMENT headers?
2. What are their exact language codes and document-header payload requirements? The supplied successful cURL uses en, but a different template.
3. Where are the ticket, per-payment receipt and final invoice PDFs generated, and how can Tata fetch them securely?
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
