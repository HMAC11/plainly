CREATE TABLE IF NOT EXISTS articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  section      text NOT NULL CHECK (section IN ('aus','world','us','biz','tech','pol','crypto')),
  flag         text NOT NULL DEFAULT 'News',
  headline     text NOT NULL,
  deck         text NOT NULL DEFAULT '',
  body_html    text NOT NULL DEFAULT '',
  sources      jsonb NOT NULL DEFAULT '[]',
  terms        jsonb NOT NULL DEFAULT '[]',
  image_colors jsonb NOT NULL DEFAULT '["#2d4a6b","#1a3347"]',
  original_url text,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_section_idx ON articles (section, published_at DESC);
CREATE INDEX IF NOT EXISTS articles_published_idx ON articles (published_at DESC);

ALTER TABLE articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access"
  ON articles FOR SELECT
  USING (true);
