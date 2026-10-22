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
  ofs: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

type ThemeKey = "dark" | "white" | "beige";

const THEMES: Record<
  ThemeKey,
  { label: string; scheme: "dark" | "light"; vars: Record<string, string> }
> = {
  dark: {
    label: "Escuro",
    scheme: "dark",
    vars: {
      "--bg": "#141518",
      "--board": "#1e2024",
      "--ink": "#ecebe6",
      "--mute": "#9a9ea8",
      "--line": "#34363c",
      "--dot": "#32343a",
      "--accent": "#7aa2ff",
      "--bar": "#1a1b1f",
      "--hover": "#26282d",
    },
  },
  white: {
    label: "Branco",
    scheme: "light",
    vars: {
      "--bg": "#f4f4f5",
      "--board": "#ffffff",
      "--ink": "#1b1c20",
      "--mute": "#6b6f7a",
      "--line": "#dcdce0",
      "--dot": "#d6d6db",
      "--accent": "#2f6fed",
      "--bar": "#fafafa",
      "--hover": "#ececef",
    },
  },
  beige: {
    label: "Bege",
    scheme: "light",
    vars: {
      "--bg": "#e9e1cf",
      "--board": "#f6f0e1",
      "--ink": "#3a3326",
      "--mute": "#7d7360",
      "--line": "#d6ccb4",
      "--dot": "#d3c8ae",
      "--accent": "#a8571f",
      "--bar": "#f0e9d8",
      "--hover": "#e4dbc5",
    },
  },
};

// Fonts available for text nodes (loaded in the CSS @import)
const FONTS: Record<string, { label: string; css: string }> = {
  sans: { label: "Sans", css: '"IBM Plex Sans", system-ui, sans-serif' },
  serif: { label: "Serifada", css: '"Playfair Display", Georgia, serif' },
  mono: { label: "Mono", css: '"Courier New", ui-monospace, monospace' },
  hand: { label: "Manuscrita", css: '"Caveat", cursive' },
  display: { label: "Título", css: '"Bebas Neue", Impact, sans-serif' },
};
const fontCss = (k?: string) => (FONTS[k ?? "sans"] ?? FONTS.sans).css;

const topZ = (list: Item[]) => list.reduce((m, i) => Math.max(m, i.z), 0) + 1;

export default function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState("Carregando…");
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 700);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [theme, setTheme] = useState<ThemeKey>(() => {
    try {
      const t = localStorage.getItem("wb-theme");
      if (t && t in THEMES) return t as ThemeKey;
    } catch {
      /* ignore */
    }
    return "dark";
  });
  const [themeOpen, setThemeOpen] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);

  const loaded = useRef(false);
  const activeId = useRef("");
  const skipRename = useRef(false);
  const panRef = useRef(pan);
  panRef.current = pan;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
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
  const textRef = useRef<HTMLTextAreaElement>(null);

  const boards = lib?.boards ?? [];
  const current = boards.find((b) => b.id === lib?.current);

  const persistLibrary = (next: Library) => {
    setLib(next);
    saveLibrary(next).catch(() => setStatus("Não foi possível salvar"));
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
        setStatus(saved.length ? "Quadro restaurado" : "Pronto");
      } catch {
        const id = crypto.randomUUID();
        activeId.current = id;
        setLib({ boards: [{ id, name: "Quadro 1" }], current: id });
        setStatus("Pronto (salvamento indisponível)");
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
        .then(() => setStatus("Salvo"))
        .catch(() => setStatus("Não foi possível salvar"));
    }, 500);
    return () => clearTimeout(t);
  }, [items]);

  // Mouse wheel = zoom in/out around the cursor
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // also blocks browser zoom on Ctrl+wheel / pinch
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const s = scaleRef.current;
      const p = panRef.current;
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, s * Math.exp(-e.deltaY * 0.0015)),
      );
      const k = next / s;
      // update refs immediately so rapid wheel events don't use stale values
      scaleRef.current = next;
      panRef.current = { x: mx - (mx - p.x) * k, y: my - (my - p.y) * k };
      setScale(next);
      setPan(panRef.current);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Apply the chosen color theme (and remember it)
  useEffect(() => {
    const root = document.documentElement;
    const t = THEMES[theme];
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = t.scheme;
    try {
      localStorage.setItem("wb-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Focus the text box when a text node enters edit mode
  useEffect(() => {
    if (!editingText) return;
    // small delay so the click that created it doesn't steal the focus back
    const t = setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 50);
    return () => clearTimeout(t);
  }, [editingText]);

  const showBoard = (id: string, list: Item[]) => {
    activeId.current = id;
    zTop.current = topZ(list);
    setItems(list);
    setSel(null);
    setPan({ x: 0, y: 0 });
    setScale(1);
    setEditingText(null);
  };

  const openBoard = async (id: string) => {
    if (!lib || id === lib.current) return;
    try {
      await saveItems(lib.current, items);
      const next = await loadItems(id);
      showBoard(id, next);
      persistLibrary({ ...lib, current: id });
      setStatus("Quadro aberto");
    } catch {
      setStatus("Não foi possível abrir o quadro");
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
      boards: [...lib.boards, { id, name: `Quadro ${lib.boards.length + 1}` }],
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
      const fresh = { id: crypto.randomUUID(), name: "Quadro 1" };
      showBoard(fresh.id, []);
      persistLibrary({ boards: [fresh], current: fresh.id });
    }
  };

  const addFiles = useCallback(
    async (files: FileList | File[], cx?: number, cy?: number) => {
      const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!imgs.length) return;
      const baseX = cx ?? (80 - panRef.current.x) / scaleRef.current;
      const baseY = cy ?? (80 - panRef.current.y) / scaleRef.current;
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
        setStatus("Salvando…");
      }
    },
    [],
  );

  const removeSelected = useCallback(() => {
    if (!sel) return;
    setItems((p) => p.filter((i) => i.id !== sel));
    setSel(null);
    setStatus("Salvando…");
  }, [sel]);

  // Paste images + Delete key
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length) addFiles(files);
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") setTextMode(false);
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
      (e.clientX - r.left - pan.x) / scale,
      (e.clientY - r.top - pan.y) / scale,
    );
  };

  const startDrag = (
    e: PointerEvent<HTMLDivElement>,
    it: Item,
    mode: DragState["mode"],
  ) => {
    // While a text node is being edited, let the textarea handle the pointer
    if (editingText === it.id) {
      e.stopPropagation();
      return;
    }
    // First click only selects; the event bubbles to the viewport so
    // dragging an unselected image pans the board instead of moving it.
    if (mode === "move" && sel !== it.id) {
      setSel(it.id);
      return;
    }
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
      ofs: it.fs ?? 24,
    };
  };

  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    setItems((p) =>
      p.map((i) => {
        if (i.id !== d.id) return i;
        if (d.mode === "move") return { ...i, x: d.ox + dx, y: d.oy + dy };
        const w = Math.max(40, d.ow + dx);
        return {
          ...i,
          w,
          h: Math.round((w * d.oh) / d.ow),
          // resizing a text node scales its font, so the wrapping stays the same
          fs: i.type === "text" ? (d.ofs * w) / d.ow : i.fs,
        };
      }),
    );
  };

  const endDrag = () => {
    if (drag.current) {
      drag.current = null;
      setStatus("Salvando…");
    }
  };

  const startPan = (e: PointerEvent<HTMLDivElement>) => {
    // Text tool: a click on empty canvas creates a text node and edits it
    if (textMode && !(e.target as HTMLElement).closest(".item")) {
      e.preventDefault();
      const r = scroller.current!.getBoundingClientRect();
      const id = crypto.randomUUID();
      const fs = 24;
      setItems((p) => [
        ...p,
        {
          id,
          src: "",
          type: "text",
          text: "",
          fs,
          x: (e.clientX - r.left - pan.x) / scale,
          y: (e.clientY - r.top - pan.y) / scale,
          w: 220,
          h: Math.round(fs * 1.3),
          z: zTop.current++,
        },
      ]);
      setSel(id);
      setEditingText(id);
      setTextMode(false);
      setStatus("Salvando…");
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    // Keep the selection when the press started on an image (handled above)
    if (!(e.target as HTMLElement).closest(".item")) setSel(null);
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

  // ---- Text styling (font + color) ----
  const selItem = items.find((i) => i.id === sel);
  const selIsText = selItem?.type === "text";

  // Recompute the text height after a font change (the wrapping changes)
  const remeasure = (id: string, ff?: string) => {
    const run = async () => {
      try {
        await document.fonts.load(`24px ${fontCss(ff)}`);
      } catch {
        /* ignore */
      }
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-id="${id}"] > div:first-child, [data-id="${id}"] > textarea`,
        );
        if (!el) return;
        const prev = el.style.height;
        el.style.height = "auto";
        const h = el.scrollHeight;
        el.style.height = prev;
        setItems((p) =>
          p.map((i) =>
            i.id === id
              ? { ...i, h: Math.max(Math.round((i.fs ?? 24) * 1.3), h) }
              : i,
          ),
        );
      });
    };
    run();
  };

  const updateSelected = (patch: Partial<Item>) => {
    if (!sel) return;
    setItems((p) => p.map((i) => (i.id === sel ? { ...i, ...patch } : i)));
    setStatus("Salvando…");
    if ("ff" in patch) remeasure(sel, patch.ff);
  };

  // Render every image on the board into a single PNG and download it
  const exportPng = async (list: Item[], suffix = "") => {
    if (!list.length) return;
    setStatus("Exportando…");
    try {
      const pad = 40;
      const minX = Math.min(...list.map((i) => i.x)) - pad;
      const minY = Math.min(...list.map((i) => i.y)) - pad;
      const maxX = Math.max(...list.map((i) => i.x + i.w)) + pad;
      const maxY = Math.max(...list.map((i) => i.y + i.h)) + pad;
      const bw = maxX - minX;
      const bh = maxY - minY;
      // 2x for sharpness, but keep the canvas within browser limits
      const k = Math.min(2, 8192 / Math.max(bw, bh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bw * k));
      canvas.height = Math.max(1, Math.round(bh * k));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--board")
          .trim() || "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      const ink =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ink")
          .trim() || "#000";
      const wrapLines = (text: string, maxW: number) => {
        const out: string[] = [];
        for (const para of text.split("\n")) {
          let line = "";
          for (const word of para.split(" ")) {
            const test = line ? `${line} ${word}` : word;
            if (!line || ctx.measureText(test).width <= maxW) {
              line = test;
            } else {
              out.push(line);
              line = word;
            }
          }
          out.push(line);
        }
        return out;
      };
      for (const it of [...list].sort((a, b) => a.z - b.z)) {
        if (it.type === "text") {
          const fs = (it.fs ?? 24) * k;
          const fam = fontCss(it.ff);
          try {
            await document.fonts.load(`${fs}px ${fam}`);
          } catch {
            /* ignore */
          }
          ctx.font = `${fs}px ${fam}`;
          ctx.fillStyle = it.color ?? ink;
          ctx.textBaseline = "top";
          wrapLines(it.text ?? "", it.w * k).forEach((ln, idx) =>
            ctx.fillText(
              ln,
              (it.x - minX) * k,
              (it.y - minY) * k + idx * fs * 1.3 + fs * 0.15,
            ),
          );
          continue;
        }
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("Bad image"));
          im.src = it.src;
        });
        ctx.drawImage(
          img,
          (it.x - minX) * k,
          (it.y - minY) * k,
          it.w * k,
          it.h * k,
        );
      }
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/png"),
      );
      if (!blob) throw new Error("Export failed");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(current?.name ?? "quadro").replace(/[\\/:*?"<>|]+/g, "_")}${suffix}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Exportado");
    } catch {
      setStatus("Não foi possível exportar");
    }
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
    setStatus("Salvando…");
  };

  return (
    <>
      <div className="bar">
        <button onClick={() => setSideOpen((o) => !o)} aria-expanded={sideOpen}>
          {sideOpen ? "Ocultar quadros" : "Quadros"}
        </button>
        <h1>{current?.name ?? "Quadro"}</h1>
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
          Adicionar imagens
        </button>
        <button
          className={textMode ? "primary" : undefined}
          onClick={() => setTextMode((m) => !m)}
        >
          {textMode ? "Clique no canvas…" : "Adicionar texto"}
        </button>
        {selIsText && (
          <>
            <select
              aria-label="Fonte do texto"
              value={selItem?.ff ?? "sans"}
              onChange={(e) => updateSelected({ ff: e.target.value })}
              style={{
                font: "inherit",
                color: "var(--ink)",
                background: "var(--board)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "6px 8px",
              }}
            >
              {Object.entries(FONTS).map(([k, f]) => (
                <option key={k} value={k}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              type="color"
              aria-label="Cor do texto"
              title="Cor do texto"
              value={
                selItem?.color ??
                (getComputedStyle(document.documentElement)
                  .getPropertyValue("--ink")
                  .trim() ||
                  "#000000")
              }
              onChange={(e) => updateSelected({ color: e.target.value })}
              style={{ width: 36, height: 32, padding: 2, cursor: "pointer" }}
            />
            {selItem?.color && (
              <button onClick={() => updateSelected({ color: undefined })}>
                Cor do tema
              </button>
            )}
          </>
        )}
        <button
          disabled={!pan.x && !pan.y && scale === 1}
          onClick={() => {
            setPan({ x: 0, y: 0 });
            setScale(1);
          }}
        >
          Redefinir visão{scale !== 1 ? ` (${Math.round(scale * 100)}%)` : ""}
        </button>
        <button disabled={!items.length} onClick={() => exportPng(items)}>
          Exportar PNG
        </button>
        {sel && (
          <>
            <button
              onClick={() => {
                const it = items.find((i) => i.id === sel);
                if (it) exportPng([it], "-selecionado");
              }}
            >
              Exportar selecionado
            </button>
            <button onClick={removeSelected}>Excluir selecionado</button>
          </>
        )}
        <button disabled={!items.length} onClick={clearAll}>
          {confirmClear ? "Clique de novo para limpar tudo" : "Limpar quadro"}
        </button>
      </div>

      <div className="main">
        <aside
          className={"side" + (sideOpen ? "" : " closed")}
          aria-label="Quadros"
        >
          <div
            className="side-in"
            style={{ display: "flex", flexDirection: "column" }}
          >
            <button className="primary wide" onClick={newBoard}>
              Novo quadro
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
                    <button onClick={() => setEditing(b.id)}>Renomear</button>
                    <button onClick={() => deleteBoard(b.id)}>
                      {confirmDelete === b.id ? "Certeza?" : "Excluir"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div
              className="status"
              style={{ marginTop: "auto", paddingTop: 16 }}
            >
              Desenvolvido por{" "}
              <a
                href="https://next-frontend-portifolio.vercel.app/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)" }}
              >
                Lucas Figueiredo
              </a>
            </div>
          </div>
        </aside>

        <div
          ref={scroller}
          className={"viewport" + (over ? " over" : "")}
          style={{
            backgroundPosition: `${pan.x}px ${pan.y}px`,
            backgroundSize: `${28 * scale}px ${28 * scale}px`,
            cursor: textMode ? "crosshair" : undefined,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
        >
          {!items.length && (
            <div className="empty">
              <div>
                <b>Solte imagens aqui</b>
                Arraste arquivos do seu computador, cole da área de
                transferência ou use Adicionar imagens. Arraste o fundo para se
                mover e use a roda do mouse para dar zoom.
              </div>
            </div>
          )}
          <div
            className="board"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            {items.map((it) => (
              <div
                key={it.id}
                data-id={it.id}
                className={"item" + (sel === it.id ? " sel" : "")}
                style={{
                  left: it.x,
                  top: it.y,
                  width: it.w,
                  height: it.h,
                  zIndex: it.z,
                }}
                onDoubleClick={() => {
                  if (it.type === "text") setEditingText(it.id);
                }}
                onPointerDown={(e) => startDrag(e, it, "move")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
              >
                {it.type === "text" ? (
                  editingText === it.id ? (
                    <textarea
                      ref={textRef}
                      value={it.text ?? ""}
                      onChange={(e) => {
                        const ta = e.currentTarget;
                        const value = ta.value;
                        // measure the content height so the node grows with the text
                        ta.style.height = "auto";
                        const h = ta.scrollHeight;
                        ta.style.height = "";
                        setItems((p) =>
                          p.map((i) =>
                            i.id === it.id
                              ? {
                                  ...i,
                                  text: value,
                                  h: Math.max(
                                    Math.round((i.fs ?? 24) * 1.3),
                                    h,
                                  ),
                                }
                              : i,
                          ),
                        );
                        setStatus("Salvando…");
                      }}
                      onBlur={(e) => {
                        const empty = !e.currentTarget.value.trim();
                        setEditingText(null);
                        if (empty) {
                          setItems((p) => p.filter((i) => i.id !== it.id));
                          setSel((s) => (s === it.id ? null : s));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") e.currentTarget.blur();
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        height: "100%",
                        boxSizing: "border-box",
                        margin: 0,
                        padding: 0,
                        border: "none",
                        outline: "none",
                        resize: "none",
                        overflow: "hidden",
                        background: "transparent",
                        color: it.color ?? "var(--ink)",
                        fontFamily: fontCss(it.ff),
                        fontSize: it.fs ?? 24,
                        lineHeight: 1.3,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        cursor: "text",
                        userSelect: "text",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        color: it.color ?? "var(--ink)",
                        fontFamily: fontCss(it.ff),
                        fontSize: it.fs ?? 24,
                        lineHeight: 1.3,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {it.text}
                    </div>
                  )
                ) : (
                  <img src={it.src} alt="" draggable={false} />
                )}
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

      {themeOpen && (
        <div
          onClick={() => setThemeOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 49 }}
        />
      )}
      <div
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {themeOpen && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 8,
              background: "var(--bar)",
              border: "1px solid var(--line)",
              borderRadius: 999,
              boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            }}
          >
            {(Object.keys(THEMES) as ThemeKey[]).map((k) => (
              <button
                key={k}
                title={THEMES[k].label}
                aria-label={`Tema ${THEMES[k].label}`}
                aria-pressed={theme === k}
                onClick={() => {
                  setTheme(k);
                  setThemeOpen(false);
                }}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${THEMES[k].vars["--board"]} 50%, ${THEMES[k].vars["--accent"]} 50%)`,
                  border:
                    theme === k
                      ? "2px solid var(--accent)"
                      : "2px solid var(--line)",
                }}
              />
            ))}
          </div>
        )}
        <button
          title="Mudar tema"
          aria-label="Mudar tema"
          aria-expanded={themeOpen}
          onClick={() => setThemeOpen((o) => !o)}
          style={{
            width: 40,
            height: 40,
            padding: 0,
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, var(--board) 50%, var(--accent) 50%)",
            border: "2px solid var(--accent)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        />
      </div>
    </>
  );
}
