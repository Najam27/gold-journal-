/**
 * Controlled cleanup of the REMOVED local-first journal store.
 *
 * Gold Journal used to keep a durable local copy of the journal — an IndexedDB
 * snapshot per account plus a durable queue of pending trade mutations — and it
 * replayed that queue into the backend later. Trades could therefore accumulate
 * in the browser while cloud synchronisation failed, and a refresh could show
 * trades that the database had never accepted.
 *
 * Trade persistence is now direct: the dialog calls `trades.create/update/delete`
 * and the Trade Log reads `trades.list`, so the database is the only source of
 * truth. The IndexedDB store is no longer read or written by any code path, and
 * this module removes it so a pre-existing local copy can never be resurrected
 * or mistaken for persisted data.
 *
 * Deliberate constraints:
 *   - it only touches the legacy journal database, never AI settings, UI
 *     preferences, the theme, or any other legitimate local storage;
 *   - it never uploads anything: old local trades are NOT pushed to the backend,
 *     because the database already holds every trade it accepted and re-uploading
 *     a local snapshot would create duplicates;
 *   - it is best effort and can never block or fail the app.
 */

/** The database name the removed local-first journal layer created. */
export const LEGACY_JOURNAL_DB_NAME = "gold-journal";

/** Removes the legacy local journal database, if this browser still has one. */
export function purgeLegacyLocalJournalStore(): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise<void>(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(LEGACY_JOURNAL_DB_NAME);
    } catch {
      resolve();
      return;
    }
    // `blocked` resolves too: a stale tab holding the old bundle open must not
    // leave this promise (and therefore the caller) hanging.
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
