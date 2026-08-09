import type { ResourceLedger, ResourceRecord } from "@von/core";
import { COLLECTIONS, type Db } from "./db.ts";

/**
 * Firestore-backed resource ledger.
 *
 * The record keyed `firebase.project:app_abc` is the platform's memory that it
 * already created that project. Keeping it in memory meant a restart between
 * "GCP created the project" and "we noticed" produced a second project on the
 * next run — billable, unreferenced, and invisible to every list endpoint.
 *
 * Document ids are the idempotency keys themselves, so "have I already made
 * this?" is a single point read and cannot race with a concurrent writer's
 * query index.
 */
export class FirestoreLedger implements ResourceLedger {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get records() {
    return this.db.collection(COLLECTIONS.resources);
  }

  /**
   * Keys contain `:` and `/` (`github.repo:app_abc`), which are legal in a
   * Firestore document id — but `/` would split the path. Encoding keeps the
   * id one segment and stays reversible.
   */
  private id(key: string): string {
    return encodeURIComponent(key);
  }

  async get(key: string): Promise<ResourceRecord | null> {
    const snap = await this.records.doc(this.id(key)).get();
    const data = snap.data();
    return data ? (data as unknown as ResourceRecord) : null;
  }

  async listByApp(appId: string): Promise<ResourceRecord[]> {
    const { docs } = await this.records.where("appId", "==", appId).get();
    return docs.map((d) => d.data() as unknown as ResourceRecord);
  }

  async upsert(record: ResourceRecord): Promise<void> {
    await this.records
      .doc(this.id(record.key))
      .set({ ...record, updatedAt: Date.now() });
  }
}
