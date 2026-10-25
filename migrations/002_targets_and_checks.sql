-- A target is a service the worker polls, e.g. https://payments.internal/healthz
CREATE TABLE targets (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT        NOT NULL UNIQUE,
  url                   TEXT        NOT NULL,
  interval_seconds      INT         NOT NULL DEFAULT 30   CHECK (interval_seconds BETWEEN 5 AND 3600),
  timeout_ms            INT         NOT NULL DEFAULT 3000 CHECK (timeout_ms BETWEEN 100 AND 30000),
  failure_threshold     INT         NOT NULL DEFAULT 3    CHECK (failure_threshold BETWEEN 1 AND 10),
  recovery_threshold    INT         NOT NULL DEFAULT 2    CHECK (recovery_threshold BETWEEN 1 AND 10),
  enabled               BOOLEAN     NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- scheduling: a worker "claims" a target by pushing next_check_at into the future
  next_check_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- current health, updated after every check
  state                 TEXT        NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'up', 'down')),
  consecutive_failures  INT         NOT NULL DEFAULT 0,
  consecutive_successes INT         NOT NULL DEFAULT 0,
  last_checked_at       TIMESTAMPTZ,
  last_status_code      INT,
  last_latency_ms       INT,
  last_error            TEXT
);

-- The worker's hot query: "enabled targets that are due, oldest first".
-- Partial index: disabled targets aren't even in it.
CREATE INDEX targets_due_idx ON targets (next_check_at) WHERE enabled;

-- One row per check. Grows fast (1 target @ 30s = 86,400 rows/month), so the worker prunes it.
CREATE TABLE checks (
  id          BIGSERIAL PRIMARY KEY,
  target_id   BIGINT      NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ok          BOOLEAN     NOT NULL,
  status_code INT,
  latency_ms  INT         NOT NULL,
  error       TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX checks_target_checked_idx ON checks (target_id, checked_at DESC);
CREATE INDEX checks_checked_at_idx ON checks (checked_at);   -- for retention pruning

-- Alerts can now come from the worker. Manual alerts keep target_id NULL.
ALTER TABLE alerts ADD COLUMN target_id BIGINT REFERENCES targets(id) ON DELETE SET NULL;

-- The last line of defence against duplicate alerts: at most ONE open alert per target,
-- no matter how many workers race. (NULLs never conflict, so manual alerts are unaffected.)
CREATE UNIQUE INDEX alerts_one_open_per_target ON alerts (target_id) WHERE status = 'open';
