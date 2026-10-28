CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  route_hash TEXT,
  expo_token TEXT,
  host_id TEXT NOT NULL,
  key_id TEXT NOT NULL
);
CREATE UNIQUE INDEX device_route ON devices(route_hash) WHERE route_hash IS NOT NULL;
CREATE TABLE deliveries (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ticket TEXT,
  token_hash TEXT NOT NULL,
  PRIMARY KEY(device_id, event_id)
);
CREATE INDEX pending_receipts ON deliveries(ticket) WHERE ticket IS NOT NULL;
