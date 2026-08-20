// A customer's pre-declared preference for how a multi-item pickup should
// eventually be delivered — pure metadata for the store exec who builds
// the real order later; nothing downstream reads/enforces it yet.
export enum DeliveryGroupingPreference {
  TOGETHER = 'together',
  AS_READY = 'as_ready',
}
