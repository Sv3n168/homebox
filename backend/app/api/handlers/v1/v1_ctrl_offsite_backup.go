package v1

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/hay-kot/httpkit/errchain"
	"github.com/sysadminsmedia/homebox/backend/internal/web/adapters"
)

// The hb-backup sidecar (deploy/backup) shares the data volume and writes the
// result of its last backup and last restore test next to the database. It
// reads its schedule settings from a second file Homebox writes there.
const (
	offsiteBackupStatusFile   = ".hb-backup-status.json"
	offsiteBackupSettingsFile = ".hb-backup-settings.json"
)

type OffsiteBackupSettings struct {
	IntervalDays int `json:"intervalDays" validate:"min=1,max=30"`
	KeepMonths   int `json:"keepMonths"   validate:"min=1,max=60"`
}

// Used until the settings are saved once; matches the sidecar's defaults.
var defaultOffsiteBackupSettings = OffsiteBackupSettings{IntervalDays: 1, KeepMonths: 2}

type OffsiteBackupRun struct {
	State  string `json:"state"`
	At     int64  `json:"at"`
	Detail string `json:"detail"`
}

type OffsiteBackupStatus struct {
	Configured  bool                  `json:"configured"`
	MaxAgeHours int                   `json:"maxAgeHours"`
	StartedAt   int64                 `json:"startedAt"`
	Backup      *OffsiteBackupRun     `json:"backup"`
	Verify      *OffsiteBackupRun     `json:"verify"`
	Settings    OffsiteBackupSettings `json:"settings"`
}

func (ctrl *V1Controller) offsiteBackupDir() string {
	return filepath.Dir(strings.Split(ctrl.config.Database.SqlitePath, "?")[0])
}

func (ctrl *V1Controller) offsiteBackupSettings() OffsiteBackupSettings {
	out := defaultOffsiteBackupSettings
	raw, err := os.ReadFile(filepath.Join(ctrl.offsiteBackupDir(), offsiteBackupSettingsFile))
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

// HandleOffsiteBackupStatus reports what the backup sidecar last did. When no
// sidecar runs, the file does not exist and Configured is false.
func (ctrl *V1Controller) HandleOffsiteBackupStatus() errchain.HandlerFunc {
	fn := func(r *http.Request) (OffsiteBackupStatus, error) {
		raw, err := os.ReadFile(filepath.Join(ctrl.offsiteBackupDir(), offsiteBackupStatusFile))
		if errors.Is(err, fs.ErrNotExist) {
			return OffsiteBackupStatus{Settings: ctrl.offsiteBackupSettings()}, nil
		}
		if err != nil {
			return OffsiteBackupStatus{}, err
		}
		var out OffsiteBackupStatus
		if err := json.Unmarshal(raw, &out); err != nil {
			return OffsiteBackupStatus{}, err
		}
		out.Configured = true
		out.Settings = ctrl.offsiteBackupSettings()
		return out, nil
	}

	return adapters.Command(fn, http.StatusOK)
}

// HandleOffsiteBackupSettingsUpdate stores how often the sidecar backs up and
// how long it keeps backups. It picks them up on its next scheduled run.
func (ctrl *V1Controller) HandleOffsiteBackupSettingsUpdate() errchain.HandlerFunc {
	fn := func(r *http.Request, body OffsiteBackupSettings) (OffsiteBackupSettings, error) {
		raw, err := json.Marshal(body)
		if err != nil {
			return body, err
		}
		path := filepath.Join(ctrl.offsiteBackupDir(), offsiteBackupSettingsFile)
		if err := os.WriteFile(path+".tmp", raw, 0o644); err != nil {
			return body, err
		}
		return body, os.Rename(path+".tmp", path)
	}

	return adapters.Action(fn, http.StatusOK)
}
