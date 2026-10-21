CREATE TABLE IF NOT EXISTS estimate_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  year TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  services_json TEXT NOT NULL,
  addons_json TEXT NOT NULL,
  condition_text TEXT NOT NULL,
  estimate_cents INTEGER,
  deposit_cents INTEGER,
  estimate_note TEXT,
  estimate_token_hash TEXT,
  estimate_expires_at TEXT,
  accepted_at TEXT,
  stripe_session_id TEXT,
  checkout_attempt INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS estimate_requests_status_created
  ON estimate_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS estimate_photos (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES estimate_requests(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS estimate_photos_request
  ON estimate_photos(request_id);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public_request_limits (
  ip_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
