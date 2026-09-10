// Owns blob: URLs created for protected Storage responses. Registries are swapped only after a
// replacement render, so URLs still referenced by the old DOM are never revoked prematurely.
export function createObjectUrlRegistry(urlApi = URL) {
  const active = new Set();
  return Object.freeze({
    create(blob) {
      const objectUrl = urlApi.createObjectURL(blob);
      active.add(objectUrl);
      return objectUrl;
    },
    revoke(objectUrl) {
      if (typeof objectUrl === "string" && active.delete(objectUrl)) urlApi.revokeObjectURL(objectUrl);
    },
    revokeAll() {
      for (const objectUrl of [...active]) {
        active.delete(objectUrl);
        urlApi.revokeObjectURL(objectUrl);
      }
    },
    get size() { return active.size; },
  });
}
