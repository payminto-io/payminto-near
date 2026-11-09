-- Accounts, sessions, invites, sign-up, email outbox, activity log, search (docs/PRODUCT.md sections 4, 5 and 10).
-- *_unix columns are unix seconds (compared by the node); *_at columns are ISO-8601 UTC text (shown to people).

CREATE TABLE users (
  id                TEXT PRIMARY KEY,                  -- usr_...
  email             TEXT NOT NULL UNIQUE,              -- lowercased
  email_verified_at TEXT,
  name              TEXT NOT NULL DEFAULT '',
  password_hash     TEXT,                              -- scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>
  totp_secret_enc   TEXT,                              -- reserved for two-step verification
  platform_role     TEXT CHECK (platform_role IN ('owner', 'admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'disabled')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,        -- failures in the current window
  first_failed_unix INTEGER,                           -- start of the current failure window
  lock_count        INTEGER NOT NULL DEFAULT 0,        -- locks so far; each doubles the next lock
  locked_until_unix INTEGER,
  last_business_id  TEXT REFERENCES merchants (id),
  last_active_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
-- At most one platform owner.
CREATE UNIQUE INDEX users_one_owner ON users (platform_role) WHERE platform_role = 'owner';

CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users (id),
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  role        TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, merchant_id)
);
CREATE INDEX memberships_merchant ON memberships (merchant_id);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,                  -- ses_..., public handle for the sessions list
  id_hash           TEXT NOT NULL UNIQUE,              -- sha256 of the cookie token; the token itself is never stored
  user_id           TEXT NOT NULL REFERENCES users (id),
  csrf_token        TEXT NOT NULL,
  created_unix      INTEGER NOT NULL,
  last_seen_unix    INTEGER NOT NULL,
  expires_unix      INTEGER NOT NULL,                  -- absolute expiry
  idle_expires_unix INTEGER NOT NULL,
  step_up_unix      INTEGER,                           -- last password check
  rotated_from      TEXT,
  revoked_unix      INTEGER,                           -- set in the future (grace) when rotated
  rotate_due        INTEGER NOT NULL DEFAULT 0,        -- 1 after a role or password change: the next request rotates
  ip                TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,                       -- inv_... for invites, tok_... otherwise
  token_hash   TEXT NOT NULL UNIQUE,                   -- sha256 of the token
  kind         TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password', 'invite', 'setup')),
  user_id      TEXT REFERENCES users (id),
  email        TEXT,
  merchant_id  TEXT REFERENCES merchants (id),
  role         TEXT,                                   -- invites: admin, staff, viewer or platform_admin
  expires_unix INTEGER NOT NULL,
  used_at      TEXT,
  revoked_at   TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX auth_tokens_kind ON auth_tokens (kind, merchant_id);
CREATE INDEX auth_tokens_email ON auth_tokens (email);

-- Reserved for sign in with wallet (section 4.5).
CREATE TABLE wallet_logins (
  user_id  TEXT NOT NULL REFERENCES users (id),
  address  TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE siwe_nonces (
  nonce        TEXT PRIMARY KEY,
  expires_unix INTEGER NOT NULL,
  used_at      TEXT
);

CREATE TABLE outbox_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  link       TEXT,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  error      TEXT
);

-- Append-only activity log, written in the same transaction as the change it records.
CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  at_unix     INTEGER NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'recovery_key', 'system')),
  actor_id    TEXT,
  merchant_id TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  ip          TEXT,
  meta_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_merchant ON audit_events (merchant_id, id);
CREATE INDEX audit_events_actor ON audit_events (actor_id, id);
CREATE INDEX audit_events_action ON audit_events (action, id);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
-- Retention may prune, but never rows younger than one year.
CREATE TRIGGER audit_events_keep_a_year BEFORE DELETE ON audit_events
WHEN old.at_unix > CAST(strftime('%s', 'now') AS INTEGER) - 31536000
BEGIN
  SELECT RAISE(ABORT, 'audit_events younger than one year cannot be deleted');
END;

CREATE TABLE signup_requests (
  id            TEXT PRIMARY KEY,                      -- sur_...
  user_id       TEXT NOT NULL REFERENCES users (id),
  business_name TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('unverified', 'pending', 'approved', 'declined')),
  reason        TEXT,
  merchant_id   TEXT REFERENCES merchants (id),
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT
);
CREATE INDEX signup_requests_status ON signup_requests (status, created_at);

CREATE TABLE search_recent (
  user_id TEXT NOT NULL REFERENCES users (id),
  type    TEXT NOT NULL,
  id      TEXT NOT NULL,
  title   TEXT NOT NULL,
  href    TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (user_id, type, id)
);

ALTER TABLE platform ADD COLUMN signup_mode TEXT NOT NULL DEFAULT 'off' CHECK (signup_mode IN ('off', 'approval', 'open'));
ALTER TABLE platform ADD COLUMN require_2fa_platform INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform ADD COLUMN agent_budgets_for_businesses INTEGER NOT NULL DEFAULT 0;

-- A business created by sign-up has no proven payout wallet yet (payout is the zero address until it proves one).
ALTER TABLE merchants ADD COLUMN payout_set INTEGER NOT NULL DEFAULT 1;

ALTER TABLE payment_links ADD COLUMN expires_at TEXT;
ALTER TABLE payment_links ADD COLUMN created_by TEXT;

ALTER TABLE refunds ADD COLUMN note TEXT;
ALTER TABLE refunds ADD COLUMN approval TEXT NOT NULL DEFAULT 'not_required' CHECK (approval IN ('not_required', 'requested', 'approved'));
ALTER TABLE refunds ADD COLUMN requested_by TEXT;
ALTER TABLE refunds ADD COLUMN approved_by TEXT;
ALTER TABLE refunds ADD COLUMN approved_at TEXT;

-- Pending deliveries carry their schedule explicitly.
UPDATE webhook_deliveries SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_unix, 'unixepoch')
WHERE status = 'pending' AND next_attempt_at IS NULL;

-- Exact-match indexes for search patterns (addresses, emails, references, tx hashes, amounts).
CREATE INDEX payments_payer_lc ON payments (lower(payer));
CREATE INDEX payments_email_lc ON payments (lower(customer_email));
CREATE INDEX payments_reference ON payments (reference);
CREATE INDEX payments_merchant_amount ON payments (merchant_id, amount);
CREATE INDEX payment_credits_payer_lc ON payment_credits (lower(payer));
CREATE INDEX payment_credits_tx_lc ON payment_credits (lower(tx_hash));
CREATE INDEX refunds_tx_lc ON refunds (lower(tx_hash));
CREATE INDEX refunds_to_lc ON refunds (lower(to_addr));
CREATE INDEX refunds_merchant ON refunds (merchant_id);
CREATE INDEX merchants_payout_lc ON merchants (lower(payout));
CREATE INDEX payment_links_merchant ON payment_links (merchant_id);

-- Full-text prefix search over the text fields, kept in sync by triggers (external content, keyed by rowid).
CREATE VIRTUAL TABLE payments_fts USING fts5(description, reference, customer_email, customer_name, content = 'payments', content_rowid = 'rowid', tokenize = 'unicode61');
CREATE TRIGGER payments_fts_ai AFTER INSERT ON payments BEGIN
  INSERT INTO payments_fts (rowid, description, reference, customer_email, customer_name) VALUES (new.rowid, new.description, new.reference, new.customer_email, new.customer_name);
END;
CREATE TRIGGER payments_fts_ad AFTER DELETE ON payments BEGIN
  INSERT INTO payments_fts (payments_fts, rowid, description, reference, customer_email, customer_name) VALUES ('delete', old.rowid, old.description, old.reference, old.customer_email, old.customer_name);
END;
CREATE TRIGGER payments_fts_au AFTER UPDATE OF description, reference, customer_email, customer_name ON payments BEGIN
  INSERT INTO payments_fts (payments_fts, rowid, description, reference, customer_email, customer_name) VALUES ('delete', old.rowid, old.description, old.reference, old.customer_email, old.customer_name);
  INSERT INTO payments_fts (rowid, description, reference, customer_email, customer_name) VALUES (new.rowid, new.description, new.reference, new.customer_email, new.customer_name);
END;
INSERT INTO payments_fts (payments_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE payment_links_fts USING fts5(title, description, slug, content = 'payment_links', content_rowid = 'rowid', tokenize = 'unicode61');
CREATE TRIGGER payment_links_fts_ai AFTER INSERT ON payment_links BEGIN
  INSERT INTO payment_links_fts (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;
CREATE TRIGGER payment_links_fts_ad AFTER DELETE ON payment_links BEGIN
  INSERT INTO payment_links_fts (payment_links_fts, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
END;
CREATE TRIGGER payment_links_fts_au AFTER UPDATE OF title, description, slug ON payment_links BEGIN
  INSERT INTO payment_links_fts (payment_links_fts, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
  INSERT INTO payment_links_fts (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;
INSERT INTO payment_links_fts (payment_links_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE merchants_fts USING fts5(name, slug, support_email, content = 'merchants', content_rowid = 'rowid', tokenize = 'unicode61');
CREATE TRIGGER merchants_fts_ai AFTER INSERT ON merchants BEGIN
  INSERT INTO merchants_fts (rowid, name, slug, support_email) VALUES (new.rowid, new.name, new.slug, new.support_email);
END;
CREATE TRIGGER merchants_fts_ad AFTER DELETE ON merchants BEGIN
  INSERT INTO merchants_fts (merchants_fts, rowid, name, slug, support_email) VALUES ('delete', old.rowid, old.name, old.slug, old.support_email);
END;
CREATE TRIGGER merchants_fts_au AFTER UPDATE OF name, slug, support_email ON merchants BEGIN
  INSERT INTO merchants_fts (merchants_fts, rowid, name, slug, support_email) VALUES ('delete', old.rowid, old.name, old.slug, old.support_email);
  INSERT INTO merchants_fts (rowid, name, slug, support_email) VALUES (new.rowid, new.name, new.slug, new.support_email);
END;
INSERT INTO merchants_fts (merchants_fts) VALUES ('rebuild');
