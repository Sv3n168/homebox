import { route } from "~~/lib/api/base";

/** One entry of the recycle bin (backend: repo/fork_trash.go). */
export type TrashEntry = {
  id: string;
  rootId: string;
  name: string;
  isLocation: boolean;
  entityCount: number;
  parentName: string;
  deletedAt: string;
  purgeAt: string;
};

/** Fork: deleted items and locations, kept 30 days. */
export function useTrash() {
  const api = useUserApi();

  return {
    list: () => api.http.get<TrashEntry[]>({ url: route("/trash") }),
    restore: (id: string) => api.http.post<object, { id: string }>({ url: route(`/trash/${id}/restore`), body: {} }),
    purge: (id: string) => api.http.delete<void>({ url: route(`/trash/${id}`) }),
    empty: () => api.http.delete<{ deleted: number }>({ url: route("/trash") }),
  };
}
