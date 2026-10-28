-- Share one rolling delivery budget across host registrations for a device.
-- Keep only a push-token digest, a random attempt ID, and relay timestamps.
CREATE TABLE device_message_attempts (
  token_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY(token_hash, attempt_id)
);
CREATE INDEX device_message_window ON device_message_attempts(token_hash, attempted_at);
CREATE INDEX device_message_expiry ON device_message_attempts(attempted_at);
