package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/require"
)

func TestSnapshotBeforeMigrations(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "homebox.db")
	db, err := sql.Open("sqlite3", "file:"+dbFile+"?_pragma=journal_mode=WAL&_fk=1")
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	migs := fstest.MapFS{
		"sqlite3/20260101000000_a.sql": {Data: []byte("-- +goose Up\ncreate table a (x int);\n")},
	}
	copies := func() []string {
		m, _ := filepath.Glob(filepath.Join(dir, preMigrationDir, "homebox-*.db"))
		return m
	}
	// Stand-in for goose: its version table plus one row per applied version.
	migrate := func(versions ...int64) {
		_, err := db.Exec("create table if not exists goose_db_version (id integer primary key autoincrement, version_id integer not null, is_applied integer not null, tstamp timestamp default (datetime('now')))")
		require.NoError(t, err)
		for _, v := range versions {
			_, err := db.Exec("insert into goose_db_version (version_id, is_applied) values (?, 1)", v)
			require.NoError(t, err)
		}
	}

	// New database: nothing to copy.
	snapshotBeforeMigrations(db, "sqlite3", migs)
	require.Empty(t, copies())
	_, err = db.Exec("create table a (x int)")
	require.NoError(t, err)
	migrate(0, 20260101000000)

	// Up to date: no copy.
	snapshotBeforeMigrations(db, "sqlite3", migs)
	require.Empty(t, copies())

	// An update brings a migration (even one dated before the applied ones): copy first.
	_, err = db.Exec("insert into a values (42)")
	require.NoError(t, err)
	migs["sqlite3/20251201000000_b.sql"] = &fstest.MapFile{Data: []byte("-- +goose Up\ncreate table b (x int);\n")}
	snapshotBeforeMigrations(db, "sqlite3", migs)
	require.Len(t, copies(), 1)

	copyDB, err := sql.Open("sqlite3", "file:"+copies()[0])
	require.NoError(t, err)
	var x int
	require.NoError(t, copyDB.QueryRow("select x from a").Scan(&x))
	require.Equal(t, 42, x)
	_ = copyDB.Close()

	migrate(20251201000000)
	snapshotBeforeMigrations(db, "sqlite3", migs)
	require.Len(t, copies(), 1, "no copy once the migration is applied")

	// Only the newest copies are kept.
	for _, name := range []string{"homebox-20200101-000000.db", "homebox-20200102-000000.db", "homebox-20200103-000000.db"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, preMigrationDir, name), []byte("x"), 0o600))
	}
	prunePreMigrationCopies(filepath.Join(dir, preMigrationDir), preMigrationKeep)
	require.Len(t, copies(), preMigrationKeep)

	// Postgres: never touched.
	snapshotBeforeMigrations(db, "postgres", migs)
}
