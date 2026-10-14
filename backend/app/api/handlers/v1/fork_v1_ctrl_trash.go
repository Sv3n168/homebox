package v1

// Fork: recycle bin endpoints (see repo/fork_trash.go).

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/hay-kot/httpkit/errchain"
	"github.com/sysadminsmedia/homebox/backend/internal/core/services"
	"github.com/sysadminsmedia/homebox/backend/internal/data/repo"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/validate"
	"github.com/sysadminsmedia/homebox/backend/internal/web/adapters"
)

type TrashRestoreResult struct {
	ID uuid.UUID `json:"id"`
}

type TrashEmptyResult struct {
	Deleted int `json:"deleted"`
}

func trashError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sql.ErrNoRows):
		return validate.NewRequestError(err, http.StatusNotFound)
	case errors.Is(err, repo.ErrTrashEntityType):
		return validate.NewRequestError(err, http.StatusConflict)
	default:
		return err
	}
}

// HandleTrashList godoc
//
//	@Summary	List the recycle bin (deleted items and locations, kept 30 days)
//	@Tags		Trash
//	@Produce	json
//	@Success	200	{object}	[]repo.TrashEntry
//	@Router		/v1/trash [GET]
//	@Security	Bearer
func (ctrl *V1Controller) HandleTrashList() errchain.HandlerFunc {
	fn := func(r *http.Request) ([]repo.TrashEntry, error) {
		auth := services.NewContext(r.Context())
		return ctrl.repo.Trash.List(auth, auth.GID)
	}
	return adapters.Command(fn, http.StatusOK)
}

// HandleTrashRestore godoc
//
//	@Summary	Restore a recycle bin entry
//	@Tags		Trash
//	@Produce	json
//	@Param		id	path		string	true	"Trash entry ID"
//	@Success	200	{object}	TrashRestoreResult
//	@Router		/v1/trash/{id}/restore [POST]
//	@Security	Bearer
func (ctrl *V1Controller) HandleTrashRestore() errchain.HandlerFunc {
	fn := func(r *http.Request, id uuid.UUID) (TrashRestoreResult, error) {
		auth := services.NewContext(r.Context())
		root, err := ctrl.repo.Trash.Restore(auth, auth.GID, id)
		return TrashRestoreResult{ID: root}, trashError(err)
	}
	return adapters.CommandID("id", fn, http.StatusOK)
}

// HandleTrashPurge godoc
//
//	@Summary	Delete a recycle bin entry for good
//	@Tags		Trash
//	@Param		id	path	string	true	"Trash entry ID"
//	@Success	204
//	@Router		/v1/trash/{id} [DELETE]
//	@Security	Bearer
func (ctrl *V1Controller) HandleTrashPurge() errchain.HandlerFunc {
	fn := func(r *http.Request, id uuid.UUID) (any, error) {
		auth := services.NewContext(r.Context())
		return nil, trashError(ctrl.repo.Trash.Purge(auth, auth.GID, id))
	}
	return adapters.CommandID("id", fn, http.StatusNoContent)
}

// HandleTrashEmpty godoc
//
//	@Summary	Empty the recycle bin
//	@Tags		Trash
//	@Produce	json
//	@Success	200	{object}	TrashEmptyResult
//	@Router		/v1/trash [DELETE]
//	@Security	Bearer
func (ctrl *V1Controller) HandleTrashEmpty() errchain.HandlerFunc {
	fn := func(r *http.Request) (TrashEmptyResult, error) {
		auth := services.NewContext(r.Context())
		n, err := ctrl.repo.Trash.PurgeAll(auth, auth.GID)
		return TrashEmptyResult{Deleted: n}, err
	}
	return adapters.Command(fn, http.StatusOK)
}
