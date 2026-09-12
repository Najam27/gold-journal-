/**
 * The legacy localStorage offline queue has been replaced by the durable,
 * local-first journal queue in `client/src/lib/journal`.
 *
 * Only the dialog-to-page cash request event name remains here; the page stores
 * the movement locally and queues it through the journal sync engine.
 */
export const OFFLINE_CASH_REQUEST_EVENT = "gold-journal:queue-cash";
