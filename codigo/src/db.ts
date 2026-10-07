import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "worldsim.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
// Varios procesos pueden escribir a la vez (el TFM lanza mundos en paralelo):
// esperar al bloqueo en vez de fallar con SQLITE_BUSY.
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS country_analysis (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    country     TEXT    NOT NULL,
    run_date    TEXT    NOT NULL,
    sim_month   TEXT    NOT NULL,
    sim_year    INTEGER,
    move        TEXT    NOT NULL,
    confidence  TEXT    NOT NULL,
    sources     TEXT    NOT NULL,
    prediction  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(country, sim_month)
  );

  CREATE INDEX IF NOT EXISTS idx_analysis_country ON country_analysis(country);

  CREATE TABLE IF NOT EXISTS sim_news (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    country       TEXT    NOT NULL,
    sim_year      INTEGER NOT NULL,
    sim_month     INTEGER,
    headline      TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    tone          TEXT    NOT NULL DEFAULT 'BALANCED',
    sources_json  TEXT    NOT NULL DEFAULT '[]',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sim_news_country_year ON sim_news(country, sim_year);
  CREATE INDEX IF NOT EXISTS idx_sim_news_year ON sim_news(sim_year);

  CREATE TABLE IF NOT EXISTS territory_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year            INTEGER NOT NULL,
    zone_key            TEXT    NOT NULL,
    controller_country  TEXT    NOT NULL,
    lost_by_country     TEXT    NOT NULL,
    status              TEXT    NOT NULL,
    severity            TEXT    NOT NULL,
    retention_years     INTEGER NOT NULL,
    summary             TEXT    NOT NULL,
    regions_json        TEXT    NOT NULL DEFAULT '[]',
    source_analysis_id  INTEGER,
    historical_start_year INTEGER,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_territory_events_zone_year ON territory_events(zone_key, sim_year);
  CREATE INDEX IF NOT EXISTS idx_territory_events_year ON territory_events(sim_year);

  CREATE TABLE IF NOT EXISTS country_lifecycle_events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year              INTEGER NOT NULL,
    effective_sim_year    INTEGER NOT NULL,
    transition_key        TEXT    NOT NULL,
    transition_version    INTEGER NOT NULL,
    actor_country         TEXT    NOT NULL,
    confidence            TEXT    NOT NULL,
    summary               TEXT    NOT NULL,
    create_countries_json TEXT    NOT NULL DEFAULT '[]',
    deactivate_countries_json TEXT NOT NULL DEFAULT '[]',
    geometry_ops_json     TEXT    NOT NULL DEFAULT '[]',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(effective_sim_year, transition_key, transition_version)
  );

  CREATE INDEX IF NOT EXISTS idx_country_lifecycle_effective_year ON country_lifecycle_events(effective_sim_year);
  CREATE INDEX IF NOT EXISTS idx_country_lifecycle_transition ON country_lifecycle_events(transition_key, transition_version);

  CREATE TABLE IF NOT EXISTS country_lifecycle_promotion_audit (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year              INTEGER NOT NULL,
    effective_sim_year    INTEGER NOT NULL,
    transition_key        TEXT    NOT NULL,
    transition_version    INTEGER NOT NULL,
    actor_country         TEXT    NOT NULL,
    confidence            TEXT    NOT NULL,
    status                TEXT    NOT NULL,
    severity              TEXT    NOT NULL,
    decision              TEXT    NOT NULL,
    reason                TEXT    NOT NULL DEFAULT '',
    dry_run               INTEGER NOT NULL DEFAULT 0,
    before_event_json     TEXT    NOT NULL DEFAULT '',
    after_event_json      TEXT    NOT NULL DEFAULT '',
    rolled_back           INTEGER NOT NULL DEFAULT 0,
    rolled_back_at        TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_country_lifecycle_audit_year ON country_lifecycle_promotion_audit(sim_year, id);
  CREATE INDEX IF NOT EXISTS idx_country_lifecycle_audit_transition
    ON country_lifecycle_promotion_audit(transition_key, transition_version, sim_year, id);

  CREATE TABLE IF NOT EXISTS sim_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS country_conquest_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    country         TEXT    NOT NULL,
    requested_name  TEXT    NOT NULL,
    suggestions     TEXT    NOT NULL,
    used_ai         INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL,
    error           TEXT    NOT NULL DEFAULT '',
    requester_ip    TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conquest_attempt_country ON country_conquest_attempts(country, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conquest_attempt_ip ON country_conquest_attempts(requester_ip, created_at DESC);

  CREATE TABLE IF NOT EXISTS country_conquests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    country         TEXT    NOT NULL UNIQUE,
    requested_name  TEXT    NOT NULL,
    selected_name   TEXT    NOT NULL,
    price_cents     INTEGER NOT NULL DEFAULT 20,
    grace_until     TEXT    NOT NULL DEFAULT '',
    requester_ip    TEXT    NOT NULL DEFAULT '',
    attempt_id      INTEGER,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(attempt_id) REFERENCES country_conquest_attempts(id)
  );

  CREATE TABLE IF NOT EXISTS conquest_payment_sessions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id           TEXT    NOT NULL UNIQUE,
    country              TEXT    NOT NULL,
    requested_name       TEXT    NOT NULL,
    selected_name        TEXT    NOT NULL,
    requester_ip         TEXT    NOT NULL,
    amount_cents         INTEGER NOT NULL,
    status               TEXT    NOT NULL, -- created | authorized | captured | expired | canceled
    provider_payment_id  TEXT    NOT NULL DEFAULT '',
    attempt_id           INTEGER,
    expires_at           TEXT    NOT NULL,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_payment_sessions_country ON conquest_payment_sessions(country, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON conquest_payment_sessions(status, expires_at);

  CREATE TABLE IF NOT EXISTS conquest_images (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    country             TEXT    NOT NULL UNIQUE,
    conquest_id         INTEGER,
    payment_session_id  TEXT    NOT NULL,
    original_object_key TEXT    NOT NULL,
    styled_object_key   TEXT    NOT NULL DEFAULT '',
    original_url        TEXT    NOT NULL DEFAULT '',
    styled_url          TEXT    NOT NULL DEFAULT '',
    moderation_status   TEXT    NOT NULL, -- approved | rejected | failed
    moderation_reason   TEXT    NOT NULL DEFAULT '',
    moderation_labels   TEXT    NOT NULL DEFAULT '[]',
    provider_model      TEXT    NOT NULL DEFAULT '',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(conquest_id) REFERENCES country_conquests(id)
  );

  CREATE TABLE IF NOT EXISTS conquest_image_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    country             TEXT    NOT NULL,
    payment_session_id  TEXT    NOT NULL,
    original_object_key TEXT    NOT NULL,
    status              TEXT    NOT NULL, -- queued | processing | approved | rejected | failed
    attempts            INTEGER NOT NULL DEFAULT 0,
    error               TEXT    NOT NULL DEFAULT '',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(payment_session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_conquest_image_jobs_status ON conquest_image_jobs(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS analytics_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    event_name  TEXT    NOT NULL,
    sim_year    INTEGER,
    country     TEXT    NOT NULL DEFAULT '',
    props_json  TEXT    NOT NULL DEFAULT '{}',
    event_ts    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_events_year_name ON analytics_events(sim_year, event_name);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id, event_ts);

  CREATE TABLE IF NOT EXISTS llm_call_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_ts        TEXT    NOT NULL,
    event_date      TEXT    NOT NULL,
    sim_year        INTEGER,
    feature         TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    model           TEXT    NOT NULL DEFAULT '',
    country         TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL, -- success | error | fallback | skipped
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    error_category  TEXT    NOT NULL DEFAULT '',
    error_message   TEXT    NOT NULL DEFAULT '',
    meta_json       TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_llm_call_events_date ON llm_call_events(event_date, event_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_call_events_feature ON llm_call_events(feature, event_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_call_events_sim_year ON llm_call_events(sim_year, event_ts DESC);

  CREATE TABLE IF NOT EXISTS daily_scores (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year                     INTEGER NOT NULL,
    country                      TEXT    NOT NULL,
    interesting                  REAL    NOT NULL,
    novelty                      REAL    NOT NULL,
    viral                        REAL    NOT NULL,
    interesting_components_json  TEXT    NOT NULL DEFAULT '{}',
    novelty_components_json      TEXT    NOT NULL DEFAULT '{}',
    viral_components_json        TEXT    NOT NULL DEFAULT '{}',
    created_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at                   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sim_year, country)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_scores_year ON daily_scores(sim_year);

  CREATE TABLE IF NOT EXISTS monthly_news_images (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year        INTEGER NOT NULL,
    sim_month       INTEGER NOT NULL,
    country         TEXT    NOT NULL,
    headline        TEXT    NOT NULL,
    body            TEXT    NOT NULL DEFAULT '',
    story_hash      TEXT    NOT NULL,
    object_key      TEXT    NOT NULL DEFAULT '',
    image_url       TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending', -- pending | ready | failed
    provider_model  TEXT    NOT NULL DEFAULT '',
    error           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sim_year, country, sim_month)
  );

  CREATE INDEX IF NOT EXISTS idx_monthly_news_images_year ON monthly_news_images(sim_year, sim_month);

  CREATE TABLE IF NOT EXISTS share_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id         TEXT    NOT NULL,
    session_id       TEXT    NOT NULL DEFAULT '',
    sim_year         INTEGER,
    country          TEXT    NOT NULL DEFAULT '',
    channel          TEXT    NOT NULL DEFAULT 'x',
    status           TEXT    NOT NULL, -- initiated | completed | downstream
    deep_link_token  TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_share_events_share_status ON share_events(share_id, status);
  CREATE INDEX IF NOT EXISTS idx_share_events_year_status ON share_events(sim_year, status);
  CREATE INDEX IF NOT EXISTS idx_share_events_token_status ON share_events(deep_link_token, status);

  CREATE TABLE IF NOT EXISTS country_geometry_overrides (
    country       TEXT NOT NULL PRIMARY KEY,
    geojson_geom  TEXT NOT NULL,
    merged_zones  TEXT NOT NULL DEFAULT '[]',
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS country_agent_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    country     TEXT    NOT NULL,
    sim_year    INTEGER NOT NULL,
    decision    TEXT    NOT NULL,
    outcome     TEXT    NOT NULL,
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_memory_country_year ON country_agent_memory(country, sim_year);

  CREATE TABLE IF NOT EXISTS diplomatic_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_year    INTEGER NOT NULL,
    country     TEXT    NOT NULL,
    type        TEXT    NOT NULL, -- UN_VOTE | TRADE_EMBARGO | SUMMIT | DISASTER
    description TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_diplomatic_events_year ON diplomatic_events(sim_year);
  CREATE INDEX IF NOT EXISTS idx_diplomatic_events_country ON diplomatic_events(country);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS god_interventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT NOT NULL,
    target_country TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('COUP','BOOM','DISASTER')),
    sim_year_triggered INTEGER NOT NULL,
    duration_years INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired')),
    payment_session_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_god_interventions_active ON god_interventions(status, sim_year_triggered);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lore_injections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL,
    user_name TEXT NOT NULL,
    injection_type TEXT NOT NULL CHECK(injection_type IN ('CULTURAL_QUIRK','MILITARY_UNIT','MOTTO')),
    content TEXT NOT NULL,
    payment_session_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_lore_injections_country ON lore_injections(country);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_lore_checkouts (
    session_id TEXT PRIMARY KEY,
    country TEXT NOT NULL,
    user_name TEXT NOT NULL,
    injection_type TEXT NOT NULL CHECK(injection_type IN ('CULTURAL_QUIRK','MILITARY_UNIT','MOTTO')),
    content TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pending_lore_checkouts_expiry ON pending_lore_checkouts(expires_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS civil_wars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL,
    defender_name TEXT NOT NULL,
    challenger_name TEXT NOT NULL,
    start_sim_year INTEGER NOT NULL,
    end_sim_year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','defender_won','challenger_won')),
    payment_session_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_civil_wars_active ON civil_wars(status, country);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS dynamic_territory_zones (
    zone_key         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    controller       TEXT NOT NULL,
    lost_by          TEXT NOT NULL,
    geometry_type    TEXT NOT NULL DEFAULT 'Polygon',
    coordinates      TEXT NOT NULL,
    approx_km2       REAL NOT NULL DEFAULT 0,
    anchor_countries TEXT NOT NULL DEFAULT '[]',
    created_sim_year INTEGER NOT NULL,
    source           TEXT NOT NULL DEFAULT 'llm'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sim_year_summaries (
    sim_year    INTEGER PRIMARY KEY,
    summary     TEXT    NOT NULL,
    key_events  TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_image_generation_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_date  TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_image_generation_usage_date
    ON ai_image_generation_usage(usage_date, created_at DESC);
`);

try {
  db.exec(`ALTER TABLE country_analysis ADD COLUMN prediction TEXT NOT NULL DEFAULT ''`);
} catch {}
try {
  db.exec(`ALTER TABLE country_analysis ADD COLUMN sim_year INTEGER`);
} catch {}
try {
  db.exec(`ALTER TABLE country_analysis ADD COLUMN sim_month TEXT NOT NULL DEFAULT ''`);
} catch {}
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_sim_year ON country_analysis(sim_year)`);
} catch {}
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_sim_month ON country_analysis(sim_month)`);
} catch {}
try {
  db.exec(`ALTER TABLE sim_news ADD COLUMN sim_month INTEGER`);
} catch {}
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sim_news_country_year_month ON sim_news(country, sim_year, sim_month)`);
} catch {}
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_news_country_year_month_nonnull
      ON sim_news(country, sim_year, sim_month)
      WHERE sim_month IS NOT NULL
  `);
} catch {}
try {
  db.exec(`ALTER TABLE country_conquests ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 20`);
} catch {}
try {
  db.exec(`ALTER TABLE country_conquests ADD COLUMN grace_until TEXT NOT NULL DEFAULT ''`);
} catch {}
try {
  db.exec(`ALTER TABLE territory_events ADD COLUMN historical_start_year INTEGER`);
} catch {}
try {
  db.exec(`ALTER TABLE civil_wars ADD COLUMN zone_key TEXT`);
} catch {}

function monthlyNewsImagesNeedsCountryScopedMigration(): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'monthly_news_images'`)
    .get() as { sql?: string } | undefined;
  const sql = row?.sql || "";
  return sql.includes("UNIQUE(sim_year, sim_month)") && !sql.includes("UNIQUE(sim_year, country, sim_month)");
}

if (monthlyNewsImagesNeedsCountryScopedMigration()) {
  db.exec(`
    ALTER TABLE monthly_news_images RENAME TO monthly_news_images_legacy;

    CREATE TABLE monthly_news_images (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sim_year        INTEGER NOT NULL,
      sim_month       INTEGER NOT NULL,
      country         TEXT    NOT NULL,
      headline        TEXT    NOT NULL,
      body            TEXT    NOT NULL DEFAULT '',
      story_hash      TEXT    NOT NULL,
      object_key      TEXT    NOT NULL DEFAULT '',
      image_url       TEXT    NOT NULL DEFAULT '',
      status          TEXT    NOT NULL DEFAULT 'pending',
      provider_model  TEXT    NOT NULL DEFAULT '',
      error           TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sim_year, country, sim_month)
    );

    INSERT INTO monthly_news_images (
      id, sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
      status, provider_model, error, created_at, updated_at
    )
    SELECT
      id, sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
      status, provider_model, error, created_at, updated_at
    FROM monthly_news_images_legacy;

    DROP TABLE monthly_news_images_legacy;

    CREATE INDEX idx_monthly_news_images_year ON monthly_news_images(sim_year, sim_month);
  `);
}

// Backfill sim_year for legacy rows from sim_month prefix where possible.
db.exec(`
  UPDATE country_analysis
  SET sim_year = CAST(substr(sim_month, 1, 4) AS INTEGER)
  WHERE (sim_year IS NULL OR sim_year = 0)
    AND length(sim_month) >= 4
    AND substr(sim_month, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
`);

db.exec(`
  UPDATE country_analysis
  SET sim_month = printf(
    '%04d-01',
    COALESCE(
      NULLIF(sim_year, 0),
      CASE
        WHEN length(run_date) >= 4 AND substr(run_date, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
          THEN CAST(substr(run_date, 1, 4) AS INTEGER)
        ELSE 2026
      END
    )
  )
  WHERE sim_month IS NULL OR trim(sim_month) = ''
`);

db.exec(`
  UPDATE country_conquests
  SET grace_until = datetime(created_at, '+7 days')
  WHERE grace_until IS NULL OR grace_until = ''
`);

db.exec(`
  INSERT OR IGNORE INTO sim_config (key, value)
  VALUES ('fun_factor', '0.35')
`);

export interface StoredAnalysis {
  country: string;
  sim_month: string;
  sim_year: number;
  move: string;
  confidence: string;
  sources: string[];
  prediction: string;
}

export interface HistoryEntry {
  sim_year: number;
  sim_month: string;
  move: string;
  confidence: string;
  prediction: string;
}

const PLACEHOLDER_ANALYSIS_MOVES = new Set([
  "Maintain defensive monitoring posture while preserving strategic flexibility.",
  "Maintain continuity posture while recalibrating diplomatic and economic leverage.",
  "No intelligence available for this period.",
  "Maintaining baseline posture while tracking emerging strategic pressure points.",
]);

const PLACEHOLDER_ANALYSIS_PREDICTIONS = new Set([
  "Maintain current posture while testing limited diplomatic and economic leverage next year.",
]);

const PLACEHOLDER_SIM_NEWS_BODY_PREFIXES = [
  "No high-confidence external trigger. Existing posture remains in place.",
  "No high-confidence shift was generated for this month. Current posture remains active into next year.",
  "Policy direction remains stable while decision-makers monitor regional shifts.",
  "No major verified trigger for this month. Leadership maintains calibrated diplomatic and economic pressure options.",
];

export interface SimNewsRow {
  id: number;
  country: string;
  sim_year: number;
  sim_month: number | null;
  headline: string;
  body: string;
  tone: string;
  sources: string[];
  created_at: string;
}

export type TerritoryEventStatus = "GAINED" | "LOST" | "DISPUTED";
export type TerritorySeverity = "MINOR" | "MAJOR" | "CATASTROPHIC";
export type CountryLifecycleConfidence = "MEDIUM" | "HIGH";

export interface TerritoryEventRow {
  id: number;
  sim_year: number;
  zone_key: string;
  controller_country: string;
  lost_by_country: string;
  status: TerritoryEventStatus;
  severity: TerritorySeverity;
  retention_years: number;
  summary: string;
  regions: string[];
  source_analysis_id: number | null;
  historical_start_year?: number | null;
  created_at: string;
}

export type DiplomaticEventType = "UN_VOTE" | "TRADE_EMBARGO" | "SUMMIT" | "DISASTER";

export interface DiplomaticEventRow {
  id: number;
  sim_year: number;
  country: string;
  type: DiplomaticEventType;
  description: string;
  created_at: string;
}

export interface CountryLifecycleEventRow {
  id: number;
  sim_year: number;
  effective_sim_year: number;
  transition_key: string;
  transition_version: number;
  actor_country: string;
  confidence: CountryLifecycleConfidence;
  summary: string;
  create_countries: string[];
  deactivate_countries: string[];
  geometry_ops: unknown[];
  created_at: string;
}

export type CountryLifecyclePromotionDecision = "accepted_written" | "accepted_dry_run" | "rejected";

export interface CountryLifecyclePromotionAuditRow {
  id: number;
  sim_year: number;
  effective_sim_year: number;
  transition_key: string;
  transition_version: number;
  actor_country: string;
  confidence: string;
  status: string;
  severity: string;
  decision: CountryLifecyclePromotionDecision;
  reason: string;
  dry_run: boolean;
  before_event: CountryLifecycleEventRow | null;
  after_event: CountryLifecycleEventRow | null;
  rolled_back: boolean;
  rolled_back_at: string | null;
  created_at: string;
}

export interface ConquestAttempt {
  id: number;
  country: string;
  requested_name: string;
  suggestions: string[];
  used_ai: boolean;
  status: string;
  error: string;
  requester_ip: string;
  created_at: string;
}

export interface ConquestRecord {
  id: number;
  country: string;
  requested_name: string;
  selected_name: string;
  price_cents: number;
  grace_until: string;
  requester_ip: string;
  attempt_id: number | null;
  created_at: string;
}

export interface PaymentSessionRecord {
  id: number;
  session_id: string;
  country: string;
  requested_name: string;
  selected_name: string;
  requester_ip: string;
  amount_cents: number;
  status: "created" | "authorized" | "captured" | "expired" | "canceled";
  provider_payment_id: string;
  attempt_id: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConquestImageRecord {
  country: string;
  styled_url: string;
  moderation_status: string;
  moderation_reason: string;
  moderation_labels: string[];
  updated_at: string;
}

export interface AnalyticsEventRow {
  id: number;
  session_id: string;
  event_name: string;
  sim_year: number | null;
  country: string;
  props: Record<string, unknown>;
  event_ts: string;
  created_at: string;
}

export interface AnalyticsEventInput {
  name: string;
  ts: number | string;
  props?: Record<string, unknown>;
  country?: string;
  simYear?: number | null;
}

export type LlmCallStatus = "success" | "error" | "fallback" | "skipped";

export interface LlmCallEventRow {
  id: number;
  event_ts: string;
  event_date: string;
  sim_year: number | null;
  feature: string;
  provider: string;
  model: string;
  country: string;
  status: LlmCallStatus;
  latency_ms: number;
  error_category: string;
  error_message: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface LlmCallEventInput {
  ts?: number | string;
  simYear?: number | null;
  feature: string;
  provider: string;
  model?: string;
  country?: string;
  status: LlmCallStatus;
  latencyMs?: number;
  errorCategory?: string;
  errorMessage?: string;
  meta?: Record<string, unknown>;
}

export interface DailyScoreRow {
  id: number;
  sim_year: number;
  country: string;
  interesting: number;
  novelty: number;
  viral: number;
  interesting_components: Record<string, number>;
  novelty_components: Record<string, number>;
  viral_components: Record<string, number>;
  created_at: string;
  updated_at: string;
}

export interface MonthlyNewsImageRow {
  id: number;
  sim_year: number;
  sim_month: number;
  country: string;
  headline: string;
  body: string;
  story_hash: string;
  object_key: string;
  image_url: string;
  status: "pending" | "ready" | "failed";
  provider_model: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export function isPlaceholderMonthlyNewsImageProviderModel(providerModel: string): boolean {
  return providerModel.trim().toLowerCase().startsWith("mock-synth");
}

export function isPlaceholderAnalysisMove(move: string): boolean {
  return PLACEHOLDER_ANALYSIS_MOVES.has((move || "").trim());
}

export function isPlaceholderAnalysisPrediction(prediction: string): boolean {
  return PLACEHOLDER_ANALYSIS_PREDICTIONS.has((prediction || "").trim());
}

export function isPlaceholderAnalysisRow(input: {
  move: string;
  prediction: string;
  confidence?: string | null;
}): boolean {
  const move = (input.move || "").trim();
  const prediction = (input.prediction || "").trim();
  const confidence = (input.confidence || "").trim().toUpperCase();
  if (isPlaceholderAnalysisMove(move)) return true;
  if (move.toLowerCase().includes("no intelligence available")) return true;
  if (confidence === "LOW" && move.toLowerCase().includes("defensive monitoring posture")) return true;
  return false;
}

export function isPlaceholderSimNewsRow(input: { headline: string; body: string }): boolean {
  const headline = (input.headline || "").trim().toLowerCase();
  const body = (input.body || "").trim();
  if (PLACEHOLDER_SIM_NEWS_BODY_PREFIXES.some((prefix) => body.startsWith(prefix))) return true;
  if (/ month \d+ strategic outlook \d{4}$/.test(headline)) return true;
  if (/ month \d+ continuity \d{4}$/.test(headline)) return true;
  if (/ month \d+ simulated outlook \d{4}$/.test(headline)) return true;
  // "Kazakhstan shifts trade posture in 2052" style cyclic placeholder headlines
  if (/ shifts (trade posture|security doctrine|regional leverage|energy pivot|tech corridor|border pressure) in \d{4}$/.test(headline)) return true;
  return false;
}

export type ShareEventStatus = "initiated" | "completed" | "downstream";

export interface ShareEventRow {
  id: number;
  share_id: string;
  session_id: string;
  sim_year: number | null;
  country: string;
  channel: string;
  status: ShareEventStatus;
  deep_link_token: string;
  created_at: string;
}

const stmtUpdateAnalysisByYear = db.prepare(`
  UPDATE country_analysis
  SET run_date=@run_date,
      sim_month=@sim_month,
      move=@move,
      confidence=@confidence,
      sources=@sources,
      prediction=@prediction,
      created_at=datetime('now')
  WHERE country=@country AND sim_year=@sim_year
`);

const stmtInsertAnalysis = db.prepare(`
  INSERT INTO country_analysis (country, run_date, sim_month, sim_year, move, confidence, sources, prediction)
  VALUES (@country, @run_date, @sim_month, @sim_year, @move, @confidence, @sources, @prediction)
`);

const stmtGetByCountry = db.prepare(`
  SELECT country, sim_month, sim_year, move, confidence, sources, prediction
  FROM country_analysis
  WHERE country = ?
  ORDER BY COALESCE(sim_year, CAST(substr(sim_month,1,4) AS INTEGER)) DESC, sim_month DESC
`);

const stmtGetAllByYear = db.prepare(`
  SELECT country, sim_month, sim_year, move, confidence, sources, prediction
  FROM country_analysis
  WHERE sim_year = ?
`);

const stmtGetLatestAnalysisAllCountries = db.prepare(`
  WITH ranked AS (
    SELECT
      country, sim_month, sim_year, move, confidence, sources, prediction,
      ROW_NUMBER() OVER (
        PARTITION BY country
        ORDER BY COALESCE(sim_year, CAST(substr(sim_month,1,4) AS INTEGER)) DESC, sim_month DESC
      ) AS rn
    FROM country_analysis
  )
  SELECT country, sim_month, sim_year, move, confidence, sources, prediction
  FROM ranked
  WHERE rn = 1
`);

const stmtGetAllByMonth = db.prepare(`
  SELECT country, sim_month, sim_year, move, confidence, sources, prediction
  FROM country_analysis
  WHERE sim_month = ?
`);

const stmtGetHistory = db.prepare(`
  SELECT sim_year, sim_month, move, confidence, prediction
  FROM country_analysis
  WHERE country = ?
  ORDER BY COALESCE(sim_year, CAST(substr(sim_month,1,4) AS INTEGER)) ASC, sim_month ASC
`);

const stmtLastRunDate = db.prepare(`
  SELECT MAX(run_date) as last_run FROM country_analysis
`);

const stmtGetAllCountryAnalysisRowsForCleanup = db.prepare(`
  SELECT id, move, prediction, confidence
  FROM country_analysis
`);

const stmtDeleteCountryAnalysisById = db.prepare(`
  DELETE FROM country_analysis
  WHERE id = ?
`);

const stmtClearCountryAnalysisPredictionById = db.prepare(`
  UPDATE country_analysis
  SET prediction = ''
  WHERE id = ?
`);

const stmtInsertSimNews = db.prepare(`
  INSERT INTO sim_news (country, sim_year, sim_month, headline, body, tone, sources_json)
  VALUES (@country, @sim_year, @sim_month, @headline, @body, @tone, @sources_json)
`);

const stmtDeleteSimNewsForCountryYear = db.prepare(`
  DELETE FROM sim_news
  WHERE country = ? AND sim_year = ?
`);

const stmtGetSimNewsForCountryBeforeYear = db.prepare(`
  SELECT id, country, sim_year, sim_month, headline, body, tone, sources_json, created_at
  FROM sim_news
  WHERE country = ? AND sim_year < ?
  ORDER BY sim_year ASC, id ASC
`);

const stmtGetSimNewsByYear = db.prepare(`
  SELECT id, country, sim_year, sim_month, headline, body, tone, sources_json, created_at
  FROM sim_news
  WHERE sim_year = ?
  ORDER BY country ASC, id ASC
`);

const stmtGetAllSimNewsRowsForCleanup = db.prepare(`
  SELECT id, headline, body
  FROM sim_news
`);

const stmtDeleteSimNewsById = db.prepare(`
  DELETE FROM sim_news
  WHERE id = ?
`);

const stmtGetMonthlyNewsImageByYearCountryMonth = db.prepare(`
  SELECT
    id, sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
    status, provider_model, error, created_at, updated_at
  FROM monthly_news_images
  WHERE sim_year = ? AND country = ? AND sim_month = ?
  LIMIT 1
`);

const stmtGetMonthlyNewsImagesByYear = db.prepare(`
  SELECT
    id, sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
    status, provider_model, error, created_at, updated_at
  FROM monthly_news_images
  WHERE sim_year = ?
  ORDER BY sim_month ASC
`);

const stmtGetPlaceholderMonthlyNewsImages = db.prepare(`
  SELECT
    id, sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
    status, provider_model, error, created_at, updated_at
  FROM monthly_news_images
  WHERE lower(provider_model) LIKE 'mock-synth%'
  ORDER BY sim_year ASC, sim_month ASC, country ASC
`);

const stmtUpsertMonthlyNewsImage = db.prepare(`
  INSERT INTO monthly_news_images (
    sim_year, sim_month, country, headline, body, story_hash, object_key, image_url,
    status, provider_model, error
  )
  VALUES (
    @sim_year, @sim_month, @country, @headline, @body, @story_hash, @object_key, @image_url,
    @status, @provider_model, @error
  )
  ON CONFLICT(sim_year, country, sim_month) DO UPDATE SET
    country = @country,
    headline = @headline,
    body = @body,
    story_hash = @story_hash,
    object_key = @object_key,
    image_url = @image_url,
    status = @status,
    provider_model = @provider_model,
    error = @error,
    updated_at = datetime('now')
`);

const stmtCountAiImageGenerationUsageByDate = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM ai_image_generation_usage
  WHERE usage_date = ?
`);

const stmtInsertAiImageGenerationUsage = db.prepare(`
  INSERT INTO ai_image_generation_usage (usage_date, source, note)
  VALUES (@usage_date, @source, @note)
`);

const stmtInsertTerritoryEvent = db.prepare(`
  INSERT INTO territory_events (
    sim_year, zone_key, controller_country, lost_by_country, status, severity,
    retention_years, summary, regions_json, source_analysis_id, historical_start_year
  )
  VALUES (
    @sim_year, @zone_key, @controller_country, @lost_by_country, @status, @severity,
    @retention_years, @summary, @regions_json, @source_analysis_id, @historical_start_year
  )
`);

const stmtDeleteTerritoryEventForZoneYear = db.prepare(`
  DELETE FROM territory_events
  WHERE zone_key = ? AND sim_year = ?
`);

const stmtGetZoneNewsImageExact = db.prepare(`
  SELECT image_url FROM monthly_news_images
  WHERE country = ?
    AND sim_year = ?
    AND status = 'ready'
    AND image_url != ''
    AND provider_model != ''
    AND lower(provider_model) NOT LIKE 'mock-synth%'
  ORDER BY sim_month DESC
  LIMIT 1
`);

const stmtGetZoneNewsImageNearest = db.prepare(`
  SELECT image_url FROM monthly_news_images
  WHERE country = ?
    AND status = 'ready'
    AND image_url != ''
    AND provider_model != ''
    AND lower(provider_model) NOT LIKE 'mock-synth%'
  ORDER BY ABS(sim_year - ?) ASC, sim_month DESC
  LIMIT 1
`);

const stmtDeleteMonthlyNewsImageById = db.prepare(`
  DELETE FROM monthly_news_images
  WHERE id = ?
`);

const stmtGetActiveTerritoryEvents = db.prepare(`
  WITH ranked AS (
    SELECT
      id,
      sim_year,
      zone_key,
      controller_country,
      lost_by_country,
      status,
      severity,
      retention_years,
      summary,
      regions_json,
      source_analysis_id,
      created_at,
      ROW_NUMBER() OVER (
        PARTITION BY zone_key
        ORDER BY sim_year DESC, id DESC
      ) AS row_rank
    FROM territory_events
    WHERE ? <= (sim_year + retention_years)
  )
  SELECT
    id, sim_year, zone_key, controller_country, lost_by_country, status, severity,
    retention_years, summary, regions_json, source_analysis_id, created_at
  FROM ranked
  WHERE row_rank = 1
  ORDER BY sim_year DESC, id DESC
`);

const stmtGetTerritoryEventsForCountry = db.prepare(`
  SELECT
    id, sim_year, zone_key, controller_country, lost_by_country, status, severity,
    retention_years, summary, regions_json, source_analysis_id, created_at
  FROM territory_events
  WHERE controller_country = ? OR lost_by_country = ?
  ORDER BY sim_year ASC, id ASC
`);

const stmtInsertCountryLifecycleEvent = db.prepare(`
  INSERT INTO country_lifecycle_events (
    sim_year, effective_sim_year, transition_key, transition_version, actor_country,
    confidence, summary, create_countries_json, deactivate_countries_json, geometry_ops_json
  )
  VALUES (
    @sim_year, @effective_sim_year, @transition_key, @transition_version, @actor_country,
    @confidence, @summary, @create_countries_json, @deactivate_countries_json, @geometry_ops_json
  )
`);

const stmtDeleteCountryLifecycleEventForTransitionYear = db.prepare(`
  DELETE FROM country_lifecycle_events
  WHERE sim_year = ? AND transition_key = ? AND transition_version = ?
`);

const stmtGetCountryLifecycleEventsUpToYear = db.prepare(`
  SELECT
    id, sim_year, effective_sim_year, transition_key, transition_version,
    actor_country, confidence, summary, create_countries_json, deactivate_countries_json,
    geometry_ops_json, created_at
  FROM country_lifecycle_events
  WHERE effective_sim_year <= ?
  ORDER BY effective_sim_year ASC, id ASC
`);

const stmtGetCountryLifecycleEventsForYear = db.prepare(`
  SELECT
    id, sim_year, effective_sim_year, transition_key, transition_version,
    actor_country, confidence, summary, create_countries_json, deactivate_countries_json,
    geometry_ops_json, created_at
  FROM country_lifecycle_events
  WHERE effective_sim_year = ?
  ORDER BY id ASC
`);

const stmtGetCountryLifecycleEventForSimTransitionYear = db.prepare(`
  SELECT
    id, sim_year, effective_sim_year, transition_key, transition_version,
    actor_country, confidence, summary, create_countries_json, deactivate_countries_json,
    geometry_ops_json, created_at
  FROM country_lifecycle_events
  WHERE sim_year = ? AND transition_key = ? AND transition_version = ?
  ORDER BY id DESC
  LIMIT 1
`);

const stmtInsertCountryLifecyclePromotionAudit = db.prepare(`
  INSERT INTO country_lifecycle_promotion_audit (
    sim_year, effective_sim_year, transition_key, transition_version, actor_country,
    confidence, status, severity, decision, reason, dry_run, before_event_json, after_event_json
  )
  VALUES (
    @sim_year, @effective_sim_year, @transition_key, @transition_version, @actor_country,
    @confidence, @status, @severity, @decision, @reason, @dry_run, @before_event_json, @after_event_json
  )
`);

const stmtGetCountryLifecyclePromotionAuditByYear = db.prepare(`
  SELECT
    id, sim_year, effective_sim_year, transition_key, transition_version, actor_country,
    confidence, status, severity, decision, reason, dry_run, before_event_json, after_event_json,
    rolled_back, rolled_back_at, created_at
  FROM country_lifecycle_promotion_audit
  WHERE sim_year = ?
  ORDER BY id DESC
`);

const stmtGetCountryLifecyclePromotionAuditById = db.prepare(`
  SELECT
    id, sim_year, effective_sim_year, transition_key, transition_version, actor_country,
    confidence, status, severity, decision, reason, dry_run, before_event_json, after_event_json,
    rolled_back, rolled_back_at, created_at
  FROM country_lifecycle_promotion_audit
  WHERE id = ?
  LIMIT 1
`);

const stmtMarkCountryLifecyclePromotionAuditRolledBack = db.prepare(`
  UPDATE country_lifecycle_promotion_audit
  SET rolled_back = 1, rolled_back_at = datetime('now')
  WHERE id = ?
`);

const stmtGetConfig = db.prepare(`
  SELECT value FROM sim_config WHERE key = ? LIMIT 1
`);

const stmtUpsertConfig = db.prepare(`
  INSERT INTO sim_config (key, value, updated_at)
  VALUES (@key, @value, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value=@value, updated_at=datetime('now')
`);

const stmtInsertConquestAttempt = db.prepare(`
  INSERT INTO country_conquest_attempts (
    country, requested_name, suggestions, used_ai, status, error, requester_ip
  )
  VALUES (@country, @requested_name, @suggestions, @used_ai, @status, @error, @requester_ip)
`);

const stmtLatestConquestAttempt = db.prepare(`
  SELECT id, country, requested_name, suggestions, used_ai, status, error, requester_ip, created_at
  FROM country_conquest_attempts
  WHERE country = ? AND requested_name = ? AND status = 'ok'
  ORDER BY id DESC
  LIMIT 1
`);

const stmtGetConquestAttemptById = db.prepare(`
  SELECT id, country, requested_name, suggestions, used_ai, status, error, requester_ip, created_at
  FROM country_conquest_attempts
  WHERE id = ?
  LIMIT 1
`);

const stmtCountConquestAttemptsByIpSince = db.prepare(`
  SELECT COUNT(1) as cnt
  FROM country_conquest_attempts
  WHERE requester_ip = ? AND created_at >= ?
`);

const stmtUpsertConquestClaim = db.prepare(`
  INSERT INTO country_conquests (
    country, requested_name, selected_name, price_cents, grace_until, requester_ip, attempt_id
  )
  VALUES (@country, @requested_name, @selected_name, @price_cents, @grace_until, @requester_ip, @attempt_id)
  ON CONFLICT(country) DO UPDATE SET
    requested_name = @requested_name,
    selected_name  = @selected_name,
    price_cents    = @price_cents,
    grace_until    = @grace_until,
    requester_ip   = @requester_ip,
    attempt_id     = @attempt_id,
    created_at     = datetime('now')
`);

const stmtGetConquestNameMap = db.prepare(`
  SELECT country, selected_name
  FROM country_conquests
`);

const stmtGetConquestByCountry = db.prepare(`
  SELECT id, country, requested_name, selected_name, price_cents, grace_until, requester_ip, attempt_id, created_at
  FROM country_conquests
  WHERE country = ?
  LIMIT 1
`);

const stmtInsertPaymentSession = db.prepare(`
  INSERT INTO conquest_payment_sessions (
    session_id, country, requested_name, selected_name, requester_ip, amount_cents, status, provider_payment_id, attempt_id, expires_at
  )
  VALUES (@session_id, @country, @requested_name, @selected_name, @requester_ip, @amount_cents, @status, @provider_payment_id, @attempt_id, @expires_at)
`);

const stmtGetPaymentSessionById = db.prepare(`
  SELECT id, session_id, country, requested_name, selected_name, requester_ip, amount_cents, status, provider_payment_id, attempt_id, expires_at, created_at, updated_at
  FROM conquest_payment_sessions
  WHERE session_id = ?
  LIMIT 1
`);

const stmtUpdatePaymentSessionStatus = db.prepare(`
  UPDATE conquest_payment_sessions
  SET status = @status,
      provider_payment_id = @provider_payment_id,
      updated_at = datetime('now')
  WHERE session_id = @session_id
`);

const stmtExpirePaymentSessionsBefore = db.prepare(`
  UPDATE conquest_payment_sessions
  SET status = 'expired',
      updated_at = datetime('now')
  WHERE status IN ('created', 'authorized')
    AND expires_at < ?
`);

const stmtCountCapturedNonPayingConquestsByIp = db.prepare(`
  SELECT COUNT(1) AS cnt
  FROM conquest_payment_sessions
  WHERE requester_ip = ?
    AND status = 'captured'
    AND amount_cents <= 0
`);

const stmtUpsertConquestImage = db.prepare(`
  INSERT INTO conquest_images (
    country, conquest_id, payment_session_id, original_object_key, styled_object_key, original_url, styled_url,
    moderation_status, moderation_reason, moderation_labels, provider_model
  )
  VALUES (
    @country, @conquest_id, @payment_session_id, @original_object_key, @styled_object_key, @original_url, @styled_url,
    @moderation_status, @moderation_reason, @moderation_labels, @provider_model
  )
  ON CONFLICT(country) DO UPDATE SET
    conquest_id = @conquest_id,
    payment_session_id = @payment_session_id,
    original_object_key = @original_object_key,
    styled_object_key = @styled_object_key,
    original_url = @original_url,
    styled_url = @styled_url,
    moderation_status = @moderation_status,
    moderation_reason = @moderation_reason,
    moderation_labels = @moderation_labels,
    provider_model = @provider_model,
    updated_at = datetime('now')
`);

const stmtGetConquestImageByCountry = db.prepare(`
  SELECT country, styled_url, moderation_status, moderation_reason, moderation_labels, updated_at
  FROM conquest_images
  WHERE country = ?
  LIMIT 1
`);

const stmtGetConquestImageMap = db.prepare(`
  SELECT country, styled_url
  FROM conquest_images
  WHERE styled_url != ''
    AND moderation_status = 'approved'
`);

const stmtUpsertImageJob = db.prepare(`
  INSERT INTO conquest_image_jobs (country, payment_session_id, original_object_key, status, attempts, error)
  VALUES (@country, @payment_session_id, @original_object_key, @status, @attempts, @error)
  ON CONFLICT(payment_session_id) DO UPDATE SET
    country = @country,
    original_object_key = @original_object_key,
    status = @status,
    attempts = @attempts,
    error = @error,
    updated_at = datetime('now')
`);

const stmtGetImageJobBySession = db.prepare(`
  SELECT id, country, payment_session_id, original_object_key, status, attempts, error, created_at, updated_at
  FROM conquest_image_jobs
  WHERE payment_session_id = ?
  LIMIT 1
`);

const stmtInsertAnalyticsEvent = db.prepare(`
  INSERT INTO analytics_events (
    session_id, event_name, sim_year, country, props_json, event_ts
  )
  VALUES (@session_id, @event_name, @sim_year, @country, @props_json, @event_ts)
`);

const stmtGetAnalyticsEventsByYear = db.prepare(`
  SELECT id, session_id, event_name, sim_year, country, props_json, event_ts, created_at
  FROM analytics_events
  WHERE sim_year = ?
  ORDER BY id ASC
`);

const stmtInsertLlmCallEvent = db.prepare(`
  INSERT INTO llm_call_events (
    event_ts, event_date, sim_year, feature, provider, model, country,
    status, latency_ms, error_category, error_message, meta_json
  )
  VALUES (
    @event_ts, @event_date, @sim_year, @feature, @provider, @model, @country,
    @status, @latency_ms, @error_category, @error_message, @meta_json
  )
`);

const stmtGetRecentLlmCallEvents = db.prepare(`
  SELECT
    id, event_ts, event_date, sim_year, feature, provider, model, country,
    status, latency_ms, error_category, error_message, meta_json, created_at
  FROM llm_call_events
  WHERE event_ts >= ?
  ORDER BY event_ts ASC, id ASC
`);

const stmtUpsertDailyScore = db.prepare(`
  INSERT INTO daily_scores (
    sim_year, country, interesting, novelty, viral,
    interesting_components_json, novelty_components_json, viral_components_json
  )
  VALUES (
    @sim_year, @country, @interesting, @novelty, @viral,
    @interesting_components_json, @novelty_components_json, @viral_components_json
  )
  ON CONFLICT(sim_year, country) DO UPDATE SET
    interesting = @interesting,
    novelty = @novelty,
    viral = @viral,
    interesting_components_json = @interesting_components_json,
    novelty_components_json = @novelty_components_json,
    viral_components_json = @viral_components_json,
    updated_at = datetime('now')
`);

const stmtGetDailyScoresByYear = db.prepare(`
  SELECT id, sim_year, country, interesting, novelty, viral,
         interesting_components_json, novelty_components_json, viral_components_json,
         created_at, updated_at
  FROM daily_scores
  WHERE sim_year = ?
  ORDER BY country ASC
`);

const stmtGetDailyScoreByYearCountry = db.prepare(`
  SELECT id, sim_year, country, interesting, novelty, viral,
         interesting_components_json, novelty_components_json, viral_components_json,
         created_at, updated_at
  FROM daily_scores
  WHERE sim_year = ? AND country = ?
  LIMIT 1
`);

const stmtInsertShareEvent = db.prepare(`
  INSERT OR IGNORE INTO share_events (
    share_id, session_id, sim_year, country, channel, status, deep_link_token
  )
  VALUES (
    @share_id, @session_id, @sim_year, @country, @channel, @status, @deep_link_token
  )
`);

const stmtCountDistinctShareByYearStatus = db.prepare(`
  SELECT COUNT(DISTINCT share_id) AS count
  FROM share_events
  WHERE sim_year = ? AND status = ?
`);

const stmtFindShareByToken = db.prepare(`
  SELECT id, share_id, session_id, sim_year, country, channel, status, deep_link_token, created_at
  FROM share_events
  WHERE deep_link_token = ? AND status = 'initiated'
  ORDER BY id DESC
  LIMIT 1
`);

const stmtUpsertCountryGeometryOverride = db.prepare(`
  INSERT INTO country_geometry_overrides (country, geojson_geom, merged_zones, updated_at)
  VALUES (@country, @geojson_geom, @merged_zones, datetime('now'))
  ON CONFLICT(country) DO UPDATE SET
    geojson_geom = excluded.geojson_geom,
    merged_zones = excluded.merged_zones,
    updated_at   = datetime('now')
`);

const stmtGetAllCountryGeometryOverrides = db.prepare(`
  SELECT country, geojson_geom, merged_zones FROM country_geometry_overrides
`);

const stmtDeleteZoneEvent = db.prepare(`
  DELETE FROM territory_events WHERE zone_key = ?
`);

const stmtInsertDiplomaticEvent = db.prepare(`
  INSERT INTO diplomatic_events (sim_year, country, type, description)
  VALUES (@sim_year, @country, @type, @description)
`);

const stmtGetDiplomaticEventsByYear = db.prepare(`
  SELECT id, sim_year, country, type, description, created_at
  FROM diplomatic_events
  WHERE sim_year = ?
`);

const stmtDeleteDiplomaticEventsByYear = db.prepare(`
  DELETE FROM diplomatic_events
  WHERE sim_year = ?
`);

export function insertDiplomaticEvent(event: {
  simYear: number;
  country: string;
  type: DiplomaticEventType;
  description: string;
}): void {
  stmtInsertDiplomaticEvent.run({
    sim_year: event.simYear,
    country: event.country,
    type: event.type,
    description: event.description,
  });
}

export function getDiplomaticEventsByYear(simYear: number): DiplomaticEventRow[] {
  const rows = stmtGetDiplomaticEventsByYear.all(simYear) as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    country: row.country,
    type: row.type,
    description: row.description,
    created_at: row.created_at,
  }));
}

export function clearDiplomaticEventsByYear(simYear: number): void {
  stmtDeleteDiplomaticEventsByYear.run(simYear);
}

export function upsertAnalysis(
  country: string,
  runDate: string,
  simYear: number,
  move: string,
  confidence: string,
  sources: string[],
  prediction: string
): void {
  const simMonthCompat = `${simYear}-01`;
  const moveText = (move || "").trim();
  if (!moveText || isPlaceholderAnalysisMove(moveText)) return;
  const safePrediction = isPlaceholderAnalysisPrediction(prediction) ? "" : (prediction || "").trim();
  const payload = {
    country,
    run_date: runDate,
    sim_month: simMonthCompat,
    sim_year: simYear,
    move: moveText,
    confidence,
    sources: JSON.stringify(sources),
    prediction: safePrediction,
  };

  const updated = stmtUpdateAnalysisByYear.run(payload);
  if (updated.changes === 0) {
    stmtInsertAnalysis.run(payload);
  }
}

export function getLatestAnalysis(country: string): StoredAnalysis | null {
  const rows = stmtGetByCountry.all(country) as any[];
  for (const row of rows) {
    if (isPlaceholderAnalysisRow(row)) continue;
    return {
      country: row.country,
      sim_month: row.sim_month,
      sim_year: Number(row.sim_year || Number.parseInt(String(row.sim_month).slice(0, 4), 10) || 0),
      move: row.move,
      confidence: row.confidence,
      sources: JSON.parse(row.sources),
      prediction: isPlaceholderAnalysisPrediction(row.prediction) ? "" : row.prediction,
    };
  }
  return null;
}

export function getAllAnalysisForSimYear(simYear: number): Record<string, StoredAnalysis> {
  const rows = stmtGetAllByYear.all(simYear) as any[];
  const map: Record<string, StoredAnalysis> = {};
  for (const row of rows) {
    if (isPlaceholderAnalysisRow(row)) continue;
    map[row.country] = {
      country: row.country,
      sim_month: row.sim_month,
      sim_year: Number(row.sim_year || simYear),
      move: row.move,
      confidence: row.confidence,
      sources: JSON.parse(row.sources),
      prediction: isPlaceholderAnalysisPrediction(row.prediction) ? "" : row.prediction,
    };
  }
  return map;
}

export function getLatestAnalysisForAllCountries(): Record<string, StoredAnalysis> {
  const rows = stmtGetLatestAnalysisAllCountries.all() as any[];
  const map: Record<string, StoredAnalysis> = {};
  for (const row of rows) {
    if (isPlaceholderAnalysisRow(row)) continue;
    const yearNum = Number(row.sim_year || Number.parseInt(String(row.sim_month).slice(0, 4), 10) || 0);
    map[row.country] = {
      country: row.country,
      sim_month: row.sim_month,
      sim_year: yearNum,
      move: row.move,
      confidence: row.confidence,
      sources: JSON.parse(row.sources),
      prediction: isPlaceholderAnalysisPrediction(row.prediction) ? "" : row.prediction,
    };
  }
  return map;
}

export function getAllAnalysisForMonth(simMonth: string): Record<string, StoredAnalysis> {
  const rows = stmtGetAllByMonth.all(simMonth) as any[];
  const map: Record<string, StoredAnalysis> = {};
  for (const row of rows) {
    if (isPlaceholderAnalysisRow(row)) continue;
    map[row.country] = {
      country: row.country,
      sim_month: row.sim_month,
      sim_year: Number(row.sim_year || Number.parseInt(String(row.sim_month).slice(0, 4), 10) || 0),
      move: row.move,
      confidence: row.confidence,
      sources: JSON.parse(row.sources),
      prediction: isPlaceholderAnalysisPrediction(row.prediction) ? "" : row.prediction,
    };
  }
  return map;
}

export function getCountryHistory(country: string): HistoryEntry[] {
  const rows = stmtGetHistory.all(country) as any[];
  return rows
    .filter((row) => !isPlaceholderAnalysisRow(row))
    .map((row) => ({
      sim_year: Number(row.sim_year || Number.parseInt(String(row.sim_month).slice(0, 4), 10) || 0),
      sim_month: row.sim_month,
      move: row.move,
      confidence: row.confidence,
      prediction: isPlaceholderAnalysisPrediction(row.prediction) ? "" : row.prediction,
    }));
}

export function getLastRunDate(): string | null {
  const row = stmtLastRunDate.get() as any;
  return row?.last_run ?? null;
}

export function replaceSimNewsForCountryYear(country: string, simYear: number, rows: Array<{
  month: number;
  headline: string;
  body: string;
  tone: string;
  sources: string[];
}>): void {
  const tx = db.transaction(() => {
    stmtDeleteSimNewsForCountryYear.run(country, simYear);
    for (const row of rows) {
      stmtInsertSimNews.run({
        country,
        sim_year: simYear,
        sim_month: Number.isFinite(row.month) ? Math.max(1, Math.min(12, Math.floor(row.month))) : null,
        headline: row.headline,
        body: row.body,
        tone: row.tone,
        sources_json: JSON.stringify(row.sources),
      });
    }
  });
  tx();
}

export function insertSimNewsItem(input: {
  country: string;
  simYear: number;
  simMonth?: number | null;
  headline: string;
  body: string;
  tone?: string;
  sources?: string[];
}): void {
  stmtInsertSimNews.run({
    country: input.country,
    sim_year: input.simYear,
    sim_month: typeof input.simMonth === 'number' ? input.simMonth : null,
    headline: input.headline,
    body: input.body,
    tone: input.tone ?? 'BALANCED',
    sources_json: JSON.stringify(input.sources ?? []),
  });
}

export function getSimNewsForCountryBeforeYear(country: string, beforeYear: number): SimNewsRow[] {
  const rows = stmtGetSimNewsForCountryBeforeYear.all(country, beforeYear) as any[];
  const mapped = rows.map((row) => ({
    id: row.id,
    country: row.country,
    sim_year: Number(row.sim_year),
    sim_month: normalizeSimMonth(row.sim_month),
    headline: row.headline,
    body: row.body,
    tone: row.tone,
    sources: JSON.parse(row.sources_json),
    created_at: row.created_at,
  }));
  return resolveLegacySimNewsMonths(mapped);
}

export function getSimNewsByYear(simYear: number): Record<string, SimNewsRow[]> {
  const rows = stmtGetSimNewsByYear.all(simYear) as any[];
  const resolved = resolveLegacySimNewsMonths(
    rows.map((row) => ({
      id: row.id,
      country: row.country,
      sim_year: Number(row.sim_year),
      sim_month: normalizeSimMonth(row.sim_month),
      headline: row.headline,
      body: row.body,
      tone: row.tone,
      sources: JSON.parse(row.sources_json),
      created_at: row.created_at,
    }))
  );
  const grouped: Record<string, SimNewsRow[]> = {};
  for (const item of resolved) {
    if (isPlaceholderSimNewsRow(item)) continue;
    if (!grouped[item.country]) grouped[item.country] = [];
    grouped[item.country].push(item);
  }
  return grouped;
}

export function purgePlaceholderAnalysisAndSimNews(): {
  analysisDeleted: number;
  analysisPredictionsCleared: number;
  simNewsDeleted: number;
} {
  const tx = db.transaction(() => {
    let analysisDeleted = 0;
    let analysisPredictionsCleared = 0;
    let simNewsDeleted = 0;

    const analysisRows = stmtGetAllCountryAnalysisRowsForCleanup.all() as Array<{
      id: number;
      move: string;
      prediction: string;
      confidence: string;
    }>;
    for (const row of analysisRows) {
      if (isPlaceholderAnalysisRow(row)) {
        const result = stmtDeleteCountryAnalysisById.run(row.id);
        analysisDeleted += Number(result.changes ?? 0);
        continue;
      }
      if (isPlaceholderAnalysisPrediction(row.prediction)) {
        const result = stmtClearCountryAnalysisPredictionById.run(row.id);
        analysisPredictionsCleared += Number(result.changes ?? 0);
      }
    }

    const simNewsRows = stmtGetAllSimNewsRowsForCleanup.all() as Array<{
      id: number;
      headline: string;
      body: string;
    }>;
    for (const row of simNewsRows) {
      if (!isPlaceholderSimNewsRow(row)) continue;
      const result = stmtDeleteSimNewsById.run(row.id);
      simNewsDeleted += Number(result.changes ?? 0);
    }

    return {
      analysisDeleted,
      analysisPredictionsCleared,
      simNewsDeleted,
    };
  });
  return tx();
}

function mapMonthlyNewsImageRow(row: any): MonthlyNewsImageRow {
  return {
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    sim_month: normalizeSimMonth(row.sim_month) ?? 1,
    country: row.country ?? "",
    headline: row.headline ?? "",
    body: row.body ?? "",
    story_hash: row.story_hash ?? "",
    object_key: row.object_key ?? "",
    image_url: row.image_url ?? "",
    status: row.status === "ready" || row.status === "failed" ? row.status : "pending",
    provider_model: row.provider_model ?? "",
    error: row.error ?? "",
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

export function getMonthlyNewsImageByYearCountryMonth(
  simYear: number,
  country: string,
  simMonth: number
): MonthlyNewsImageRow | null {
  const normalizedMonth = normalizeSimMonth(simMonth);
  if (normalizedMonth === null) return null;
  const row = stmtGetMonthlyNewsImageByYearCountryMonth.get(simYear, country, normalizedMonth) as any;
  if (!row) return null;
  return mapMonthlyNewsImageRow(row);
}

export function getMonthlyNewsImagesByYear(simYear: number): MonthlyNewsImageRow[] {
  const rows = stmtGetMonthlyNewsImagesByYear.all(simYear) as any[];
  return rows.map((row) => mapMonthlyNewsImageRow(row));
}

export function getPlaceholderMonthlyNewsImages(): MonthlyNewsImageRow[] {
  const rows = stmtGetPlaceholderMonthlyNewsImages.all() as any[];
  return rows.map((row) => mapMonthlyNewsImageRow(row));
}

export function getZoneNewsImageUrl(controllerCountry: string, simYear: number): string | null {
  const exact = stmtGetZoneNewsImageExact.get(controllerCountry, simYear) as { image_url: string } | undefined;
  if (exact) return exact.image_url;
  const nearest = stmtGetZoneNewsImageNearest.get(controllerCountry, simYear) as { image_url: string } | undefined;
  return nearest?.image_url ?? null;
}

export function upsertMonthlyNewsImage(input: {
  simYear: number;
  simMonth: number;
  country: string;
  headline: string;
  body: string;
  storyHash: string;
  objectKey: string;
  imageUrl: string;
  status: "pending" | "ready" | "failed";
  providerModel: string;
  error?: string;
}): void {
  const normalizedMonth = normalizeSimMonth(input.simMonth);
  if (normalizedMonth === null) return;
  stmtUpsertMonthlyNewsImage.run({
    sim_year: input.simYear,
    sim_month: normalizedMonth,
    country: input.country,
    headline: input.headline,
    body: input.body,
    story_hash: input.storyHash,
    object_key: input.objectKey,
    image_url: input.imageUrl,
    status: input.status,
    provider_model: input.providerModel,
    error: input.error ?? "",
  });
}

export function tryReserveAiImageGenerationUsage(input: {
  usageDate: string;
  source: string;
  note?: string;
  maxPerDay: number;
}): { allowed: boolean; used: number } {
  const tx = db.transaction((params: { usageDate: string; source: string; note: string; maxPerDay: number }) => {
    const row = stmtCountAiImageGenerationUsageByDate.get(params.usageDate) as any;
    const used = Number(row?.cnt ?? 0);
    if (used >= params.maxPerDay) {
      return { allowed: false, used };
    }
    stmtInsertAiImageGenerationUsage.run({
      usage_date: params.usageDate,
      source: params.source,
      note: params.note,
    });
    return { allowed: true, used: used + 1 };
  });

  return tx({
    usageDate: input.usageDate,
    source: input.source,
    note: input.note ?? "",
    maxPerDay: Math.max(0, Math.trunc(input.maxPerDay)),
  });
}

export function deleteMonthlyNewsImagesByIds(ids: number[]): number {
  if (ids.length === 0) return 0;
  const tx = db.transaction((values: number[]) => {
    let deleted = 0;
    for (const id of values) {
      const result = stmtDeleteMonthlyNewsImageById.run(id);
      deleted += Number(result.changes ?? 0);
    }
    return deleted;
  });
  return tx(ids);
}

function normalizeSimMonth(value: unknown): number | null {
  const month = Number(value);
  if (!Number.isFinite(month)) return null;
  const intMonth = Math.floor(month);
  if (intMonth < 1 || intMonth > 12) return null;
  return intMonth;
}

function deriveLegacySimMonth(index: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  const raw = Math.round(((index + 1) * 12) / (total + 1));
  return Math.max(1, Math.min(12, raw));
}

function resolveLegacySimNewsMonths(rows: SimNewsRow[]): SimNewsRow[] {
  const groups = new Map<string, SimNewsRow[]>();
  for (const row of rows) {
    if (row.sim_month !== null) continue;
    const key = `${row.country}::${row.sim_year}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  for (const groupRows of groups.values()) {
    groupRows.sort((a, b) => a.id - b.id);
    const total = groupRows.length;
    for (let i = 0; i < groupRows.length; i++) {
      groupRows[i].sim_month = deriveLegacySimMonth(i, total);
    }
  }

  return rows;
}

export function replaceTerritoryEventForZoneYear(input: {
  simYear: number;
  zoneKey: string;
  controllerCountry: string;
  lostByCountry: string;
  status: TerritoryEventStatus;
  severity: TerritorySeverity;
  retentionYears: number;
  summary: string;
  regions: string[];
  sourceAnalysisId?: number | null;
  historicalStartYear?: number | null;
}): void {
  const tx = db.transaction(() => {
    stmtDeleteTerritoryEventForZoneYear.run(input.zoneKey, input.simYear);
    stmtInsertTerritoryEvent.run({
      sim_year: input.simYear,
      zone_key: input.zoneKey,
      controller_country: input.controllerCountry,
      lost_by_country: input.lostByCountry,
      status: input.status,
      severity: input.severity,
      retention_years: input.retentionYears,
      summary: input.summary,
      regions_json: JSON.stringify(input.regions),
      source_analysis_id: input.sourceAnalysisId ?? null,
      historical_start_year: input.historicalStartYear ?? null,
    });
  });
  tx();
}

export function getActiveTerritoryEvents(simYearNow: number): TerritoryEventRow[] {
  const rows = stmtGetActiveTerritoryEvents.all(simYearNow) as any[];
  return rows.map((row) => ({
    id: row.id,
    sim_year: Number(row.sim_year),
    zone_key: row.zone_key,
    controller_country: row.controller_country,
    lost_by_country: row.lost_by_country,
    status: row.status,
    severity: row.severity,
    retention_years: Number(row.retention_years),
    summary: row.summary,
    regions: JSON.parse(row.regions_json),
    source_analysis_id: row.source_analysis_id ?? null,
    historical_start_year: row.historical_start_year != null ? Number(row.historical_start_year) : null,
    created_at: row.created_at,
  }));
}

export function getTerritoryEventsForCountry(country: string): TerritoryEventRow[] {
  const rows = stmtGetTerritoryEventsForCountry.all(country, country) as any[];
  return rows.map((row) => {
    let regions: string[] = [];
    try {
      const parsed = JSON.parse(row.regions_json ?? "[]");
      if (Array.isArray(parsed)) {
        regions = parsed.filter((value: unknown): value is string => typeof value === "string");
      }
    } catch {
      regions = [];
    }
    return {
      id: Number(row.id),
      sim_year: Number(row.sim_year),
      zone_key: row.zone_key,
      controller_country: row.controller_country,
      lost_by_country: row.lost_by_country,
      status: row.status,
      severity: row.severity,
      retention_years: Number(row.retention_years),
      summary: row.summary,
      regions,
      source_analysis_id: row.source_analysis_id ?? null,
      historical_start_year: row.historical_start_year != null ? Number(row.historical_start_year) : null,
      created_at: row.created_at,
    };
  });
}

export function upsertCountryGeometryOverride(
  country: string,
  geojsonGeom: string,
  mergedZones: string[]
): void {
  stmtUpsertCountryGeometryOverride.run({
    country,
    geojson_geom: geojsonGeom,
    merged_zones: JSON.stringify(mergedZones),
  });
}

export function getAllCountryGeometryOverrides(): Record<string, string> {
  const rows = stmtGetAllCountryGeometryOverrides.all() as { country: string; geojson_geom: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.country] = row.geojson_geom;
  return out;
}

export function getAlreadyMergedZones(): Set<string> {
  const rows = db.prepare(`SELECT merged_zones FROM country_geometry_overrides`).all() as { merged_zones: string }[];
  const merged = new Set<string>();
  for (const row of rows) {
    try { for (const z of JSON.parse(row.merged_zones)) merged.add(z); } catch { /* ignore */ }
  }
  return merged;
}

export interface AgentMemoryRow {
  id: number;
  country: string;
  sim_year: number;
  decision: string;
  outcome: string;
  notes: string;
  created_at: string;
}

const stmtInsertAgentMemory = db.prepare(`
  INSERT INTO country_agent_memory (country, sim_year, decision, outcome, notes)
  VALUES (@country, @sim_year, @decision, @outcome, @notes)
`);

const stmtGetAgentMemoryByCountry = db.prepare(`
  SELECT id, country, sim_year, decision, outcome, notes, created_at
  FROM country_agent_memory
  WHERE country = ?
  ORDER BY sim_year DESC, id DESC
  LIMIT ?
`);

const stmtDeleteAgentMemoryForCountryYear = db.prepare(`
  DELETE FROM country_agent_memory
  WHERE country = ? AND sim_year = ?
`);

export function saveAgentMemory(input: {
  country: string;
  sim_year: number;
  decision: string;
  outcome: string;
  notes: string;
}): void {
  stmtDeleteAgentMemoryForCountryYear.run(input.country, input.sim_year);
  stmtInsertAgentMemory.run({
    country: input.country,
    sim_year: input.sim_year,
    decision: input.decision,
    outcome: input.outcome,
    notes: input.notes,
  });
}

/**
 * Inserts a supplemental agent memory row without first clearing existing rows for that year.
 * Use this for secondary memory entries (e.g., lore injection records) that should coexist
 * alongside the primary AI-generated memory.
 */
export function insertAgentMemoryRow(input: {
  country: string;
  sim_year: number;
  decision: string;
  outcome: string;
  notes: string;
}): void {
  stmtInsertAgentMemory.run({
    country: input.country,
    sim_year: input.sim_year,
    decision: input.decision,
    outcome: input.outcome,
    notes: input.notes,
  });
}

export function getAgentMemoryForCountry(country: string, limit = 10): AgentMemoryRow[] {
  const rows = stmtGetAgentMemoryByCountry.all(country, limit) as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    country: row.country,
    sim_year: Number(row.sim_year),
    decision: row.decision,
    outcome: row.outcome,
    notes: row.notes,
    created_at: row.created_at,
  }));
}

export function deleteZoneEventByKey(zoneKey: string): void {
  stmtDeleteZoneEvent.run(zoneKey);
}

function mapCountryLifecycleRow(row: any): CountryLifecycleEventRow {
  const confidenceRaw = String(row.confidence || "").toUpperCase();
  const confidence: CountryLifecycleConfidence = confidenceRaw === "HIGH" ? "HIGH" : "MEDIUM";
  let createCountries: string[] = [];
  let deactivateCountries: string[] = [];
  let geometryOps: unknown[] = [];
  try {
    const parsed = JSON.parse(row.create_countries_json || "[]");
    if (Array.isArray(parsed)) {
      createCountries = parsed.filter((value: unknown): value is string => typeof value === "string");
    }
  } catch {}
  try {
    const parsed = JSON.parse(row.deactivate_countries_json || "[]");
    if (Array.isArray(parsed)) {
      deactivateCountries = parsed.filter((value: unknown): value is string => typeof value === "string");
    }
  } catch {}
  try {
    const parsed = JSON.parse(row.geometry_ops_json || "[]");
    if (Array.isArray(parsed)) geometryOps = parsed;
  } catch {}
  return {
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    effective_sim_year: Number(row.effective_sim_year),
    transition_key: String(row.transition_key || ""),
    transition_version: Number(row.transition_version || 0),
    actor_country: String(row.actor_country || ""),
    confidence,
    summary: String(row.summary || ""),
    create_countries: createCountries,
    deactivate_countries: deactivateCountries,
    geometry_ops: geometryOps,
    created_at: String(row.created_at || ""),
  };
}

function parseLifecycleEventJson(raw: string): CountryLifecycleEventRow | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      id: Number(record.id || 0),
      sim_year: Number(record.sim_year || 0),
      effective_sim_year: Number(record.effective_sim_year || 0),
      transition_key: String(record.transition_key || ""),
      transition_version: Number(record.transition_version || 0),
      actor_country: String(record.actor_country || ""),
      confidence: String(record.confidence || "MEDIUM").toUpperCase() === "HIGH" ? "HIGH" : "MEDIUM",
      summary: String(record.summary || ""),
      create_countries: Array.isArray(record.create_countries)
        ? record.create_countries.filter((value): value is string => typeof value === "string")
        : [],
      deactivate_countries: Array.isArray(record.deactivate_countries)
        ? record.deactivate_countries.filter((value): value is string => typeof value === "string")
        : [],
      geometry_ops: Array.isArray(record.geometry_ops) ? record.geometry_ops : [],
      created_at: String(record.created_at || ""),
    };
  } catch {
    return null;
  }
}

function mapCountryLifecyclePromotionAuditRow(row: any): CountryLifecyclePromotionAuditRow {
  const decisionRaw = String(row.decision || "").trim();
  const decision: CountryLifecyclePromotionDecision =
    decisionRaw === "accepted_written" || decisionRaw === "accepted_dry_run" ? decisionRaw : "rejected";
  return {
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    effective_sim_year: Number(row.effective_sim_year),
    transition_key: String(row.transition_key || ""),
    transition_version: Number(row.transition_version || 0),
    actor_country: String(row.actor_country || ""),
    confidence: String(row.confidence || ""),
    status: String(row.status || ""),
    severity: String(row.severity || ""),
    decision,
    reason: String(row.reason || ""),
    dry_run: Number(row.dry_run || 0) === 1,
    before_event: parseLifecycleEventJson(String(row.before_event_json || "")),
    after_event: parseLifecycleEventJson(String(row.after_event_json || "")),
    rolled_back: Number(row.rolled_back || 0) === 1,
    rolled_back_at: row.rolled_back_at ? String(row.rolled_back_at) : null,
    created_at: String(row.created_at || ""),
  };
}

export function replaceCountryLifecycleEventForTransitionYear(input: {
  simYear: number;
  effectiveSimYear: number;
  transitionKey: string;
  transitionVersion: number;
  actorCountry: string;
  confidence: CountryLifecycleConfidence;
  summary: string;
  createCountries: string[];
  deactivateCountries: string[];
  geometryOps: unknown[];
}): void {
  const tx = db.transaction(() => {
    stmtDeleteCountryLifecycleEventForTransitionYear.run(
      input.simYear,
      input.transitionKey,
      input.transitionVersion
    );
    stmtInsertCountryLifecycleEvent.run({
      sim_year: input.simYear,
      effective_sim_year: input.effectiveSimYear,
      transition_key: input.transitionKey,
      transition_version: input.transitionVersion,
      actor_country: input.actorCountry,
      confidence: input.confidence,
      summary: input.summary,
      create_countries_json: JSON.stringify(input.createCountries),
      deactivate_countries_json: JSON.stringify(input.deactivateCountries),
      geometry_ops_json: JSON.stringify(input.geometryOps),
    });
  });
  tx();
}

export function getCountryLifecycleEventForSimTransitionYear(
  simYear: number,
  transitionKey: string,
  transitionVersion: number
): CountryLifecycleEventRow | null {
  const row = stmtGetCountryLifecycleEventForSimTransitionYear.get(
    simYear,
    transitionKey,
    transitionVersion
  ) as any;
  if (!row) return null;
  return mapCountryLifecycleRow(row);
}

export function insertCountryLifecyclePromotionAudit(input: {
  simYear: number;
  effectiveSimYear: number;
  transitionKey: string;
  transitionVersion: number;
  actorCountry: string;
  confidence: string;
  status: string;
  severity: string;
  decision: CountryLifecyclePromotionDecision;
  reason: string;
  dryRun: boolean;
  beforeEvent: CountryLifecycleEventRow | null;
  afterEvent: CountryLifecycleEventRow | null;
}): number {
  const result = stmtInsertCountryLifecyclePromotionAudit.run({
    sim_year: input.simYear,
    effective_sim_year: input.effectiveSimYear,
    transition_key: input.transitionKey,
    transition_version: input.transitionVersion,
    actor_country: input.actorCountry,
    confidence: input.confidence,
    status: input.status,
    severity: input.severity,
    decision: input.decision,
    reason: input.reason,
    dry_run: input.dryRun ? 1 : 0,
    before_event_json: input.beforeEvent ? JSON.stringify(input.beforeEvent) : "",
    after_event_json: input.afterEvent ? JSON.stringify(input.afterEvent) : "",
  });
  return Number(result.lastInsertRowid);
}

export function getCountryLifecyclePromotionAuditByYear(simYear: number): CountryLifecyclePromotionAuditRow[] {
  const rows = stmtGetCountryLifecyclePromotionAuditByYear.all(simYear) as any[];
  return rows.map(mapCountryLifecyclePromotionAuditRow);
}

export function rollbackCountryLifecyclePromotionAuditById(auditId: number): {
  ok: boolean;
  reason: string;
  audit: CountryLifecyclePromotionAuditRow | null;
} {
  const row = stmtGetCountryLifecyclePromotionAuditById.get(auditId) as any;
  if (!row) {
    return { ok: false, reason: "audit_not_found", audit: null };
  }
  const audit = mapCountryLifecyclePromotionAuditRow(row);
  if (audit.rolled_back) {
    return { ok: false, reason: "already_rolled_back", audit };
  }
  if (audit.decision !== "accepted_written") {
    return { ok: false, reason: "not_written_decision", audit };
  }

  const tx = db.transaction(() => {
    stmtDeleteCountryLifecycleEventForTransitionYear.run(
      audit.sim_year,
      audit.transition_key,
      audit.transition_version
    );
    if (audit.before_event) {
      stmtInsertCountryLifecycleEvent.run({
        sim_year: audit.before_event.sim_year,
        effective_sim_year: audit.before_event.effective_sim_year,
        transition_key: audit.before_event.transition_key,
        transition_version: audit.before_event.transition_version,
        actor_country: audit.before_event.actor_country,
        confidence: audit.before_event.confidence,
        summary: audit.before_event.summary,
        create_countries_json: JSON.stringify(audit.before_event.create_countries),
        deactivate_countries_json: JSON.stringify(audit.before_event.deactivate_countries),
        geometry_ops_json: JSON.stringify(audit.before_event.geometry_ops),
      });
    }
    stmtMarkCountryLifecyclePromotionAuditRolledBack.run(audit.id);
  });

  tx();
  const refreshed = stmtGetCountryLifecyclePromotionAuditById.get(auditId) as any;
  return {
    ok: true,
    reason: "rolled_back",
    audit: refreshed ? mapCountryLifecyclePromotionAuditRow(refreshed) : audit,
  };
}

export function getCountryLifecycleEventsUpToYear(simYear: number): CountryLifecycleEventRow[] {
  const rows = stmtGetCountryLifecycleEventsUpToYear.all(simYear) as any[];
  return rows.map(mapCountryLifecycleRow);
}

export function getCountryLifecycleEventsForYear(simYear: number): CountryLifecycleEventRow[] {
  const rows = stmtGetCountryLifecycleEventsForYear.all(simYear) as any[];
  return rows.map(mapCountryLifecycleRow);
}

export function getConfigValue(key: string): string | null {
  const row = stmtGetConfig.get(key) as any;
  return row?.value ?? null;
}

export function setConfigValue(key: string, value: string): void {
  stmtUpsertConfig.run({ key, value });
}

export function storeConquestAttempt(input: {
  country: string;
  requestedName: string;
  suggestions: string[];
  usedAi: boolean;
  status: "ok" | "invalid" | "rate_limited" | "error";
  error?: string;
  requesterIp: string;
}): number {
  const result = stmtInsertConquestAttempt.run({
    country: input.country,
    requested_name: input.requestedName,
    suggestions: JSON.stringify(input.suggestions),
    used_ai: input.usedAi ? 1 : 0,
    status: input.status,
    error: input.error ?? "",
    requester_ip: input.requesterIp,
  });
  return Number(result.lastInsertRowid);
}

export function getLatestConquestAttempt(
  country: string,
  requestedName: string
): ConquestAttempt | null {
  const row = stmtLatestConquestAttempt.get(country, requestedName) as any;
  if (!row) return null;
  return {
    ...row,
    used_ai: row.used_ai === 1,
    suggestions: JSON.parse(row.suggestions),
  };
}

export function getConquestAttemptById(id: number): ConquestAttempt | null {
  const row = stmtGetConquestAttemptById.get(id) as any;
  if (!row) return null;
  return {
    ...row,
    used_ai: row.used_ai === 1,
    suggestions: JSON.parse(row.suggestions),
  };
}

export function countConquestAttemptsByIpSince(
  requesterIp: string,
  sinceIsoDateTime: string
): number {
  const row = stmtCountConquestAttemptsByIpSince.get(requesterIp, sinceIsoDateTime) as any;
  return Number(row?.cnt ?? 0);
}

export function upsertConquestClaim(input: {
  country: string;
  requestedName: string;
  selectedName: string;
  priceCents: number;
  graceUntil: string;
  requesterIp: string;
  attemptId: number | null;
}): void {
  stmtUpsertConquestClaim.run({
    country: input.country,
    requested_name: input.requestedName,
    selected_name: input.selectedName,
    price_cents: input.priceCents,
    grace_until: input.graceUntil,
    requester_ip: input.requesterIp,
    attempt_id: input.attemptId,
  });
}

export function getConquestByCountry(country: string): ConquestRecord | null {
  const row = stmtGetConquestByCountry.get(country) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    country: row.country,
    requested_name: row.requested_name,
    selected_name: row.selected_name,
    price_cents: Number(row.price_cents ?? 20),
    grace_until: row.grace_until ?? "",
    requester_ip: row.requester_ip ?? "",
    attempt_id: row.attempt_id ?? null,
    created_at: row.created_at ?? "",
  };
}

export function getConquestNameMap(): Record<string, string> {
  const rows = stmtGetConquestNameMap.all() as { country: string; selected_name: string }[];
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (!row?.country || !row?.selected_name) continue;
    map[row.country] = row.selected_name;
  }
  return map;
}

export function createPaymentSession(input: {
  sessionId: string;
  country: string;
  requestedName: string;
  selectedName: string;
  requesterIp: string;
  amountCents: number;
  status: "created" | "authorized";
  providerPaymentId?: string;
  attemptId: number | null;
  expiresAt: string;
}): void {
  stmtInsertPaymentSession.run({
    session_id: input.sessionId,
    country: input.country,
    requested_name: input.requestedName,
    selected_name: input.selectedName,
    requester_ip: input.requesterIp,
    amount_cents: input.amountCents,
    status: input.status,
    provider_payment_id: input.providerPaymentId ?? "",
    attempt_id: input.attemptId,
    expires_at: input.expiresAt,
  });
}

export function getPaymentSessionById(sessionId: string): PaymentSessionRecord | null {
  const row = stmtGetPaymentSessionById.get(sessionId) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    session_id: row.session_id,
    country: row.country,
    requested_name: row.requested_name,
    selected_name: row.selected_name,
    requester_ip: row.requester_ip,
    amount_cents: Number(row.amount_cents),
    status: row.status,
    provider_payment_id: row.provider_payment_id ?? "",
    attempt_id: row.attempt_id ?? null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function updatePaymentSessionStatus(
  sessionId: string,
  status: PaymentSessionRecord["status"],
  providerPaymentId = ""
): void {
  stmtUpdatePaymentSessionStatus.run({
    session_id: sessionId,
    status,
    provider_payment_id: providerPaymentId,
  });
}

export function expireStalePaymentSessions(nowSqlDateTime: string): void {
  stmtExpirePaymentSessionsBefore.run(nowSqlDateTime);
}

export function countCapturedNonPayingConquestsByIp(requesterIp: string): number {
  const row = stmtCountCapturedNonPayingConquestsByIp.get(requesterIp) as any;
  return Number(row?.cnt ?? 0);
}

export function upsertConquestImage(input: {
  country: string;
  conquestId: number | null;
  paymentSessionId: string;
  originalObjectKey: string;
  styledObjectKey: string;
  originalUrl: string;
  styledUrl: string;
  moderationStatus: "approved" | "rejected" | "failed";
  moderationReason: string;
  moderationLabels: string[];
  providerModel: string;
}): void {
  stmtUpsertConquestImage.run({
    country: input.country,
    conquest_id: input.conquestId,
    payment_session_id: input.paymentSessionId,
    original_object_key: input.originalObjectKey,
    styled_object_key: input.styledObjectKey,
    original_url: input.originalUrl,
    styled_url: input.styledUrl,
    moderation_status: input.moderationStatus,
    moderation_reason: input.moderationReason,
    moderation_labels: JSON.stringify(input.moderationLabels),
    provider_model: input.providerModel,
  });
}

export function getConquestImageByCountry(country: string): ConquestImageRecord | null {
  const row = stmtGetConquestImageByCountry.get(country) as any;
  if (!row) return null;
  return {
    country: row.country,
    styled_url: row.styled_url ?? "",
    moderation_status: row.moderation_status ?? "",
    moderation_reason: row.moderation_reason ?? "",
    moderation_labels: JSON.parse(row.moderation_labels ?? "[]"),
    updated_at: row.updated_at ?? "",
  };
}

export function getConquestImageMap(): Record<string, string> {
  const rows = stmtGetConquestImageMap.all() as Array<{ country: string; styled_url: string }>;
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (!row.country || !row.styled_url) continue;
    map[row.country] = row.styled_url;
  }
  return map;
}

export function upsertImageJob(input: {
  country: string;
  paymentSessionId: string;
  originalObjectKey: string;
  status: "queued" | "processing" | "approved" | "rejected" | "failed";
  attempts: number;
  error: string;
}): void {
  stmtUpsertImageJob.run({
    country: input.country,
    payment_session_id: input.paymentSessionId,
    original_object_key: input.originalObjectKey,
    status: input.status,
    attempts: input.attempts,
    error: input.error,
  });
}

export function getImageJobBySession(paymentSessionId: string): {
  id: number;
  country: string;
  payment_session_id: string;
  original_object_key: string;
  status: string;
  attempts: number;
  error: string;
  created_at: string;
  updated_at: string;
} | null {
  const row = stmtGetImageJobBySession.get(paymentSessionId) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    country: row.country,
    payment_session_id: row.payment_session_id,
    original_object_key: row.original_object_key,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    error: row.error ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJsonParseObject<T extends Record<string, unknown>>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {}
  return fallback;
}

function toIsoDateTime(input: number | string): string {
  if (typeof input === "number") return new Date(input).toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

export function insertAnalyticsEvents(input: {
  sessionId: string;
  events: AnalyticsEventInput[];
  fallbackSimYear?: number | null;
}): number {
  if (!input.sessionId || input.events.length === 0) return 0;
  const tx = db.transaction(() => {
    let inserted = 0;
    for (const ev of input.events) {
      const name = typeof ev.name === "string" ? ev.name.trim() : "";
      if (!name) continue;
      const payload = {
        session_id: input.sessionId,
        event_name: name.slice(0, 80),
        sim_year:
          typeof ev.simYear === "number"
            ? ev.simYear
            : typeof input.fallbackSimYear === "number"
              ? input.fallbackSimYear
              : null,
        country: typeof ev.country === "string" ? ev.country.trim().slice(0, 80) : "",
        props_json: JSON.stringify(ev.props ?? {}),
        event_ts: toIsoDateTime(ev.ts),
      };
      stmtInsertAnalyticsEvent.run(payload);
      inserted++;
    }
    return inserted;
  });
  return tx();
}

export function getAnalyticsEventsByYear(simYear: number): AnalyticsEventRow[] {
  const rows = stmtGetAnalyticsEventsByYear.all(simYear) as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    session_id: row.session_id,
    event_name: row.event_name,
    sim_year: typeof row.sim_year === "number" ? row.sim_year : null,
    country: row.country ?? "",
    props: safeJsonParseObject(row.props_json ?? "{}", {}),
    event_ts: row.event_ts,
    created_at: row.created_at,
  }));
}

export function insertLlmCallEvent(input: LlmCallEventInput): void {
  const feature = typeof input.feature === "string" ? input.feature.trim().slice(0, 80) : "";
  const provider = typeof input.provider === "string" ? input.provider.trim().slice(0, 40) : "";
  const status = typeof input.status === "string" ? input.status.trim().slice(0, 20) : "";
  if (!feature || !provider || !status) return;
  const eventTs = toIsoDateTime(input.ts ?? Date.now());
  const latencyMsRaw = Number(input.latencyMs ?? 0);
  const latencyMs = Number.isFinite(latencyMsRaw) && latencyMsRaw > 0 ? Math.round(latencyMsRaw) : 0;
  stmtInsertLlmCallEvent.run({
    event_ts: eventTs,
    event_date: eventTs.slice(0, 10),
    sim_year: typeof input.simYear === "number" ? input.simYear : null,
    feature,
    provider,
    model: typeof input.model === "string" ? input.model.trim().slice(0, 120) : "",
    country: typeof input.country === "string" ? input.country.trim().slice(0, 80) : "",
    status,
    latency_ms: latencyMs,
    error_category: typeof input.errorCategory === "string" ? input.errorCategory.trim().slice(0, 80) : "",
    error_message: typeof input.errorMessage === "string" ? input.errorMessage.trim().slice(0, 280) : "",
    meta_json: JSON.stringify(input.meta ?? {}),
  });
}

export function getRecentLlmCallEvents(days = 14): LlmCallEventRow[] {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 14;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = stmtGetRecentLlmCallEvents.all(since) as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    event_ts: row.event_ts,
    event_date: row.event_date,
    sim_year: typeof row.sim_year === "number" ? row.sim_year : null,
    feature: row.feature ?? "",
    provider: row.provider ?? "",
    model: row.model ?? "",
    country: row.country ?? "",
    status: row.status ?? "error",
    latency_ms: Number(row.latency_ms ?? 0),
    error_category: row.error_category ?? "",
    error_message: row.error_message ?? "",
    meta: safeJsonParseObject(row.meta_json ?? "{}", {}),
    created_at: row.created_at,
  }));
}

export function upsertDailyScore(input: {
  simYear: number;
  country: string;
  interesting: number;
  novelty: number;
  viral: number;
  interestingComponents?: Record<string, number>;
  noveltyComponents?: Record<string, number>;
  viralComponents?: Record<string, number>;
}): void {
  stmtUpsertDailyScore.run({
    sim_year: input.simYear,
    country: input.country,
    interesting: input.interesting,
    novelty: input.novelty,
    viral: input.viral,
    interesting_components_json: JSON.stringify(input.interestingComponents ?? {}),
    novelty_components_json: JSON.stringify(input.noveltyComponents ?? {}),
    viral_components_json: JSON.stringify(input.viralComponents ?? {}),
  });
}

export function getDailyScoresByYear(simYear: number): DailyScoreRow[] {
  const rows = stmtGetDailyScoresByYear.all(simYear) as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    country: row.country,
    interesting: Number(row.interesting),
    novelty: Number(row.novelty),
    viral: Number(row.viral),
    interesting_components: safeJsonParseObject(row.interesting_components_json ?? "{}", {}),
    novelty_components: safeJsonParseObject(row.novelty_components_json ?? "{}", {}),
    viral_components: safeJsonParseObject(row.viral_components_json ?? "{}", {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getDailyScoreByYearCountry(simYear: number, country: string): DailyScoreRow | null {
  const row = stmtGetDailyScoreByYearCountry.get(simYear, country) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    sim_year: Number(row.sim_year),
    country: row.country,
    interesting: Number(row.interesting),
    novelty: Number(row.novelty),
    viral: Number(row.viral),
    interesting_components: safeJsonParseObject(row.interesting_components_json ?? "{}", {}),
    novelty_components: safeJsonParseObject(row.novelty_components_json ?? "{}", {}),
    viral_components: safeJsonParseObject(row.viral_components_json ?? "{}", {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function insertShareEvent(input: {
  shareId: string;
  sessionId?: string;
  simYear?: number | null;
  country?: string;
  channel?: string;
  status: ShareEventStatus;
  deepLinkToken?: string;
}): boolean {
  const result = stmtInsertShareEvent.run({
    share_id: input.shareId,
    session_id: input.sessionId ?? "",
    sim_year: typeof input.simYear === "number" ? input.simYear : null,
    country: input.country ?? "",
    channel: input.channel ?? "x",
    status: input.status,
    deep_link_token: input.deepLinkToken ?? "",
  });
  return result.changes > 0;
}

export function countDistinctShareEventsByYearStatus(simYear: number, status: ShareEventStatus): number {
  const row = stmtCountDistinctShareByYearStatus.get(simYear, status) as any;
  return Number(row?.count ?? 0);
}

export function findInitiatedShareByDeepLinkToken(token: string): ShareEventRow | null {
  const row = stmtFindShareByToken.get(token) as any;
  if (!row) return null;
  return {
    id: Number(row.id),
    share_id: row.share_id,
    session_id: row.session_id,
    sim_year: typeof row.sim_year === "number" ? row.sim_year : null,
    country: row.country ?? "",
    channel: row.channel ?? "x",
    status: row.status,
    deep_link_token: row.deep_link_token ?? "",
    created_at: row.created_at,
  };
}

export function getRecentConquestsSince(sinceIsoDate: string): Array<{
  country: string;
  selectedName: string;
  createdAt: string;
}> {
  const rows = db
    .prepare(
      `SELECT country, selected_name, created_at FROM country_conquests
       WHERE created_at >= ? ORDER BY created_at DESC LIMIT 20`
    )
    .all(sinceIsoDate) as any[];
  return rows.map((r) => ({
    country: r.country,
    selectedName: r.selected_name,
    createdAt: r.created_at,
  }));
}

export type ConquestTier = "bronze" | "silver" | "gold" | "platinum";

function conquestCountToTier(count: number): ConquestTier {
  if (count >= 5) return "platinum";
  if (count >= 3) return "gold";
  if (count >= 2) return "silver";
  return "bronze";
}

export function getConquestTierMap(): Record<string, ConquestTier> {
  const rows = db
    .prepare(
      `SELECT country, COUNT(1) AS cnt
       FROM conquest_payment_sessions
       WHERE status = 'captured'
       GROUP BY country`
    )
    .all() as Array<{ country: string; cnt: number }>;
  const result: Record<string, ConquestTier> = {};
  for (const row of rows) {
    if (row.country) {
      result[row.country] = conquestCountToTier(Number(row.cnt));
    }
  }
  return result;
}

export interface LeaderboardRawData {
  activeZoneControllers: Array<{ zone_key: string; controller_country: string; sim_year: number }>;
  conquestCounts: Array<{ country: string; total_conquests: number }>;
  noveltyScores: Array<{ country: string; novelty: number; sim_year: number }>;
}

export function getLeaderboardRawData(simYearNow: number): LeaderboardRawData {
  const activeZoneControllers = db
    .prepare(
      `WITH ranked AS (
        SELECT
          zone_key,
          controller_country,
          sim_year,
          ROW_NUMBER() OVER (
            PARTITION BY zone_key
            ORDER BY sim_year DESC, id DESC
          ) AS row_rank
        FROM territory_events
        WHERE ? <= (sim_year + retention_years)
      )
      SELECT zone_key, controller_country, sim_year
      FROM ranked
      WHERE row_rank = 1`
    )
    .all(simYearNow) as Array<{ zone_key: string; controller_country: string; sim_year: number }>;

  const conquestCounts = db
    .prepare(
      `SELECT country, COUNT(1) AS total_conquests
       FROM conquest_payment_sessions
       WHERE status = 'captured'
       GROUP BY country`
    )
    .all() as Array<{ country: string; total_conquests: number }>;

  const noveltyScores = db
    .prepare(
      `SELECT country, novelty, sim_year
       FROM daily_scores
       WHERE sim_year = (SELECT MAX(sim_year) FROM daily_scores WHERE sim_year <= ?)
       ORDER BY novelty DESC`
    )
    .all(simYearNow) as Array<{ country: string; novelty: number; sim_year: number }>;

  return { activeZoneControllers, conquestCounts, noveltyScores };
}

export interface FrontlineZoneSnapshot {
  zoneKey: string;
  controllerCountry: string;
  lostByCountry: string;
  status: string;
  severity: string;
  summary: string;
  simYear: number;
}

/** Returns the distinct sim_years that have territory events, plus all events. */
const stmtGetActiveZoneLostBy = db.prepare(`
  WITH ranked AS (
    SELECT zone_key, lost_by_country,
      ROW_NUMBER() OVER (PARTITION BY zone_key ORDER BY sim_year DESC, id DESC) AS rn
    FROM territory_events WHERE ? <= (sim_year + retention_years)
  ) SELECT zone_key, lost_by_country FROM ranked WHERE rn = 1
`);

export function getActiveZoneLostByCountry(simYear: number): Array<{ zone_key: string; lost_by_country: string }> {
  return stmtGetActiveZoneLostBy.all(simYear) as Array<{ zone_key: string; lost_by_country: string }>;
}

const stmtGetLatestNoveltyScore = db.prepare(`
  SELECT novelty FROM daily_scores
  WHERE country = ? AND sim_year = (SELECT MAX(sim_year) FROM daily_scores WHERE sim_year <= ?)
  LIMIT 1
`);

export function getLatestNoveltyScore(country: string, maxSimYear: number): number {
  const row = stmtGetLatestNoveltyScore.get(country, maxSimYear) as { novelty: number } | undefined;
  return row ? Number(row.novelty) : 0;
}

export function getFrontlineHistory(): { years: number[]; events: FrontlineZoneSnapshot[] } {
  const rows = db
    .prepare(
      `SELECT DISTINCT sim_year FROM territory_events ORDER BY sim_year ASC`
    )
    .all() as Array<{ sim_year: number }>;

  const years = rows.map((r) => Number(r.sim_year));

  const eventRows = db
    .prepare(
      `SELECT zone_key, controller_country, lost_by_country, status, severity, summary, sim_year
       FROM territory_events
       ORDER BY sim_year ASC, id ASC`
    )
    .all() as Array<{
      zone_key: string;
      controller_country: string;
      lost_by_country: string;
      status: string;
      severity: string;
      summary: string;
      sim_year: number;
    }>;

  const events: FrontlineZoneSnapshot[] = eventRows.map((r) => ({
    zoneKey: r.zone_key,
    controllerCountry: r.controller_country,
    lostByCountry: r.lost_by_country,
    status: r.status,
    severity: r.severity,
    summary: r.summary,
    simYear: Number(r.sim_year),
  }));

  return { years, events };
}

// ── God Interventions ────────────────────────────────────────────────────────

export interface GodInterventionRow {
  id: number;
  user_name: string;
  target_country: string;
  event_type: 'COUP' | 'BOOM' | 'DISASTER';
  sim_year_triggered: number;
  duration_years: number;
  status: 'active' | 'expired';
  payment_session_id: string;
  created_at: string;
}

export function insertGodIntervention(input: {
  userName: string;
  targetCountry: string;
  eventType: 'COUP' | 'BOOM' | 'DISASTER';
  simYearTriggered: number;
  durationYears?: number;
  paymentSessionId: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO god_interventions
         (user_name, target_country, event_type, sim_year_triggered, duration_years, payment_session_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.userName,
      input.targetCountry,
      input.eventType,
      input.simYearTriggered,
      input.durationYears ?? 1,
      input.paymentSessionId
    );
  return Number(result.lastInsertRowid);
}

export function getActiveInterventionsForYear(simYear: number): GodInterventionRow[] {
  return db
    .prepare(
      `SELECT * FROM god_interventions
       WHERE status = 'active'
         AND sim_year_triggered + duration_years > ?
       ORDER BY created_at ASC`
    )
    .all(simYear - 1) as GodInterventionRow[];
}

export function expireOldInterventions(simYear: number): void {
  db.prepare(
    `UPDATE god_interventions
     SET status = 'expired'
     WHERE status = 'active'
       AND sim_year_triggered + duration_years <= ?`
  ).run(simYear - 1);
}

// ── Lore Injections ──────────────────────────────────────────────────────────

export type LoreInjectionType = 'CULTURAL_QUIRK' | 'MILITARY_UNIT' | 'MOTTO';

export interface LoreInjectionRow {
  id: number;
  country: string;
  user_name: string;
  injection_type: LoreInjectionType;
  content: string;
  payment_session_id: string;
  created_at: string;
}

export interface PendingLoreCheckoutRow {
  session_id: string;
  country: string;
  user_name: string;
  injection_type: LoreInjectionType;
  content: string;
  expires_at: string;
  created_at: string;
}

const stmtInsertLoreInjection = db.prepare(`
  INSERT INTO lore_injections (country, user_name, injection_type, content, payment_session_id)
  VALUES (@country, @user_name, @injection_type, @content, @payment_session_id)
`);

const stmtGetLoreInjectionsForCountry = db.prepare(`
  SELECT id, country, user_name, injection_type, content, payment_session_id, created_at
  FROM lore_injections
  WHERE country = ?
  ORDER BY created_at ASC
`);

const stmtGetAllActiveLoreInjections = db.prepare(`
  SELECT id, country, user_name, injection_type, content, payment_session_id, created_at
  FROM lore_injections
  ORDER BY country ASC, created_at ASC
`);

const stmtGetRecentLoreInjections = db.prepare(`
  SELECT id, country, user_name, injection_type, content, created_at
  FROM lore_injections
  ORDER BY created_at DESC
  LIMIT 100
`);

const stmtInsertPendingLoreCheckout = db.prepare(`
  INSERT INTO pending_lore_checkouts (
    session_id,
    country,
    user_name,
    injection_type,
    content,
    expires_at
  )
  VALUES (
    @session_id,
    @country,
    @user_name,
    @injection_type,
    @content,
    @expires_at
  )
`);

const stmtGetPendingLoreCheckoutBySession = db.prepare(`
  SELECT session_id, country, user_name, injection_type, content, expires_at, created_at
  FROM pending_lore_checkouts
  WHERE session_id = ?
`);

const stmtDeletePendingLoreCheckout = db.prepare(`
  DELETE FROM pending_lore_checkouts
  WHERE session_id = ?
`);

const stmtExpirePendingLoreCheckoutsBefore = db.prepare(`
  DELETE FROM pending_lore_checkouts
  WHERE expires_at < ?
`);

function mapLoreRow(row: any): LoreInjectionRow {
  return {
    id: Number(row.id),
    country: String(row.country || ''),
    user_name: String(row.user_name || ''),
    injection_type: row.injection_type as LoreInjectionType,
    content: String(row.content || ''),
    payment_session_id: String(row.payment_session_id || ''),
    created_at: String(row.created_at || ''),
  };
}

function mapPendingLoreCheckoutRow(row: any): PendingLoreCheckoutRow {
  return {
    session_id: String(row.session_id || ''),
    country: String(row.country || ''),
    user_name: String(row.user_name || ''),
    injection_type: row.injection_type as LoreInjectionType,
    content: String(row.content || ''),
    expires_at: String(row.expires_at || ''),
    created_at: String(row.created_at || ''),
  };
}

export function insertLoreInjection(input: {
  country: string;
  userName: string;
  injectionType: LoreInjectionType;
  content: string;
  paymentSessionId: string;
}): number {
  const result = stmtInsertLoreInjection.run({
    country: input.country,
    user_name: input.userName,
    injection_type: input.injectionType,
    content: input.content,
    payment_session_id: input.paymentSessionId,
  });
  return Number(result.lastInsertRowid);
}

export function getLoreInjectionsForCountry(country: string): LoreInjectionRow[] {
  const rows = stmtGetLoreInjectionsForCountry.all(country) as any[];
  return rows.map(mapLoreRow);
}

export function getAllActiveLoreInjections(): LoreInjectionRow[] {
  const rows = stmtGetAllActiveLoreInjections.all() as any[];
  return rows.map(mapLoreRow);
}

export function getRecentLoreInjections(): Array<{ id: number; country: string; userName: string; injectionType: string; content: string; createdAt: string }> {
  const rows = stmtGetRecentLoreInjections.all() as any[];
  return rows.map((row: any) => ({
    id: Number(row.id),
    country: String(row.country || ''),
    userName: String(row.user_name || ''),
    injectionType: String(row.injection_type || ''),
    content: String(row.content || ''),
    createdAt: String(row.created_at || ''),
  }));
}

export function createPendingLoreCheckout(input: {
  sessionId: string;
  country: string;
  userName: string;
  injectionType: LoreInjectionType;
  content: string;
  expiresAt: string;
}): void {
  stmtInsertPendingLoreCheckout.run({
    session_id: input.sessionId,
    country: input.country,
    user_name: input.userName,
    injection_type: input.injectionType,
    content: input.content,
    expires_at: input.expiresAt,
  });
}

export function getPendingLoreCheckoutBySession(sessionId: string): PendingLoreCheckoutRow | null {
  const row = stmtGetPendingLoreCheckoutBySession.get(sessionId) as any;
  if (!row) return null;
  return mapPendingLoreCheckoutRow(row);
}

export function deletePendingLoreCheckout(sessionId: string): void {
  stmtDeletePendingLoreCheckout.run(sessionId);
}

export function expirePendingLoreCheckouts(nowSqlDateTime: string): void {
  stmtExpirePendingLoreCheckoutsBefore.run(nowSqlDateTime);
}

// ── Civil Wars ────────────────────────────────────────────────────────────────

export type CivilWarStatus = 'active' | 'defender_won' | 'challenger_won';

export interface CivilWarRow {
  id: number;
  country: string;
  defender_name: string;
  challenger_name: string;
  start_sim_year: number;
  end_sim_year: number;
  status: CivilWarStatus;
  payment_session_id: string;
  zone_key: string | null;
  created_at: string;
}

export function insertCivilWar(input: {
  country: string;
  defenderName: string;
  challengerName: string;
  startSimYear: number;
  endSimYear: number;
  paymentSessionId: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO civil_wars (country, defender_name, challenger_name, start_sim_year, end_sim_year, payment_session_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.country,
      input.defenderName,
      input.challengerName,
      input.startSimYear,
      input.endSimYear,
      input.paymentSessionId
    );
  return Number(result.lastInsertRowid);
}

export function getActiveCivilWarsForYear(simYear: number): CivilWarRow[] {
  return db
    .prepare(
      `SELECT * FROM civil_wars
       WHERE status = 'active' AND start_sim_year <= ?
       ORDER BY created_at ASC`
    )
    .all(simYear) as CivilWarRow[];
}

export function getActiveCivilWarForCountry(country: string): CivilWarRow | null {
  const row = db
    .prepare(
      `SELECT * FROM civil_wars
       WHERE status = 'active' AND country = ?
       LIMIT 1`
    )
    .get(country) as CivilWarRow | undefined;
  return row ?? null;
}

export function resolveCivilWar(id: number, winner: 'defender' | 'challenger'): void {
  const status: CivilWarStatus = winner === 'defender' ? 'defender_won' : 'challenger_won';
  db.prepare(`UPDATE civil_wars SET status = ? WHERE id = ?`).run(status, id);
}

export function setCivilWarZoneKey(id: number, zoneKey: string): void {
  db.prepare(`UPDATE civil_wars SET zone_key = ? WHERE id = ?`).run(zoneKey, id);
}

/**
 * Returns the most recently resolved civil war for a country if it ended
 * within the last `cooldownYears` sim years (inclusive). Used for post-war
 * conquest cooldown.
 */
export function getRecentlyResolvedCivilWar(
  country: string,
  currentSimYear: number,
  cooldownYears = 3
): CivilWarRow | null {
  const row = db
    .prepare(
      `SELECT * FROM civil_wars
       WHERE country = ?
         AND status IN ('defender_won', 'challenger_won')
         AND end_sim_year >= ?
       ORDER BY end_sim_year DESC
       LIMIT 1`
    )
    .get(country, currentSimYear - cooldownYears) as CivilWarRow | undefined;
  return row ?? null;
}

// ── Sim Year Summaries ────────────────────────────────────────────────────────

export interface SimYearSummaryRow {
  simYear: number;
  summary: string;
  keyEvents: string[];
  createdAt: string;
}

const stmtGetSimYearSummary = db.prepare(`
  SELECT sim_year, summary, key_events, created_at
  FROM sim_year_summaries
  WHERE sim_year = ?
  LIMIT 1
`);

const stmtUpsertSimYearSummary = db.prepare(`
  INSERT INTO sim_year_summaries (sim_year, summary, key_events)
  VALUES (@sim_year, @summary, @key_events)
  ON CONFLICT(sim_year) DO UPDATE SET
    summary    = @summary,
    key_events = @key_events,
    created_at = datetime('now')
`);

export function getSimYearSummary(simYear: number): SimYearSummaryRow | null {
  const row = stmtGetSimYearSummary.get(simYear) as any;
  if (!row) return null;
  let keyEvents: string[] = [];
  try {
    const parsed = JSON.parse(row.key_events || '[]');
    if (Array.isArray(parsed)) {
      keyEvents = parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {}
  return {
    simYear: Number(row.sim_year),
    summary: String(row.summary || ''),
    keyEvents,
    createdAt: String(row.created_at || ''),
  };
}

export function upsertSimYearSummary(simYear: number, summary: string, keyEvents: string[]): void {
  stmtUpsertSimYearSummary.run({
    sim_year: simYear,
    summary,
    key_events: JSON.stringify(keyEvents),
  });
}

export function getTopHeadlinesForYear(simYear: number, limit = 20): Array<{ country: string; headline: string; tone: string }> {
  const rows = db
    .prepare(
      `SELECT country, headline, tone
       FROM sim_news
       WHERE sim_year = ?
         AND tone IN ('ALARMING','TENSE','SIGNIFICANT')
       ORDER BY CASE tone WHEN 'ALARMING' THEN 0 WHEN 'TENSE' THEN 1 ELSE 2 END, id ASC
       LIMIT ?`
    )
    .all(simYear, limit) as Array<{ country: string; headline: string; tone: string }>;
  return rows;
}

export function getTerritoryEventsForYear(simYear: number): Array<{ controllerCountry: string; lostByCountry: string; zoneKey: string; status: string }> {
  const rows = db
    .prepare(
      `SELECT controller_country, lost_by_country, zone_key, status
       FROM territory_events
       WHERE sim_year = ?
       ORDER BY id ASC`
    )
    .all(simYear) as Array<{ controller_country: string; lost_by_country: string; zone_key: string; status: string }>;
  return rows.map((r) => ({
    controllerCountry: r.controller_country,
    lostByCountry: r.lost_by_country,
    zoneKey: r.zone_key,
    status: r.status,
  }));
}

export { db };
