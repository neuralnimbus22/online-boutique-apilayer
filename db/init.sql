-- Idempotent schema for the apilayer demo service.
-- Safe to run on every startup — only creates the products table if missing.

CREATE TABLE IF NOT EXISTS products (
  id         SERIAL PRIMARY KEY,
  name       TEXT      NOT NULL,
  price      NUMERIC   NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
