import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, PointerEvent } from "react";
import {
  loadLibrary,
  saveLibrary,
  loadItems,
  saveItems,
  deleteItems,
  loadImage,
} from "./storage";
import type { Item, Library } from "./storage";

interface DragState {
  id: string;
  mode: "move" | "resize";
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  ow: number;
  oh: number;
}

const topZ = (list: Item[]) => list.reduce((m, i) => Math.max(m, i.z), 0) + 1;

export default function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 700);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const loaded = useRef(false);
  const activeId = useRef("");
  const skipRename = useRef(false);
  const panRef = useRef(pan);
  panRef.current = pan;
  const panDrag = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<DragState | null>(null);
  const zTop = useRef(1);

  const boards = lib?.boards ?? [];
  const current = boards.find((b) => b.id === lib?.current);

  const persistLibrary = (next: Library) => {
    setLib(next);
    saveLibrary(next).catch(() => setStatus("Couldn’t save"));
  };

  // Load boards + the last open board once
  useEffect(() => {
    (async () => {
      try {
        const l = await loadLibrary();
        const saved = await loadItems(l.current);
        activeId.current = l.current;
        zTop.current = topZ(saved);
        setLib(l);
        setItems(saved);
        setStatus(saved.length ? "Board restored" : "Ready");
      } catch {
        const id = crypto.randomUUID();
        activeId.current = id;
        setLib({ boards: [{ id, name: "Board 1" }], current: id });
        setStatus("Ready (saving unavailable)");
      } finally {
        loaded.current = true;
      }
    })();
  }, []);

  // Autosave the open board after changes
  useEffect(() => {
    if (!loaded.current || !activeId.current) return;
    const id = activeId.current;
    const t = setTimeout(() => {
      saveItems(id, items)
        .then(() => setStatus("Saved"))
        .catch(() => setStatus("Couldn’t save"));
    }, 500);
    return () => clearTimeout(t);
  }, [items]);

  const showBoard = (id: string, list: Item[]) => {
    activeId.current = id;
    zTop.current = topZ(list);
    setItems(list);
    setSel(null);
    setPan({ x: 0, y: 0 });
  };

  const openBoard = async (id: string) => {
    if (!lib || id === lib.current) return;
    try {
      await saveItems(lib.current, items);
      const next = await loadItems(id);
      showBoard(id, next);
      persistLibrary({ ...lib, current: id });
      setStatus("Board opened");
    } catch {
      setStatus("Couldn’t open board");
    }
  };

  const newBoard = async () => {
    if (!lib) return;
    try {
      await saveItems(lib.current, items);
    } catch {
      /* keep going */
    }
    const id = crypto.randomUUID();
    showBoard(id, []);
    persistLibrary({
      boards: [...lib.boards, { id, name: `Board ${lib.boards.length + 1}` }],
      current: id,
    });
    setEditing(id);
  };

  const commitRename = (id: string, value: string) => {
    setEditing(null);
    if (skipRename.current) {
      skipRename.current = false;
      return;
    }
    const name = value.trim();
    if (!name || !lib) return;
    persistLibrary({
      ...lib,
      boards: lib.boards.map((b) => (b.id === id ? { ...b, name } : b)),
    });
  };

  const deleteBoard = async (id: string) => {
    if (!lib) return;
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 3000);
      return;
    }
    setConfirmDelete(null);
    try {
      await deleteItems(id);
    } catch {
      /* ignore */
    }
    const rest = lib.boards.filter((b) => b.id !== id);
    if (id !== lib.current) {
      persistLibrary({ ...lib, boards: rest });
      return;
    }
    if (rest.length) {
      const next = await loadItems(rest[0].id).catch(() => [] as Item[]);
      showBoard(rest[0].id, next);
      persistLibrary({ boards: rest, current: rest[0].id });
    } else {
      const fresh = { id: crypto.randomUUID(), name: "Board 1" };
      showBoard(fresh.id, []);
      persistLibrary({ boards: [fresh], current: fresh.id });
    }
  };

  const addFiles = useCallback(
    async (files: FileList | File[], cx?: number, cy?: number) => {
      const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!imgs.length) return;
      const baseX = cx ?? 80 - panRef.current.x;
      const baseY = cy ?? 80 - panRef.current.y;
      const added: Item[] = [];
      for (let i = 0; i < imgs.length; i++) {
        try {
          const { src, w, h } = await loadImage(imgs[i]);
          const dw = Math.min(320, w);
          added.push({
            id: crypto.randomUUID(),
            src,
            x: baseX + i * 28,
            y: baseY + i * 28,
            w: dw,
            h: Math.round((dw * h) / w),
            z: zTop.current++,
          });
        } catch {
          /* skip unreadable file */
        }
      }
      if (added.length) {
        setItems((p) => [...p, ...added]);
        setSel(added[added.length - 1].id);
        setStatus("Saving…");
      }
    },
    [],
  );

  const removeSelected = useCallback(() => {
    if (!sel) return;
    setItems((p) => p.filter((i) => i.id !== sel));
    setSel(null);
    setStatus("Saving…");
  }, [sel]);

  // Paste images + Delete key
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length) addFiles(files);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [addFiles, removeSelected]);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const r = scroller.current!.getBoundingClientRect();
    addFiles(
      e.dataTransfer.files,
      e.clientX - r.left - pan.x,
      e.clientY - r.top - pan.y,
    );
  };

  const startDrag = (
    e: PointerEvent<HTMLDivElement>,
    it: Item,
    mode: DragState["mode"],
  ) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel(it.id);
    const z = zTop.current++;
    setItems((p) => p.map((i) => (i.id === it.id ? { ...i, z } : i)));
    drag.current = {
      id: it.id,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      ox: it.x,
      oy: it.y,
      ow: it.w,
      oh: it.h,
    };
  };

  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    setItems((p) =>
      p.map((i) => {
        if (i.id !== d.id) return i;
        if (d.mode === "move") return { ...i, x: d.ox + dx, y: d.oy + dy };
        const w = Math.max(40, d.ow + dx);
        return { ...i, w, h: Math.round((w * d.oh) / d.ow) };
      }),
    );
  };

  const endDrag = () => {
    if (drag.current) {
      drag.current = null;
      setStatus("Saving…");
    }
  };

  const startPan = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel(null);
    panDrag.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
  };
  const movePan = (e: PointerEvent<HTMLDivElement>) => {
    const d = panDrag.current;
    if (!d) return;
    setPan({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
  };
  const endPan = () => {
    panDrag.current = null;
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setItems([]);
    setSel(null);
    setConfirmClear(false);
    setStatus("Saving…");
  };

  return (
    <>
      <div className="bar">
        <button onClick={() => setSideOpen((o) => !o)} aria-expanded={sideOpen}>
          {sideOpen ? "Hide boards" : "Boards"}
        </button>
        <h1>{current?.name ?? "Whiteboard"}</h1>
        <span className="status" role="status">
          {status}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="primary" onClick={() => fileInput.current?.click()}>
          Add images
        </button>
        <button
          disabled={!pan.x && !pan.y}
          onClick={() => setPan({ x: 0, y: 0 })}
        >
          Reset view
        </button>
        <button disabled={!sel} onClick={removeSelected}>
          Delete selected
        </button>
        <button disabled={!items.length} onClick={clearAll}>
          {confirmClear ? "Click again to clear all" : "Clear board"}
        </button>
      </div>

      <div className="main">
        <aside
          className={"side" + (sideOpen ? "" : " closed")}
          aria-label="Boards"
        >
          <div className="side-in">
            <button className="primary wide" onClick={newBoard}>
              New board
            </button>
            <ul>
              {boards.map((b) => (
                <li
                  key={b.id}
                  className={"row" + (b.id === lib?.current ? " active" : "")}
                >
                  {editing === b.id ? (
                    <input
                      className="rename"
                      autoFocus
                      defaultValue={b.name}
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => commitRename(b.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          skipRename.current = true;
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="name"
                      onClick={() => openBoard(b.id)}
                      onDoubleClick={() => setEditing(b.id)}
                    >
                      {b.name}
                    </button>
                  )}
                  <span className="acts">
                    <button onClick={() => setEditing(b.id)}>Rename</button>
                    <button onClick={() => deleteBoard(b.id)}>
                      {confirmDelete === b.id ? "Sure?" : "Delete"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div
          ref={scroller}
          className={"viewport" + (over ? " over" : "")}
          style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onWheel={(e) =>
            setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
          }
        >
          {!items.length && (
            <div className="empty">
              <div>
                <b>Drop images here</b>
                Drag files from your computer, paste from the clipboard, or use
                Add images. Drag the background to move around.
              </div>
            </div>
          )}
          <div
            className="board"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
          >
            {items.map((it) => (
              <div
                key={it.id}
                className={"item" + (sel === it.id ? " sel" : "")}
                style={{
                  left: it.x,
                  top: it.y,
                  width: it.w,
                  height: it.h,
                  zIndex: it.z,
                }}
                onPointerDown={(e) => startDrag(e, it, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
              >
                <img src={it.src} alt="" draggable={false} />
                <div
                  className="handle"
                  onPointerDown={(e) => startDrag(e, it, "resize")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
