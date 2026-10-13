-- +goose Up
-- Lending ("Verliehen"): who has the entity, since when and when it is due back.
-- An entity counts as lent while lent_to is non-empty.
alter table entities add column lent_to text;
alter table entities add column lent_date datetime;
alter table entities add column lent_return_date datetime;

create index if not exists entity_lent_to on entities (lent_to);
