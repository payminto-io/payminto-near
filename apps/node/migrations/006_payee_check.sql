-- The payee check (@payminto/payee-check): what the node knows about the accounts its Budgets pay.
-- Accounts are NEAR account ids, *_at columns are ISO-8601 UTC text and *_ms columns are unix milliseconds.

-- The latest verdict of the check per Budget and payee. The voucher path decides on this row when it must not read the
-- network (an approved or established payee) and when the check cannot run. A row is replaced only by a complete
-- verdict; an incomplete one (a source did not answer) is kept only while nothing better exists.
CREATE TABLE payee_verdicts (
  budget_id     TEXT NOT NULL REFERENCES budgets (id),
  payee         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('allow', 'warn', 'block')),
  verdict       TEXT NOT NULL,              -- the package's Verdict, as JSON
  complete      INTEGER NOT NULL CHECK (complete IN (0, 1)),
  checked_at_ms INTEGER NOT NULL,
  PRIMARY KEY (budget_id, payee)
);
CREATE INDEX payee_verdicts_payee ON payee_verdicts (payee);

-- An owner's decision about one payee of one Budget. `signals` lists the warn and block signals the owner saw when
-- deciding (JSON array of signal ids): the approval covers those and no later ones. NULL means the check was off, so
-- the approval covers any warning. override_block = 1 lets the approval stand against the block signals in `signals`.
CREATE TABLE payee_approvals (
  budget_id       TEXT NOT NULL REFERENCES budgets (id),
  payee           TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
  override_block  INTEGER NOT NULL DEFAULT 0 CHECK (override_block IN (0, 1)),
  signals         TEXT,
  note            TEXT,
  decided_by_type TEXT NOT NULL,            -- user, recovery_key
  decided_by_id   TEXT,                     -- usr_... for a user
  decided_at      TEXT NOT NULL,
  PRIMARY KEY (budget_id, payee)
);

-- A call that waits for the owner: one row per Budget and payee while no decision exists. source says who asked:
-- 'voucher' (the node refused a voucher with PAYEE_NEEDS_APPROVAL) or 'wallet' (the agent's wallet asked before signing).
CREATE TABLE payee_approval_requests (
  id         TEXT PRIMARY KEY,              -- par_...
  budget_id  TEXT NOT NULL REFERENCES budgets (id),
  payee      TEXT NOT NULL,
  amount     TEXT NOT NULL,                 -- the price of the latest call that waited, atomic units
  source     TEXT NOT NULL CHECK (source IN ('voucher', 'wallet')),
  status     TEXT CHECK (status IN ('allow', 'warn', 'block')),   -- the node's verdict when asked; NULL with the check off
  signals    TEXT NOT NULL DEFAULT '[]',    -- JSON: [{ id, severity, reason }]
  attempts   INTEGER NOT NULL DEFAULT 1,
  first_at   TEXT NOT NULL,
  last_at    TEXT NOT NULL,
  UNIQUE (budget_id, payee)
);

-- Reports against accounts: the blocklist the check reads. A reporter holds one report per account. Reports filed
-- through this node's API carry the node's operator account as reporter, and who filed them here.
CREATE TABLE payee_reports (
  account       TEXT NOT NULL,
  reporter      TEXT NOT NULL,
  reason        TEXT NOT NULL,              -- one plain line, at most 280 characters: a third party's claim, never acted on
  evidence      TEXT NOT NULL,              -- JSON: { type: "tx", hash } or { type: "url", url }
  at_ms         INTEGER NOT NULL,
  filed_by_type TEXT,
  filed_by_id   TEXT,
  PRIMARY KEY (account, reporter)
);

-- The code each account ran when the check last looked, so a later look can say that it changed.
CREATE TABLE payee_code_seen (
  account              TEXT PRIMARY KEY,
  contract_id          TEXT,
  first_seen_at_ms     INTEGER NOT NULL,
  changed_at_ms        INTEGER,
  previous_contract_id TEXT
);
