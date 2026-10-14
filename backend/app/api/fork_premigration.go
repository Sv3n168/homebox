package main

// Fork: a copy of the SQLite database right before an update changes it.
//
// When the database has migrations pending (a new Homebox version is starting
// for the first time), the current database is copied with VACUUM INTO to
// <data dir>/.pre-migration/homebox-<UTC time>.db before goose runs. Only the
// newest preMigrationKeep copies are kept. Everything here is best effort: a
// failure is logged and Homebox starts normally.

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/config"
)

const (
	preMigrationDir  = ".pre-migration"
	preMigrationKeep = 3
)

func snapshotBeforeMigrations(db *sql.DB, driver string, migrationsFs fs.FS) {
	if driver != config.DriverSqlite3 && driver != "sqlite" {
		return
	}
	pending, err := pendingMigrations(db, migrationsFs, driver)
	if err != nil {
		log.Warn().Err(err).Msg("pre-migration copy: could not check for pending migrations, skipped")
		return
	}
	if pending == 0 {
		return
	}
	file, err := mainDatabaseFile(db)
	if err != nil || file == "" {
		log.Warn().Err(err).Msg("pre-migration copy: database file unknown, skipped")
		return
	}

	dir := filepath.Join(filepath.Dir(file), preMigrationDir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		log.Warn().Err(err).Msg("pre-migration copy: cannot create directory, skipped")
		return
	}
	target := filepath.Join(dir, "homebox-"+time.Now().UTC().Format("20060102-150405")+".db")
	if _, err := db.Exec("VACUUM INTO " + sqliteString(target)); err != nil {
		_ = os.Remove(target)
		log.Warn().Err(err).Msg("pre-migration copy: VACUUM INTO failed, skipped")
		return
	}
	log.Info().Str("file", target).Int("pending", pending).Msg("pre-migration copy of the database saved")
	prunePreMigrationCopies(dir, preMigrationKeep)
}

// pendingMigrations counts migration files whose version is not applied yet.
// A database without goose's table is new: nothing worth copying.
func pendingMigrations(db *sql.DB, migrationsFs fs.FS, dir string) (int, error) {
	var name string
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'goose_db_version'").Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}

	rows, err := db.Query("SELECT version_id, is_applied FROM goose_db_version ORDER BY id")
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	applied := map[int64]bool{}
	for rows.Next() {
		var v int64
		var ok bool
		if err := rows.Scan(&v, &ok); err != nil {
			return 0, err
		}
		applied[v] = ok
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	entries, err := fs.ReadDir(migrationsFs, dir)
	if err != nil {
		return 0, err
	}
	pending := 0
	for _, e := range entries {
		if e.IsDir() || (!strings.HasSuffix(e.Name(), ".sql") && !strings.HasSuffix(e.Name(), ".go")) {
			continue
		}
		prefix, _, found := strings.Cut(e.Name(), "_")
		if !found {
			continue
		}
		v, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			continue
		}
		if !applied[v] {
			pending++
		}
	}
	return pending, nil
}

func mainDatabaseFile(db *sql.DB) (string, error) {
	rows, err := db.Query("PRAGMA database_list")
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var seq int
		var name, file string
		if err := rows.Scan(&seq, &name, &file); err != nil {
			return "", err
		}
		if name == "main" {
			return file, nil
		}
	}
	return "", rows.Err()
}

func prunePreMigrationCopies(dir string, keep int) {
	matches, err := filepath.Glob(filepath.Join(dir, "homebox-*.db"))
	if err != nil || len(matches) <= keep {
		return
	}
	sort.Strings(matches)
	for _, old := range matches[:len(matches)-keep] {
		if err := os.Remove(old); err != nil {
			log.Warn().Err(err).Str("file", old).Msg("pre-migration copy: could not remove old copy")
		}
	}
}

func sqliteString(s string) string {
	return fmt.Sprintf("'%s'", strings.ReplaceAll(s, "'", "''"))
}
