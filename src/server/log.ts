import "server-only";

import { createSafeLogRecord } from "../security/safe-log-record";

export function writeSafeLog(untrusted: unknown): void {
  const record = createSafeLogRecord(untrusted);
  // The serializer receives only an allowlisted record constructed above.
  console.info(JSON.stringify(record));
}
