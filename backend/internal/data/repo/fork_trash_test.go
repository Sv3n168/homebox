package repo

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/sysadminsmedia/homebox/backend/internal/data/ent/attachment"
	"github.com/sysadminsmedia/homebox/backend/internal/data/types"
	"gocloud.dev/blob"
)

func TestTrash_MoveRestorePurge(t *testing.T) {
	ctx := context.Background()
	locET := useContainerEntityType(t)
	itemET := useItemEntityType(t)
	tag := useTags(t, 1)[0]

	// Keller > Box > Bohrmaschine (tag, custom field, maintenance entry, photo)
	cellar, err := tRepos.Entities.Create(ctx, tGroup.ID, EntityCreate{Name: "Keller " + fk.Str(5), EntityTypeID: locET.ID})
	require.NoError(t, err)
	box, err := tRepos.Entities.Create(ctx, tGroup.ID, EntityCreate{Name: "Box", EntityTypeID: locET.ID, ParentID: cellar.ID})
	require.NoError(t, err)
	drill, err := tRepos.Entities.Create(ctx, tGroup.ID, EntityCreate{
		Name: "Bohrmaschine", EntityTypeID: itemET.ID, ParentID: box.ID, TagIDs: []uuid.UUID{tag.ID},
	})
	require.NoError(t, err)
	_, err = tClient.EntityField.Create().SetEntityID(drill.ID).SetName("Akku").SetType("text").SetTextValue("18V").Save(ctx)
	require.NoError(t, err)
	_, err = tRepos.MaintEntry.Create(ctx, tGroup.ID, drill.ID, MaintenanceEntryCreate{
		Name: "Kohlen", CompletedDate: types.DateFromTime(time.Now()),
	})
	require.NoError(t, err)
	photo, err := tRepos.Attachments.Create(ctx, drill.ID,
		ItemCreateAttachment{Title: "Foto", Content: strings.NewReader("jpeg bytes")}, attachment.TypePhoto, true)
	require.NoError(t, err)

	fileExists := func() bool {
		b, err := blob.OpenBucket(ctx, tRepos.Attachments.GetConnString())
		require.NoError(t, err)
		defer func() { _ = b.Close() }()
		ok, err := b.Exists(ctx, tRepos.Attachments.fullPath(photo.Path))
		require.NoError(t, err)
		return ok
	}
	require.True(t, fileExists())

	// Delete the cellar: everything inside goes to the trash with it.
	entry, err := tRepos.Trash.MoveToTrash(ctx, tGroup.ID, cellar.ID)
	require.NoError(t, err)
	assert.Equal(t, 3, entry.EntityCount)
	assert.True(t, entry.IsLocation)
	for _, id := range []uuid.UUID{cellar.ID, box.ID, drill.ID} {
		_, err := tRepos.Entities.GetOneByGroup(ctx, tGroup.ID, id)
		require.Error(t, err, "entity should be gone")
	}
	assert.True(t, fileExists(), "files stay while the entry is in the trash")

	list, err := tRepos.Trash.List(ctx, tGroup.ID)
	require.NoError(t, err)
	require.NotEmpty(t, list)
	assert.Equal(t, entry.ID, list[0].ID)
	assert.Equal(t, cellar.Name, list[0].Name)
	assert.WithinDuration(t, entry.DeletedAt.Add(TrashRetention), list[0].PurgeAt, time.Second)

	// Restore: same IDs, structure, tag, field, maintenance and photo.
	rootID, err := tRepos.Trash.Restore(ctx, tGroup.ID, entry.ID)
	require.NoError(t, err)
	assert.Equal(t, cellar.ID, rootID)
	got, err := tRepos.Entities.GetOneByGroup(ctx, tGroup.ID, drill.ID)
	require.NoError(t, err)
	require.NotNil(t, got.Parent)
	assert.Equal(t, box.ID, got.Parent.ID)
	require.Len(t, got.Tags, 1)
	assert.Equal(t, tag.ID, got.Tags[0].ID)
	require.Len(t, got.Fields, 1)
	assert.Equal(t, "18V", got.Fields[0].TextValue)
	require.Len(t, got.Attachments, 1)
	assert.Equal(t, photo.ID, got.Attachments[0].ID)
	maint, err := tRepos.MaintEntry.GetMaintenanceByItemID(ctx, tGroup.ID, drill.ID, MaintenanceFilters{})
	require.NoError(t, err)
	assert.Len(t, maint, 1)
	boxOut, err := tRepos.Entities.GetOneByGroup(ctx, tGroup.ID, box.ID)
	require.NoError(t, err)
	assert.Equal(t, cellar.ID, boxOut.Parent.ID)

	list, err = tRepos.Trash.List(ctx, tGroup.ID)
	require.NoError(t, err)
	for _, e := range list {
		assert.NotEqual(t, entry.ID, e.ID, "restored entry left the trash")
	}

	// Delete only the drill, then purge it: the photo file goes as well.
	entry, err = tRepos.Trash.MoveToTrash(ctx, tGroup.ID, drill.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, entry.EntityCount)
	assert.Equal(t, "Box", entry.ParentName)
	require.NoError(t, tRepos.Trash.Purge(ctx, tGroup.ID, entry.ID))
	assert.False(t, fileExists())
	_, err = tRepos.Trash.Restore(ctx, tGroup.ID, entry.ID)
	require.Error(t, err)

	// A restored item whose parent was deleted meanwhile comes back without one.
	pen, err := tRepos.Entities.Create(ctx, tGroup.ID, EntityCreate{Name: "Stift", EntityTypeID: itemET.ID, ParentID: box.ID})
	require.NoError(t, err)
	penEntry, err := tRepos.Trash.MoveToTrash(ctx, tGroup.ID, pen.ID)
	require.NoError(t, err)
	_, err = tRepos.Trash.MoveToTrash(ctx, tGroup.ID, cellar.ID)
	require.NoError(t, err)
	_, err = tRepos.Trash.Restore(ctx, tGroup.ID, penEntry.ID)
	require.NoError(t, err)
	penOut, err := tRepos.Entities.GetOneByGroup(ctx, tGroup.ID, pen.ID)
	require.NoError(t, err)
	assert.Nil(t, penOut.Parent)

	// Entries of another group are invisible.
	_, err = tRepos.Trash.Restore(ctx, uuid.New(), penEntry.ID)
	require.Error(t, err)

	n, err := tRepos.Trash.PurgeAll(ctx, tGroup.ID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, n, 1)
	_ = tRepos.Entities.Delete(ctx, pen.ID)
}

func TestTrash_ExpiredEntriesArePurged(t *testing.T) {
	ctx := context.Background()
	itemET := useItemEntityType(t)
	item, err := tRepos.Entities.Create(ctx, tGroup.ID, EntityCreate{Name: "Alt", EntityTypeID: itemET.ID})
	require.NoError(t, err)
	entry, err := tRepos.Trash.MoveToTrash(ctx, tGroup.ID, item.ID)
	require.NoError(t, err)

	_, err = tClient.Sql().ExecContext(ctx, "UPDATE trash_entries SET deleted_at = $1 WHERE id = $2",
		time.Now().UTC().Add(-TrashRetention-time.Hour), entry.ID.String())
	require.NoError(t, err)

	list, err := tRepos.Trash.List(ctx, tGroup.ID)
	require.NoError(t, err)
	for _, e := range list {
		assert.NotEqual(t, entry.ID, e.ID)
	}
}
