-- R06/R07: one durable record per paid receipt operation, claimed before any
-- provider call. The key is a hash of the authorized source (trip, draft,
-- draft fingerprint, photo and its stored version) and the operation kind, so
-- identical requests on any Worker instance share one operation. A lease
-- bounds how long a running attempt is trusted; an expired or failed
-- operation can be taken over only by a new request, never automatically.
CREATE TABLE receipt_operations (
  operation_key text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  trip_id text NOT NULL,
  draft_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'stored', 'failed')),
  attempt_id text NOT NULL,
  attempts integer DEFAULT 1 NOT NULL,
  lease_until integer NOT NULL,
  error_code text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX receipt_operations_updated_idx ON receipt_operations (updated_at);
