-- +goose Up
-- Lending ("Verliehen"): who has the entity, since when and when it is due back.
-- An entity counts as lent while lent_to is non-empty.
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "lent_to" character varying NULL;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "lent_date" timestamptz NULL;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "lent_return_date" timestamptz NULL;

CREATE INDEX IF NOT EXISTS "entity_lent_to" ON "entities" ("lent_to");
