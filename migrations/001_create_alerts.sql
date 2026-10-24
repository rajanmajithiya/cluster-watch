CREATE TABLE alerts (
  id          BIGSERIAL PRIMARY KEY,
  pod         TEXT        NOT NULL CHECK (length(trim(pod)) > 0),
  reason      TEXT        NOT NULL CHECK (length(trim(reason)) > 0),
  severity    TEXT        NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  status      TEXT        NOT NULL DEFAULT 'open'    CHECK (status IN ('open', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  -- the database itself refuses an impossible state, even if app code has a bug
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

-- Dashboards ask "show open alerts, newest first" constantly.
CREATE INDEX alerts_status_created_at_idx ON alerts (status, created_at DESC);
