import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry, AuditSink } from "../types.js";

export function fileAuditSink(path: string): AuditSink {
  return {
    async append(entry: AuditEntry): Promise<void> {
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
    // TODO: stream line-by-line once logs outgrow memory; whole-file reads are fine at MVP scale.
    async *read(): AsyncIterable<AuditEntry> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return;
        }
        throw error;
      }
      const lines = raw.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (line === "") {
          continue;
        }
        try {
          yield JSON.parse(line) as AuditEntry;
        } catch {
          throw new SyntaxError(`audit log ${path} is corrupt at line ${index + 1}`);
        }
      }
    },
  };
}
