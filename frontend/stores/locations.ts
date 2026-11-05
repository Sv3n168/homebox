import { defineStore } from "pinia";
import type { ItemsApi } from "~~/lib/api/classes/items";
import type { EntitySummary, TreeItem } from "~~/lib/api/types/data-contracts";

export const useLocationStore = defineStore("locations", {
  state: () => ({
    parents: null as EntitySummary[] | null,
    Locations: null as EntitySummary[] | null,
    client: useUserApi(),
    tree: null as TreeItem[] | null,
    refreshLocationsPromise: null as Promise<void> | null,
    // Fork: one request at a time; several components ask for the tree /
    // parents on the same page while the first request is still in flight.
    refreshTreePromise: null as Promise<void> | null,
    refreshParentsPromise: null as Promise<void> | null,
  }),
  getters: {
    /**
     * locations represents the locations that are currently in the store. The store is
     * synched with the server by intercepting the API calls and updating on the
     * response
     */
    parentLocations(state): EntitySummary[] {
      // Fork: one request while the first is still in flight (getters cannot call actions).
      if (state.parents === null && state.refreshParentsPromise === null) {
        state.refreshParentsPromise = this.client.items
          .getLocations({ filterChildren: true })
          .then(result => {
            if (result.error) {
              console.error(result.error);
              return;
            }
            this.parents = result.data;
          })
          .finally(() => {
            state.refreshParentsPromise = null;
          });
      }
      return state.parents ?? [];
    },
    allLocations(state): EntitySummary[] {
      return state.Locations ?? [];
    },
  },
  actions: {
    async ensureLocationsFetched() {
      if (this.Locations !== null) {
        return;
      }

      if (this.refreshLocationsPromise === null) {
        this.refreshLocationsPromise = this.refreshChildren().then(() => {});
      }
      await this.refreshLocationsPromise;
    },
    async refreshParents(): ReturnType<ItemsApi["getLocations"]> {
      const result = await this.client.items.getLocations({ filterChildren: true });
      if (result.error) {
        return result;
      }

      this.parents = result.data;
      return result;
    },
    async refreshChildren(): ReturnType<ItemsApi["getLocations"]> {
      const result = await this.client.items.getLocations({ filterChildren: false });
      if (result.error) {
        return result;
      }

      this.Locations = result.data;
      return result;
    },
    async refreshTree(): ReturnType<ItemsApi["getTree"]> {
      const result = await this.client.items.getTree();
      if (result.error) {
        return result;
      }

      this.tree = result.data;
      return result;
    },
    /** Fork: the parents once, shared by everything that needs them while they load. */
    async ensureParentsFetched() {
      if (this.parents !== null) return;
      if (this.refreshParentsPromise === null) {
        this.refreshParentsPromise = this.refreshParents()
          .then(() => {})
          .finally(() => {
            this.refreshParentsPromise = null;
          });
      }
      await this.refreshParentsPromise;
    },
    /** Fork: the tree once, shared by everything that needs it while it loads. */
    async ensureTreeFetched() {
      if (this.tree !== null) return;
      if (this.refreshTreePromise === null) {
        this.refreshTreePromise = this.refreshTree()
          .then(() => {})
          .finally(() => {
            this.refreshTreePromise = null;
          });
      }
      await this.refreshTreePromise;
    },
  },
});
