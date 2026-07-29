-- DealWorld 2.0 schema
-- Run once against your Postgres/Supabase database (see README for how).

CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  type            TEXT NOT NULL CHECK (type IN ('buyer','seller')),
  source          TEXT,
  listing_ref     TEXT,
  stage           TEXT NOT NULL DEFAULT 'New Lead',
  outcome         TEXT CHECK (outcome IN ('won','lost') OR outcome IS NULL),
  owner           TEXT DEFAULT 'Max',
  gmail_thread_id TEXT,
  buyer_industry_pref   TEXT,
  buyer_price_range     TEXT,
  buyer_financing_type  TEXT,
  address_released_at   TIMESTAMPTZ,
  description     TEXT,
  last_contact_at TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- The businesses for sale themselves, separate from the seller's own contact
-- record, since one seller can have a listing and many buyer leads can point
-- at it. Created after `leads` (seller_lead_id references it), and `leads`
-- gets its listing_id column added after this table exists, to avoid a
-- circular foreign key at creation time.
CREATE TABLE IF NOT EXISTS listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  industry      TEXT,
  asking_price  TEXT,
  status        TEXT NOT NULL DEFAULT 'Active', -- Active | Under Contract | Closed | Withdrawn
  seller_lead_id UUID REFERENCES leads(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS listing_id UUID REFERENCES listings(id);

-- Links to wherever a listing is posted (BizBuySell, your own site, other marketplaces).
CREATE TABLE IF NOT EXISTS listing_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID REFERENCES listings(id) ON DELETE CASCADE,
  label       TEXT,
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type  TEXT NOT NULL,        -- 'lead' | 'provisor' | 'contact'
  record_id    UUID NOT NULL,
  author       TEXT DEFAULT 'Max',
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type    TEXT NOT NULL,      -- 'lead'
  record_id      UUID NOT NULL,
  title          TEXT NOT NULL,
  due_date       DATE,
  assignee       TEXT DEFAULT 'Max',
  status         TEXT NOT NULL DEFAULT 'open', -- open | done
  auto_generated BOOLEAN DEFAULT false,
  source_message_id UUID,            -- links back to communications.id if AI generated it
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID REFERENCES leads(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,  -- NDA | Marketing | CIM | APA | LOI
  boldsign_envelope_id TEXT,
  status             TEXT DEFAULT 'sent', -- sent | viewed | signed | declined
  file_url           TEXT,
  sent_at            TIMESTAMPTZ DEFAULT now(),
  viewed_at          TIMESTAMPTZ,
  signed_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID REFERENCES leads(id) ON DELETE CASCADE,
  section           TEXT NOT NULL,   -- e.g. 'Due Diligence'
  item              TEXT NOT NULL,
  due_date          DATE,
  responsible_party TEXT,            -- Buyer | Seller | Advisor | Closing Attorney
  status            TEXT DEFAULT 'Open', -- Open | Complete | Late | N/A
  comments          TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  details       TEXT,
  linkedin      TEXT,
  category      TEXT DEFAULT 'General',
  photo_url     TEXT,
  linked_lead_id UUID REFERENCES leads(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provisors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID REFERENCES contacts(id) ON DELETE CASCADE,
  specialty   TEXT,
  tags        TEXT[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provisor_troikas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provisor_id UUID REFERENCES provisors(id) ON DELETE CASCADE,
  event_date  DATE NOT NULL,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS provisor_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provisor_id   UUID REFERENCES provisors(id) ON DELETE CASCADE,
  direction     TEXT CHECK (direction IN ('Sent','Received')),
  note          TEXT,
  linked_lead_id UUID REFERENCES leads(id),
  event_date    DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS communications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type   TEXT NOT NULL,       -- 'lead'
  record_id     UUID NOT NULL,
  channel       TEXT NOT NULL,       -- email | text | call | meeting
  direction     TEXT NOT NULL,       -- inbound | outbound
  subject       TEXT,
  body          TEXT,
  classification TEXT,               -- interested | not_interested | needs_info | out_of_office | wrong_person | null
  gmail_message_id TEXT,
  twilio_sid    TEXT,
  transcript_url TEXT,
  summary       TEXT,
  occurred_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS newsletters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject         TEXT,
  body            TEXT,
  recipient_group TEXT,               -- all_buyers | all_sellers | all_contacts | all_provisors | custom
  status          TEXT DEFAULT 'draft',
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_communications_record ON communications(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_tasks_record ON tasks(record_type, record_id);
