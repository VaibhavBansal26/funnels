-- Identity pepper: a version (starts at 1, +1 on every change of value) so consumers can tell that keys changed, next to identity_pepper_rotated_at.
-- identity_pepper itself now holds `enc2.<keyId>.<ciphertext>` (AES-256-GCM under DATA_ENCRYPTION_KEY); a value in clear is a pepper written by an earlier
-- version and is encrypted the first time it is read (services/analyticsapi.ts), so no data migration runs here.
ALTER TABLE workspaces ADD COLUMN identity_pepper_version INTEGER NOT NULL DEFAULT 1;
