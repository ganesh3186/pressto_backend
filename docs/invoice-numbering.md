# Invoice numbers

New invoices use `STOREPREFIX-MMYY-SEQUENCE`, for example `DLG11-1026-069943`.
The sequence has a minimum width of six digits and grows beyond that width.
Dates follow Asia/Kolkata. Each store has an independent invoice sequence for
the financial year beginning April 1. January changes the printed year but
continues the same financial-year counter. April starts a new counter at 1.
Ticket counters are independent.

## Deployment

Run `npm run migrate:invoice-number-sequences` before restarting the updated
backend. This creates and initializes `invoice_number_sequence`; the general
`npm run migrate` also calls this initializer. No new environment variables are
needed. Re-running the initializer never lowers an allocated counter.

Initialization reads existing invoices in the current financial year. Imported
numbers such as `ST008/069942` map through the store code, while new-format
numbers map through the store prefix. Previous `INV-YYYYMM-NNNNN` numbers map
through their ticket's store. Existing invoices are never renumbered.

Manual, automatic, gateway-payment and consolidated invoice generation share
the allocator. Allocation joins the invoice transaction, so a failed creation
rolls back its counter increment. Concurrent requests serialize through the
store/year counter row. A configured store prefix is required. Consolidated
invoices retain their existing representative ticket and use that ticket's
store prefix and counter.
