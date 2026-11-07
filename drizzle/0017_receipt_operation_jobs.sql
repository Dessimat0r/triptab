-- R07: a receipt operation is also a durable job that the background runner
-- (the scheduled handler) can finish after the browser has gone. Existing
-- rows keep working: without a stored request or grant they are never resumed
-- and can never be committed by the runner.
--
-- request_json: the validated, authorized request (trip, draft, fingerprint,
--   photo and its stored version, kind). Identifiers only: no receipt text,
--   image, credential or cookie.
-- grant_kind/grant_ref/grant_expires_at: the execution grant of the person
--   whose request claimed (or last took over) the operation: their server-side
--   session ID ('session') or trusted ChatGPT identity ('chatgpt'), never a
--   cookie, token or token hash. Every commit, and every background start,
--   requires the grant to be unexpired and its session or link still live.
-- provider/provider_started_at: which credential kind the current attempt
--   spends with, recorded before the provider call.
-- auto_resumes: background resumes so far; bounded, so an interruption never
--   loops on paid inference.
ALTER TABLE receipt_operations ADD request_json text;--> statement-breakpoint
ALTER TABLE receipt_operations ADD grant_kind text;--> statement-breakpoint
ALTER TABLE receipt_operations ADD grant_ref text;--> statement-breakpoint
ALTER TABLE receipt_operations ADD grant_expires_at integer;--> statement-breakpoint
ALTER TABLE receipt_operations ADD provider text;--> statement-breakpoint
ALTER TABLE receipt_operations ADD provider_started_at integer;--> statement-breakpoint
ALTER TABLE receipt_operations ADD auto_resumes integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX receipt_operations_resume_idx ON receipt_operations (status, lease_until);
