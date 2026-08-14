import type { AuditEntry, AuditSink } from "../types.js";

export interface MemoryAuditSink extends AuditSink {
  readonly entries: AuditEntry[];
  read(): AsyncIterable<AuditEntry>;
}

export function memoryAuditSink(seed: AuditEntry[] = []): MemoryAuditSink {
  const entries = [...seed];
  return {
    entries,
    async append(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },
    async *read(): AsyncIterable<AuditEntry> {
      yield* entries;
    },
  };
}
