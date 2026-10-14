package repo

// Fork: recycle bin ("Papierkorb") for items and locations.
//
// Deleting an entity moves it, together with everything below it, into the
// trash instead of removing it for good. The rows of the entity subtree and of
// the tables hanging off it (custom fields, attachments, maintenance entries,
// tag links) are copied as JSON into trash_entries and then deleted. Attachment
// files stay in storage, so a restore only has to insert the rows again, with
// their original IDs. Entries older than TrashRetention are purged together
// with files no other attachment uses.
//
// Rows are copied generically (SELECT * / INSERT of the columns that exist), so
// columns added upstream later do not need changes here. The table is created
// on first use and lives outside the ent schema.

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/sysadminsmedia/homebox/backend/internal/core/services/reporting/eventbus"
	"github.com/sysadminsmedia/homebox/backend/internal/data/ent"
	"gocloud.dev/blob"
)

// TrashRetention is how long deleted entities can be restored.
const TrashRetention = 30 * 24 * time.Hour

var ErrTrashEntityType = errors.New("the entity type of this entry no longer exists")

type TrashRepository struct {
	db          *ent.Client
	bus         *eventbus.EventBus
	attachments *AttachmentRepo
	ensureOnce  sync.Once
	ensureErr   error
	// Trash operations run one at a time: on SQLite two concurrent
	// read-then-write transactions would fail with SQLITE_BUSY.
	mu sync.Mutex
}

func NewTrashRepository(db *ent.Client, bus *eventbus.EventBus, attachments *AttachmentRepo) *TrashRepository {
	return &TrashRepository{db: db, bus: bus, attachments: attachments}
}

type TrashEntry struct {
	ID          uuid.UUID `json:"id"`
	RootID      uuid.UUID `json:"rootId"`
	Name        string    `json:"name"`
	IsLocation  bool      `json:"isLocation"`
	EntityCount int       `json:"entityCount"`
	ParentName  string    `json:"parentName"`
	DeletedAt   time.Time `json:"deletedAt"`
	PurgeAt     time.Time `json:"purgeAt"`
}

type trashLocationLink struct {
	ID     string `json:"id"`
	Target string `json:"target"`
}

type trashPayload struct {
	Version       int                         `json:"version"`
	ParentName    string                      `json:"parentName"`
	Tables        map[string][]map[string]any `json:"tables"`
	LocationLinks []trashLocationLink         `json:"locationLinks"`
	Extra         map[string]json.RawMessage  `json:"extra,omitempty"`
}

// Tables copied with the entity subtree, with the column that points at the entity.
var trashChildTables = []struct{ table, column string }{
	{"entity_fields", "entity_fields"},
	{"attachments", "entity_attachments"},
	{"maintenance_entries", "entity_id"},
	{"tag_entities", "entity_id"},
}

func (r *TrashRepository) ensureTable(ctx context.Context) error {
	r.ensureOnce.Do(func() {
		_, r.ensureErr = r.db.Sql().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS trash_entries (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			root_id TEXT NOT NULL,
			name TEXT NOT NULL,
			is_location BOOLEAN NOT NULL DEFAULT FALSE,
			entity_count INTEGER NOT NULL DEFAULT 1,
			deleted_at TIMESTAMP NOT NULL,
			payload TEXT NOT NULL
		)`)
		if r.ensureErr == nil {
			_, r.ensureErr = r.db.Sql().ExecContext(ctx,
				`CREATE INDEX IF NOT EXISTS trash_entries_group_deleted ON trash_entries (group_id, deleted_at)`)
		}
	})
	return r.ensureErr
}

// beginWrite starts a transaction that holds the write lock from its first
// statement, so SQLite waits for other writers (busy_timeout) instead of
// failing when this transaction later upgrades from reading to writing.
func (r *TrashRepository) beginWrite(ctx context.Context) (*sql.Tx, error) {
	tx, err := r.db.Sql().BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE trash_entries SET name = name WHERE 1 = 0"); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

// MoveToTrash deletes the entity and everything below it, keeping a copy that
// Restore can bring back.
func (r *TrashRepository) MoveToTrash(ctx context.Context, gid, id uuid.UUID) (TrashEntry, error) {
	if err := r.ensureTable(ctx); err != nil {
		return TrashEntry{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.purgeExpired(ctx, gid)

	tx, err := r.beginWrite(ctx)
	if err != nil {
		return TrashEntry{}, err
	}
	defer func() { _ = tx.Rollback() }()

	ids, err := subtreeIDs(ctx, tx, gid, id)
	if err != nil {
		return TrashEntry{}, err
	}
	if len(ids) == 0 {
		return TrashEntry{}, sql.ErrNoRows
	}

	p := trashPayload{Version: 1, Tables: map[string][]map[string]any{}}
	if p.Tables["entities"], err = selectRows(ctx, tx, "entities", "id", ids); err != nil {
		return TrashEntry{}, err
	}
	// selectRows returns the rows in key order; keep parents before children.
	p.Tables["entities"] = orderByIDs(p.Tables["entities"], ids)

	for _, ct := range trashChildTables {
		if p.Tables[ct.table], err = selectRows(ctx, tx, ct.table, ct.column, ids); err != nil {
			return TrashEntry{}, err
		}
	}
	// Thumbnails are attachment rows of their own, linked from the original.
	var thumbIDs []any
	for _, a := range p.Tables["attachments"] {
		if v := a["attachment_thumbnail"]; v != nil {
			thumbIDs = append(thumbIDs, v)
		}
	}
	thumbs, err := selectRows(ctx, tx, "attachments", "id", thumbIDs)
	if err != nil {
		return TrashEntry{}, err
	}
	p.Tables["attachments"] = append(thumbs, p.Tables["attachments"]...)

	// Entities outside the subtree whose location override points into it.
	links, err := selectRows(ctx, tx, "entities", "entity_location_entities", ids)
	if err != nil {
		return TrashEntry{}, err
	}
	inTree := map[string]bool{}
	for _, v := range ids {
		inTree[fmt.Sprint(v)] = true
	}
	for _, l := range links {
		if !inTree[fmt.Sprint(l["id"])] {
			p.LocationLinks = append(p.LocationLinks, trashLocationLink{ID: fmt.Sprint(l["id"]), Target: fmt.Sprint(l["entity_location_entities"])})
		}
	}

	root := p.Tables["entities"][0]
	name := fmt.Sprint(root["name"])
	if parent := root["entity_children"]; parent != nil {
		_ = tx.QueryRowContext(ctx, "SELECT name FROM entities WHERE id = $1", parent).Scan(&p.ParentName)
	}
	var isLocation bool
	_ = tx.QueryRowContext(ctx, "SELECT is_location FROM entity_types WHERE id = $1", root["entity_type_entities"]).Scan(&isLocation)

	// Delete: thumbnails, then the rows hanging off the entities, then the entities.
	if err := deleteRows(ctx, tx, "attachments", "id", thumbIDs); err != nil {
		return TrashEntry{}, err
	}
	for _, ct := range trashChildTables {
		if err := deleteRows(ctx, tx, ct.table, ct.column, ids); err != nil {
			return TrashEntry{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE entities SET entity_location_entities = NULL WHERE entity_location_entities IN ("+placeholders(1, len(ids))+")", ids...); err != nil {
		return TrashEntry{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE entities SET entity_children = NULL WHERE id IN ("+placeholders(1, len(ids))+")", ids...); err != nil {
		return TrashEntry{}, err
	}
	if err := deleteRows(ctx, tx, "entities", "id", ids); err != nil {
		return TrashEntry{}, err
	}

	payload, err := json.Marshal(encodePayload(p))
	if err != nil {
		return TrashEntry{}, err
	}
	entry := TrashEntry{
		ID:          uuid.New(),
		RootID:      id,
		Name:        name,
		IsLocation:  isLocation,
		EntityCount: len(ids),
		ParentName:  p.ParentName,
		DeletedAt:   time.Now().UTC(),
	}
	entry.PurgeAt = entry.DeletedAt.Add(TrashRetention)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO trash_entries (id, group_id, root_id, name, is_location, entity_count, deleted_at, payload)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		entry.ID.String(), gid.String(), id.String(), name, isLocation, len(ids), entry.DeletedAt, string(payload)); err != nil {
		return TrashEntry{}, err
	}
	if err := tx.Commit(); err != nil {
		return TrashEntry{}, err
	}
	r.publish(gid)
	return entry, nil
}

func (r *TrashRepository) List(ctx context.Context, gid uuid.UUID) ([]TrashEntry, error) {
	if err := r.ensureTable(ctx); err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.purgeExpired(ctx, gid)
	r.mu.Unlock()
	rows, err := r.db.Sql().QueryContext(ctx,
		`SELECT id, root_id, name, is_location, entity_count, deleted_at, payload
		 FROM trash_entries WHERE group_id = $1 ORDER BY deleted_at DESC`, gid.String())
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []TrashEntry{}
	for rows.Next() {
		var e TrashEntry
		var id, rootID, payload string
		if err := rows.Scan(&id, &rootID, &e.Name, &e.IsLocation, &e.EntityCount, &e.DeletedAt, &payload); err != nil {
			return nil, err
		}
		e.ID, _ = uuid.Parse(id)
		e.RootID, _ = uuid.Parse(rootID)
		e.PurgeAt = e.DeletedAt.Add(TrashRetention)
		var meta struct {
			ParentName string `json:"parentName"`
		}
		_ = json.Unmarshal([]byte(payload), &meta)
		e.ParentName = meta.ParentName
		out = append(out, e)
	}
	return out, rows.Err()
}

func (r *TrashRepository) load(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, gid, trashID uuid.UUID) (string, trashPayload, error) {
	var rootID, raw string
	err := q.QueryRowContext(ctx, `SELECT root_id, payload FROM trash_entries WHERE id = $1 AND group_id = $2`,
		trashID.String(), gid.String()).Scan(&rootID, &raw)
	if err != nil {
		return "", trashPayload{}, err
	}
	p, err := decodePayload(raw)
	return rootID, p, err
}

// Restore puts the entries rows back with their original IDs and removes the
// trash entry. If the former parent is gone, the root is restored without one.
func (r *TrashRepository) Restore(ctx context.Context, gid, trashID uuid.UUID) (uuid.UUID, error) {
	if err := r.ensureTable(ctx); err != nil {
		return uuid.Nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	tx, err := r.beginWrite(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rootID, p, err := r.load(ctx, tx, gid, trashID)
	if err != nil {
		return uuid.Nil, err
	}

	exists := func(table string, id any) bool {
		if id == nil {
			return false
		}
		var one int
		return tx.QueryRowContext(ctx, "SELECT 1 FROM "+table+" WHERE id = $1", id).Scan(&one) == nil
	}

	entities := p.Tables["entities"]
	inTree := map[string]bool{}
	for _, e := range entities {
		inTree[fmt.Sprint(e["id"])] = true
	}
	for _, e := range entities {
		if !exists("entity_types", e["entity_type_entities"]) {
			return uuid.Nil, ErrTrashEntityType
		}
		if v := e["entity_children"]; v != nil && !inTree[fmt.Sprint(v)] && !exists("entities", v) {
			e["entity_children"] = nil
		}
		if v := e["entity_location_entities"]; v != nil && !inTree[fmt.Sprint(v)] && !exists("entities", v) {
			e["entity_location_entities"] = nil
		}
		e["group_entities"] = gid.String()
	}
	if err := insertRows(ctx, tx, "entities", entities); err != nil {
		return uuid.Nil, err
	}
	if err := insertRows(ctx, tx, "entity_fields", p.Tables["entity_fields"]); err != nil {
		return uuid.Nil, err
	}

	// Attachments: insert without the thumbnail link first, then link them up.
	atts := p.Tables["attachments"]
	thumbOf := map[string]any{}
	for _, a := range atts {
		if v := a["attachment_thumbnail"]; v != nil {
			thumbOf[fmt.Sprint(a["id"])] = v
			a["attachment_thumbnail"] = nil
		}
	}
	if err := insertRows(ctx, tx, "attachments", atts); err != nil {
		return uuid.Nil, err
	}
	for id, thumb := range thumbOf {
		if _, err := tx.ExecContext(ctx, "UPDATE attachments SET attachment_thumbnail = $1 WHERE id = $2", thumb, id); err != nil {
			return uuid.Nil, err
		}
	}

	if err := insertRows(ctx, tx, "maintenance_entries", p.Tables["maintenance_entries"]); err != nil {
		return uuid.Nil, err
	}
	var tagLinks []map[string]any
	for _, t := range p.Tables["tag_entities"] {
		if exists("tags", t["tag_id"]) {
			tagLinks = append(tagLinks, t)
		}
	}
	if err := insertRows(ctx, tx, "tag_entities", tagLinks); err != nil {
		return uuid.Nil, err
	}
	for _, l := range p.LocationLinks {
		if _, err := tx.ExecContext(ctx,
			"UPDATE entities SET entity_location_entities = $1 WHERE id = $2 AND entity_location_entities IS NULL",
			l.Target, l.ID); err != nil {
			return uuid.Nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM trash_entries WHERE id = $1", trashID.String()); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(); err != nil {
		return uuid.Nil, err
	}
	r.publish(gid)
	return uuid.Parse(rootID)
}

// Purge deletes a trash entry for good, including files no attachment uses anymore.
func (r *TrashRepository) Purge(ctx context.Context, gid, trashID uuid.UUID) error {
	if err := r.ensureTable(ctx); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.purge(ctx, gid, trashID)
}

func (r *TrashRepository) purge(ctx context.Context, gid, trashID uuid.UUID) error {
	_, p, err := r.load(ctx, r.db.Sql(), gid, trashID)
	if err != nil {
		return err
	}
	if _, err := r.db.Sql().ExecContext(ctx, "DELETE FROM trash_entries WHERE id = $1 AND group_id = $2",
		trashID.String(), gid.String()); err != nil {
		return err
	}
	r.deleteUnusedFiles(ctx, p)
	return nil
}

// PurgeAll empties the trash of a group.
func (r *TrashRepository) PurgeAll(ctx context.Context, gid uuid.UUID) (int, error) {
	entries, err := r.List(ctx, gid)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if err := r.Purge(ctx, gid, e.ID); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (r *TrashRepository) expiredIDs(ctx context.Context, gid uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Sql().QueryContext(ctx,
		"SELECT id FROM trash_entries WHERE group_id = $1 AND deleted_at < $2",
		gid.String(), time.Now().UTC().Add(-TrashRetention))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var expired []uuid.UUID
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			if u, err := uuid.Parse(id); err == nil {
				expired = append(expired, u)
			}
		}
	}
	return expired, rows.Err()
}

func (r *TrashRepository) purgeExpired(ctx context.Context, gid uuid.UUID) {
	expired, err := r.expiredIDs(ctx, gid)
	if err != nil {
		log.Warn().Err(err).Msg("trash: could not look for expired entries")
		return
	}
	for _, id := range expired {
		if err := r.purge(ctx, gid, id); err != nil {
			log.Warn().Err(err).Str("trash_id", id.String()).Msg("trash: could not purge expired entry")
		}
	}
}

func (r *TrashRepository) deleteUnusedFiles(ctx context.Context, p trashPayload) {
	if r.attachments == nil {
		return
	}
	var bucket *blob.Bucket
	defer func() {
		if bucket != nil {
			_ = bucket.Close()
		}
	}()
	for _, a := range p.Tables["attachments"] {
		path, _ := a["path"].(string)
		mime, _ := a["mime_type"].(string)
		if path == "" || isExternalLink(mime) {
			continue
		}
		var n int
		if err := r.db.Sql().QueryRowContext(ctx, "SELECT COUNT(*) FROM attachments WHERE path = $1", path).Scan(&n); err != nil || n > 0 {
			continue
		}
		if bucket == nil {
			b, err := blob.OpenBucket(ctx, r.attachments.GetConnString())
			if err != nil {
				log.Warn().Err(err).Msg("trash: cannot open storage to delete files")
				return
			}
			bucket = b
		}
		if err := bucket.Delete(ctx, r.attachments.fullPath(path)); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("trash: could not delete file")
		}
	}
}

func (r *TrashRepository) publish(gid uuid.UUID) {
	if r.bus != nil {
		r.bus.Publish(eventbus.EventEntityMutation, eventbus.GroupMutationEvent{GID: gid})
	}
}

// --- SQL helpers ---------------------------------------------------------------

type sqlQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func placeholders(from, n int) string {
	p := make([]string, n)
	for i := range p {
		p[i] = fmt.Sprintf("$%d", from+i)
	}
	return strings.Join(p, ", ")
}

func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// subtreeIDs returns the entity and all its descendants, parents first.
func subtreeIDs(ctx context.Context, q sqlQuerier, gid, id uuid.UUID) ([]any, error) {
	rows, err := q.QueryContext(ctx, `
		WITH RECURSIVE sub(id, depth) AS (
			SELECT id, 0 FROM entities WHERE id = $1 AND group_entities = $2
			UNION ALL
			SELECT e.id, sub.depth + 1 FROM entities e JOIN sub ON e.entity_children = sub.id
		)
		SELECT id FROM sub ORDER BY depth`, id, gid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []any
	for rows.Next() {
		var v any
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		ids = append(ids, v)
	}
	return ids, rows.Err()
}

func selectRows(ctx context.Context, q sqlQuerier, table, column string, keys []any) ([]map[string]any, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	rows, err := q.QueryContext(ctx,
		"SELECT * FROM "+quoteIdent(table)+" WHERE "+quoteIdent(column)+" IN ("+placeholders(1, len(keys))+")", keys...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			row[c] = vals[i]
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func deleteRows(ctx context.Context, q sqlQuerier, table, column string, keys []any) error {
	if len(keys) == 0 {
		return nil
	}
	_, err := q.ExecContext(ctx,
		"DELETE FROM "+quoteIdent(table)+" WHERE "+quoteIdent(column)+" IN ("+placeholders(1, len(keys))+")", keys...)
	return err
}

// insertRows inserts the rows, using only columns the table has today.
func insertRows(ctx context.Context, q sqlQuerier, table string, rows []map[string]any) error {
	if len(rows) == 0 {
		return nil
	}
	cols, err := tableColumns(ctx, q, table)
	if err != nil {
		return err
	}
	for _, row := range rows {
		var names []string
		var args []any
		for _, c := range cols {
			if v, ok := row[c]; ok {
				names = append(names, quoteIdent(c))
				args = append(args, v)
			}
		}
		stmt := "INSERT INTO " + quoteIdent(table) + " (" + strings.Join(names, ", ") + ") VALUES (" +
			placeholders(1, len(args)) + ") ON CONFLICT DO NOTHING"
		if _, err := q.ExecContext(ctx, stmt, args...); err != nil {
			return fmt.Errorf("restore %s: %w", table, err)
		}
	}
	return nil
}

func tableColumns(ctx context.Context, q sqlQuerier, table string) ([]string, error) {
	probe, err := q.QueryContext(ctx, "SELECT * FROM "+quoteIdent(table)+" WHERE 1 = 0")
	if err != nil {
		return nil, err
	}
	defer func() { _ = probe.Close() }()
	return probe.Columns()
}

func orderByIDs(rows []map[string]any, ids []any) []map[string]any {
	pos := map[string]int{}
	for i, id := range ids {
		pos[fmt.Sprint(id)] = i
	}
	out := make([]map[string]any, len(rows))
	copy(out, rows)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && pos[fmt.Sprint(out[j]["id"])] < pos[fmt.Sprint(out[j-1]["id"])]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// --- payload encoding -----------------------------------------------------------
// JSON loses Go types; times and bytes are tagged so they go back in as written.

func encodeValue(v any) any {
	switch t := v.(type) {
	case time.Time:
		return map[string]any{"$t": t.Format(time.RFC3339Nano)}
	case []byte:
		return map[string]any{"$b": base64.StdEncoding.EncodeToString(t)}
	case [16]byte:
		return uuid.UUID(t).String()
	default:
		return v
	}
}

func decodeValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		if s, ok := t["$t"].(string); ok {
			if tm, err := time.Parse(time.RFC3339Nano, s); err == nil {
				return tm
			}
		}
		if s, ok := t["$b"].(string); ok {
			if b, err := base64.StdEncoding.DecodeString(s); err == nil {
				return b
			}
		}
		return v
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		f, _ := t.Float64()
		return f
	default:
		return v
	}
}

func encodePayload(p trashPayload) trashPayload {
	out := p
	out.Tables = map[string][]map[string]any{}
	for table, rows := range p.Tables {
		for _, row := range rows {
			enc := make(map[string]any, len(row))
			for k, v := range row {
				enc[k] = encodeValue(v)
			}
			out.Tables[table] = append(out.Tables[table], enc)
		}
	}
	return out
}

func decodePayload(raw string) (trashPayload, error) {
	var p trashPayload
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return p, err
	}
	for _, rows := range p.Tables {
		for _, row := range rows {
			for k, v := range row {
				row[k] = decodeValue(v)
			}
		}
	}
	return p, nil
}
