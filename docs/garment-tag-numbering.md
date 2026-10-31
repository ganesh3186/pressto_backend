# Garment tag numbering

All three creation paths use `OrderService.getNextGarmentTag`: store drop-off,
delayed/inspection creation and manual garment registration. Tags use the global
PostgreSQL sequence `public.garment_tag_seq`, with eight-digit minimum padding
(`GT10758174`). They never reset with ticket months or invoice financial years.

Before restarting the updated backend, run:

```sh
npm run migrate:garment-tags
```

The normal `npm run migrate` also runs this initializer. It reads the highest
numeric `GT` tag across all garments, including deleted ones, rather than their
row count. Existing tags and garment/handover data are not rewritten. Empty
databases start at `GT00000001`; rerunning never lowers the sequence. The actual
starting value is calculated from the target database, not a hardcoded example.

Run this command again after historical garment imports and before accepting new
garment creation. Pause old application versions and imports during cutover; all
application instances must use the new allocator. New allocators take a shared
transaction advisory lock, while synchronization takes its exclusive equivalent,
preventing synchronization from racing with new allocations. Independent import
tools do not participate in that lock and must finish before synchronization.

`nextval` remains unique under concurrent requests. Aborted transactions consume
numbers, so gaps are expected. The sequence persists across restarts, and a rerun
preserves values consumed by failed transactions. There are no new dependencies,
environment variables, or LoopBack models: this is a PostgreSQL sequence object.
