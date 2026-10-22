export interface Item {
  id: string;
  src: string; // data URL
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface BoardMeta {
  id: string;
  name: string;
}

export interface Library {
  boards: BoardMeta[];
  current: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("whiteboard", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kvDel(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the list of boards. On first run, creates "Board 1" (keeping any older single-board save). */
export async function loadLibrary(): Promise<Library> {
  const lib = await kvGet<Library>("library");
  if (lib && lib.boards.length) return lib;
  const id = crypto.randomUUID();
  const fresh: Library = { boards: [{ id, name: "Board 1" }], current: id };
  const legacy = await kvGet<Item[]>("board");
  if (legacy && legacy.length) await kvSet(`board:${id}`, legacy);
  await kvSet("library", fresh);
  return fresh;
}

export const saveLibrary = (lib: Library) => kvSet("library", lib);
export const loadItems = async (id: string) =>
  (await kvGet<Item[]>(`board:${id}`)) ?? [];
export const saveItems = (id: string, items: Item[]) =>
  kvSet(`board:${id}`, items);
export const deleteItems = (id: string) => kvDel(`board:${id}`);

/** Read an image file, shrink it if it's huge, return a data URL and size. */
export function loadImage(
  file: File,
): Promise<{ src: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Bad image"));
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        let src = reader.result as string;
        let w = img.width;
        let h = img.height;
        if (scale < 1) {
          const canvas = document.createElement("canvas");
          w = canvas.width = Math.round(img.width * scale);
          h = canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
          src = canvas.toDataURL(
            file.type === "image/png" ? "image/png" : "image/jpeg",
            0.9,
          );
        }
        resolve({ src, w, h });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
