# Monthly ticket numbering

New tickets use `STOREPREFIX-MMYY-SEQUENCE`, for example `DLG11-1126-000001`.
The sequence belongs to a store and calendar month in Asia/Kolkata. Each new
month starts at `000001`, including January and April. Six digits is the minimum
width; larger sequences are not truncated. Existing ticket IDs are unchanged.

Before deploying the backend, run `npm run migrate:ticket-number-sequences`.
The general schema migration also runs this initialization. It creates a monthly
counter table and seeds the current month's highest issued number for each store
prefix, including tickets that have since moved stores. It ignores the previous
all-time store counter. Rerunning cannot lower a monthly counter.

Normal, reprocessing and split tickets use the same allocator. Counter updates
share the order transaction and roll back if order creation fails. Concurrent
requests are serialized by the existing store row lock and atomic counter update.
Future months create their own counters automatically; no monthly job is needed.

Invoice numbering remains separate: its series resets at the April financial-year
boundary rather than every month. No new environment variables are required.
