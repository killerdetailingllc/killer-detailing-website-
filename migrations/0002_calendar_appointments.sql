ALTER TABLE estimate_requests ADD COLUMN service_address TEXT NOT NULL DEFAULT '';
ALTER TABLE estimate_requests ADD COLUMN appointment_at TEXT;
ALTER TABLE estimate_requests ADD COLUMN appointment_duration_minutes INTEGER NOT NULL DEFAULT 120;
ALTER TABLE estimate_requests ADD COLUMN calendar_event_uid TEXT;
