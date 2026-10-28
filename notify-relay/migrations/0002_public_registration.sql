-- A route remains inactive until its receiver proves push-token ownership.
CREATE TABLE pending_registrations (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  route_hash TEXT NOT NULL,
  expo_token TEXT NOT NULL,
  host_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX registration_expiry ON pending_registrations(expires_at);

-- Shared across Worker locations. Store digests, never IP addresses.
CREATE TABLE registration_budgets (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX registration_budget_expiry ON registration_budgets(expires_at);
