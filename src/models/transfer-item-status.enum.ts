// Only the two moments actually persisted server-side: `scanned` at
// creation, `received`/`missing`/`extra` at receive. The frontend's fuller
// `pending`/`removed` vocabulary describes an in-browser scanning session
// before the final submit — never reaches the backend under atomic
// create-and-send.
export enum TransferItemScanStatus {
  SCANNED = 'scanned',
  RECEIVED = 'received',
  MISSING = 'missing',
  EXTRA = 'extra',
}
