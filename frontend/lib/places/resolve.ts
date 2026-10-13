// Turns the text of a scanned box label into the id it points to. Homebox
// labels encode a link: /location/<id>, /item/<id> or /a/<asset id>.

export type LabelTarget = { kind: "entity"; id: string } | { kind: "asset"; assetId: string };

export function parseLabel(text: string, origin = "http://local"): LabelTarget | null {
  let path: string;
  try {
    path = new URL(text.trim(), origin).pathname;
  } catch {
    return null;
  }
  const entity = path.match(/^\/(?:location|item)\/([0-9a-zA-Z-]+)\/?$/);
  if (entity) return { kind: "entity", id: entity[1]! };
  const asset = path.match(/^\/(?:a|assets)\/([0-9-]+)\/?$/);
  if (asset) return { kind: "asset", assetId: asset[1]! };
  return null;
}
