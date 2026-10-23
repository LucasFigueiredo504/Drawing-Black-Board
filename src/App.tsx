import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, PointerEvent } from "react";
import {
  Download,
  Eraser,
  FileDown,
  FileUp,
  Frame,
  ImageDown,
  ImagePlus,
  Maximize,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Trash2,
  Type,
} from "lucide-react";
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
  // when moving a group: starting positions of the items inside it
  members?: Record<string, { x: number; y: number }>;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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

const themeVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Items that sit completely inside a group's frame (they move with it)
const membersOf = (g: Item, list: Item[]) =>
  list.filter(
    (i) =>
      i.id !== g.id &&
      i.x >= g.x - 1 &&
      i.y >= g.y - 1 &&
      i.x + i.w <= g.x + g.w + 1 &&
      i.y + i.h <= g.y + g.h + 1,
  );

const MIN_GROUP_W = 80;
const MIN_GROUP_H = 60;

// ---- Board files (export / import) ----
const FILE_APP = "whiteboard";

async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

// Reads a board file, whether it's gzip-compressed or plain JSON
async function readBoardFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([buf])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buf);
}

const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

const hexOrUndef = (v: unknown) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;

// Validate imported items and keep only known fields (with fresh ids)
function cleanItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) throw new Error("Invalid file");
  const out: Item[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const base = {
      id: crypto.randomUUID(),
      x: num(o.x, 0),
      y: num(o.y, 0),
      w: Math.max(1, num(o.w, 100)),
      h: Math.max(1, num(o.h, 100)),
      z: num(o.z, out.length + 1),
    };
    if (o.type === "text") {
      out.push({
        ...base,
        src: "",
        type: "text",
        text: typeof o.text === "string" ? o.text : "",
        fs: num(o.fs, 24),
        ff: typeof o.ff === "string" && o.ff in FONTS ? o.ff : undefined,
        color: hexOrUndef(o.color),
      });
    } else if (o.type === "group") {
      out.push({
        ...base,
        z: 0,
        src: "",
        type: "group",
        text: typeof o.text === "string" ? o.text.slice(0, 120) : "",
        color: hexOrUndef(o.color),
      });
    } else if (typeof o.src === "string" && o.src.startsWith("data:image/")) {
      out.push({ ...base, src: o.src });
    }
  }
  return out;
}

const ICON = 18;
const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "6px 9px",
};

const actBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

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
  const [groupMode, setGroupMode] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [draw, setDraw] = useState<Rect | null>(null);
  // Board list reordering (drag & drop in the side menu)
  const [dragBoard, setDragBoard] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{
    id: string;
    after: boolean;
  } | null>(null);

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
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const drawRect = useRef<Rect | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const drag = useRef<DragState | null>(null);
  const zTop = useRef(1);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const groupRef = useRef<HTMLInputElement>(null);

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

  // Focus the title input when a group enters title edit mode
  useEffect(() => {
    if (!editingGroup) return;
    const t = setTimeout(() => {
      const el = groupRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 50);
    return () => clearTimeout(t);
  }, [editingGroup]);

  const showBoard = (id: string, list: Item[]) => {
    activeId.current = id;
    zTop.current = topZ(list);
    setItems(list);
    setSel(null);
    setPan({ x: 0, y: 0 });
    setScale(1);
    setEditingText(null);
    setEditingGroup(null);
    setGroupMode(false);
    setDraw(null);
    drawStart.current = null;
    drawRect.current = null;
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

  // Move a board before/after another one in the side list (saved with the library)
  const reorderBoards = (fromId: string, toId: string, after: boolean) => {
    if (!lib || fromId === toId) return;
    const moved = lib.boards.find((b) => b.id === fromId);
    if (!moved) return;
    const list = lib.boards.filter((b) => b.id !== fromId);
    let idx = list.findIndex((b) => b.id === toId);
    if (idx < 0) return;
    if (after) idx++;
    list.splice(idx, 0, moved);
    persistLibrary({ ...lib, boards: list });
  };

  const endBoardDrag = () => {
    setDragBoard(null);
    setDropMark(null);
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
      if (e.key === "Escape") {
        setTextMode(false);
        setGroupMode(false);
        setDraw(null);
        drawStart.current = null;
        drawRect.current = null;
      }
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

  // Screen coordinates -> board coordinates
  const toBoard = (cx: number, cy: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - panRef.current.x) / scaleRef.current,
      y: (cy - r.top - panRef.current.y) / scaleRef.current,
    };
  };

  const startDrag = (
    e: PointerEvent<HTMLDivElement>,
    it: Item,
    mode: DragState["mode"],
  ) => {
    // Group tool active: let the press bubble up so a frame can be drawn
    if (groupMode) return;
    // While a text/title is being edited, let the input handle the pointer
    if (editingText === it.id || editingGroup === it.id) {
      e.stopPropagation();
      return;
    }
    // Only the left button selects/moves/resizes; other buttons
    // (middle = pan) bubble up to the viewport
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel(it.id);
    // Groups always stay behind the other items
    if (it.type !== "group") {
      const z = zTop.current++;
      setItems((p) => p.map((i) => (i.id === it.id ? { ...i, z } : i)));
    }
    // Moving a group also moves everything fully inside its frame
    let members: DragState["members"];
    if (it.type === "group" && mode === "move") {
      members = {};
      for (const m of membersOf(it, items)) members[m.id] = { x: m.x, y: m.y };
    }
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
      members,
    };
  };

  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    setItems((p) =>
      p.map((i) => {
        if (i.id !== d.id) {
          const m = d.members?.[i.id];
          return m ? { ...i, x: m.x + dx, y: m.y + dy } : i;
        }
        if (d.mode === "move") return { ...i, x: d.ox + dx, y: d.oy + dy };
        // groups resize freely (no aspect ratio, content is not scaled)
        if (i.type === "group") {
          return {
            ...i,
            w: Math.max(MIN_GROUP_W, d.ow + dx),
            h: Math.max(MIN_GROUP_H, d.oh + dy),
          };
        }
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
    // Group tool: start drawing the frame
    if (groupMode && e.button === 0) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = toBoard(e.clientX, e.clientY);
      drawStart.current = p;
      drawRect.current = { x: p.x, y: p.y, w: 0, h: 0 };
      setDraw(drawRect.current);
      setSel(null);
      return;
    }
    // Text tool: a click on empty canvas creates a text node and edits it
    if (
      textMode &&
      e.button === 0 &&
      !(e.target as HTMLElement).closest(".item")
    ) {
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
    const onItem = !!(e.target as HTMLElement).closest(".item");
    // Left click on empty canvas only deselects
    if (!onItem && e.button === 0) setSel(null);
    // Pan only with the middle button (mouse wheel pressed); touch can still
    // pan by dragging the empty canvas since it has no middle button
    const canPan = e.button === 1 || (e.pointerType === "touch" && !onItem);
    if (!canPan) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    panDrag.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
  };
  const movePan = (e: PointerEvent<HTMLDivElement>) => {
    const s = drawStart.current;
    if (s) {
      const p = toBoard(e.clientX, e.clientY);
      const r = {
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      };
      drawRect.current = r;
      setDraw(r);
      return;
    }
    const d = panDrag.current;
    if (!d) return;
    setPan({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
  };
  const endPan = () => {
    panDrag.current = null;
    if (!drawStart.current) return;
    const r = drawRect.current;
    drawStart.current = null;
    drawRect.current = null;
    setDraw(null);
    // ignore accidental clicks / tiny drags (the tool stays active)
    if (!r || r.w < 24 || r.h < 24) return;
    const id = crypto.randomUUID();
    setItems((p) => [
      ...p,
      {
        id,
        src: "",
        type: "group",
        text: "Grupo",
        x: r.x,
        y: r.y,
        w: Math.max(MIN_GROUP_W, r.w),
        h: Math.max(MIN_GROUP_H, r.h),
        z: 0,
      },
    ]);
    setSel(id);
    setEditingGroup(id); // type the title right away
    setGroupMode(false);
    setStatus("Salvando…");
  };

  // ---- Text / group styling ----
  const selItem = items.find((i) => i.id === sel);
  const selIsText = selItem?.type === "text";
  const selIsGroup = selItem?.type === "group";

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

  // Render every item of the list into a single PNG and download it
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
      ctx.fillStyle = themeVar("--board") || "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      const ink = themeVar("--ink") || "#000";
      const accent = themeVar("--accent") || "#2f6fed";
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
      const roundRect = (
        x: number,
        y: number,
        w: number,
        h: number,
        r: number,
      ) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      };
      for (const it of [...list].sort((a, b) => a.z - b.z)) {
        if (it.type === "group") {
          const c = it.color ?? accent;
          const gx = (it.x - minX) * k;
          const gy = (it.y - minY) * k;
          const gw = it.w * k;
          const gh = it.h * k;
          ctx.save();
          roundRect(gx, gy, gw, gh, 10 * k);
          ctx.globalAlpha = 0.08;
          ctx.fillStyle = c;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = c;
          ctx.lineWidth = 2 * k;
          ctx.stroke();
          const fam = fontCss();
          try {
            await document.fonts.load(`600 ${16 * k}px ${fam}`);
          } catch {
            /* ignore */
          }
          ctx.font = `600 ${16 * k}px ${fam}`;
          ctx.fillStyle = c;
          ctx.textBaseline = "bottom";
          ctx.fillText(it.text || "Grupo", gx, gy - 10 * k, gw);
          ctx.restore();
          continue;
        }
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

  // Save one board to a file (gzip-compressed when the browser supports it)
  const exportBoard = async (id: string) => {
    const meta = boards.find((b) => b.id === id);
    if (!meta) return;
    setStatus("Exportando…");
    try {
      const list = id === lib?.current ? items : await loadItems(id);
      const json = JSON.stringify({
        app: FILE_APP,
        version: 1,
        name: meta.name,
        items: list,
      });
      const packed = typeof CompressionStream !== "undefined";
      const blob = packed
        ? await gzipText(json)
        : new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${meta.name.replace(/[\\/:*?"<>|]+/g, "_")}.${packed ? "BlackBoard" : "BlackBoard.json"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Quadro exportado");
    } catch {
      setStatus("Não foi possível exportar");
    }
  };

  // Add a board from a file as a NEW board (never overwrites existing ones)
  const importBoard = async (file: File) => {
    if (!lib) return;
    setStatus("Importando…");
    try {
      const data = JSON.parse(await readBoardFile(file));
      if (!data || data.app !== FILE_APP || !Array.isArray(data.items)) {
        throw new Error("Invalid file");
      }
      const list = cleanItems(data.items);
      const name =
        typeof data.name === "string" && data.name.trim()
          ? data.name.trim().slice(0, 80)
          : `Quadro ${lib.boards.length + 1}`;
      try {
        await saveItems(lib.current, items);
      } catch {
        /* keep going */
      }
      const id = crypto.randomUUID();
      await saveItems(id, list);
      showBoard(id, list);
      persistLibrary({ boards: [...lib.boards, { id, name }], current: id });
      setStatus("Quadro importado");
    } catch {
      setStatus("Arquivo inválido");
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
        <button
          onClick={() => setSideOpen((o) => !o)}
          aria-expanded={sideOpen}
          title={sideOpen ? "Ocultar quadros" : "Mostrar quadros"}
          aria-label={sideOpen ? "Ocultar quadros" : "Mostrar quadros"}
          style={iconBtn}
        >
          {sideOpen ? (
            <PanelLeftClose size={ICON} />
          ) : (
            <PanelLeft size={ICON} />
          )}
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
        <button
          className="primary"
          onClick={() => fileInput.current?.click()}
          title="Adicionar imagens"
          aria-label="Adicionar imagens"
          style={iconBtn}
        >
          <ImagePlus size={ICON} />
        </button>
        <button
          className={textMode ? "primary" : undefined}
          onClick={() => {
            setTextMode((m) => !m);
            setGroupMode(false);
          }}
          title="Adicionar texto"
          aria-label="Adicionar texto"
          aria-pressed={textMode}
          style={iconBtn}
        >
          <Type size={ICON} />
          {textMode && "Clique no canvas…"}
        </button>
        <button
          className={groupMode ? "primary" : undefined}
          onClick={() => {
            setGroupMode((m) => !m);
            setTextMode(false);
          }}
          title="Criar grupo (desenhe um quadro ao redor dos itens)"
          aria-label="Criar grupo"
          aria-pressed={groupMode}
          style={iconBtn}
        >
          <Frame size={ICON} />
          {groupMode && "Desenhe o quadro…"}
        </button>
        {(selIsText || selIsGroup) && (
          <>
            {selIsText && (
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
            )}
            {selIsGroup && sel && (
              <button
                onClick={() => setEditingGroup(sel)}
                title="Renomear grupo"
                aria-label="Renomear grupo"
                style={iconBtn}
              >
                <Pencil size={ICON} />
              </button>
            )}
            <input
              type="color"
              aria-label={selIsGroup ? "Cor do grupo" : "Cor do texto"}
              title={selIsGroup ? "Cor do grupo" : "Cor do texto"}
              value={
                selItem?.color ??
                (selIsGroup
                  ? themeVar("--accent") || "#2f6fed"
                  : themeVar("--ink") || "#000000")
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
          title="Redefinir visão"
          aria-label="Redefinir visão"
          style={iconBtn}
        >
          <Maximize size={ICON} />
          {scale !== 1 && `${Math.round(scale * 100)}%`}
        </button>
        <button
          disabled={!items.length}
          onClick={() => exportPng(items)}
          title="Exportar PNG"
          aria-label="Exportar PNG"
          style={iconBtn}
        >
          <Download size={ICON} />
        </button>
        {sel && (
          <>
            <button
              onClick={() => {
                const it = items.find((i) => i.id === sel);
                if (!it) return;
                // a group is exported together with everything inside it
                exportPng(
                  it.type === "group" ? [it, ...membersOf(it, items)] : [it],
                  "-selecionado",
                );
              }}
              title="Exportar selecionado"
              aria-label="Exportar selecionado"
              style={iconBtn}
            >
              <ImageDown size={ICON} />
            </button>
            <button
              onClick={removeSelected}
              title={
                selIsGroup
                  ? "Desfazer grupo (os itens ficam no quadro)"
                  : "Excluir selecionado"
              }
              aria-label={selIsGroup ? "Desfazer grupo" : "Excluir selecionado"}
              style={iconBtn}
            >
              <Trash2 size={ICON} />
            </button>
          </>
        )}
        <button
          disabled={!items.length}
          onClick={clearAll}
          title="Limpar quadro"
          aria-label="Limpar quadro"
          style={iconBtn}
        >
          <Eraser size={ICON} />
          {confirmClear && "Clique de novo para limpar tudo"}
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
            <input
              ref={importInput}
              type="file"
              accept=".BlackBoard,.json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBoard(f);
                e.target.value = "";
              }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="primary"
                onClick={newBoard}
                style={{ flex: 1, minWidth: 0 }}
              >
                Novo quadro
              </button>
              <button
                onClick={() => importInput.current?.click()}
                title="Importar quadro"
                aria-label="Importar quadro"
                style={iconBtn}
              >
                <FileUp size={ICON} />
              </button>
            </div>
            <ul>
              {boards.map((b) => (
                <li
                  key={b.id}
                  className={
                    "row" +
                    (b.id === lib?.current ? " active" : "") +
                    (dragBoard === b.id ? " dragging" : "") +
                    (dropMark?.id === b.id
                      ? dropMark.after
                        ? " drop-after"
                        : " drop-before"
                      : "")
                  }
                  draggable={editing !== b.id}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", b.id); // required by Firefox
                    setDragBoard(b.id);
                  }}
                  onDragOver={(e) => {
                    if (!dragBoard) return; // ignore file drags
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > r.top + r.height / 2;
                    setDropMark((m) =>
                      m && m.id === b.id && m.after === after
                        ? m
                        : { id: b.id, after },
                    );
                  }}
                  onDrop={(e) => {
                    if (!dragBoard) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    reorderBoards(
                      dragBoard,
                      b.id,
                      e.clientY > r.top + r.height / 2,
                    );
                    endBoardDrag();
                  }}
                  onDragEnd={endBoardDrag}
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
                    <button
                      onClick={() => setEditing(b.id)}
                      title="Renomear"
                      aria-label="Renomear"
                      style={actBtn}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => exportBoard(b.id)}
                      title="Exportar quadro"
                      aria-label="Exportar quadro"
                      style={actBtn}
                    >
                      <FileDown size={15} />
                    </button>
                    <button
                      onClick={() => deleteBoard(b.id)}
                      title="Excluir"
                      aria-label="Excluir"
                      style={actBtn}
                    >
                      <Trash2 size={15} />
                      {confirmDelete === b.id && "Certeza?"}
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
            cursor: textMode || groupMode ? "crosshair" : "default",
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onMouseDown={(e) => {
            // avoid the browser's middle-click autoscroll
            if (e.button === 1) e.preventDefault();
          }}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
        >
          {!items.length && (
            <div className="empty">
              <div>
                <b>Solte imagens aqui</b>
                Arraste arquivos do seu computador, cole da área de
                transferência ou use Adicionar imagens. Segure a roda do mouse
                (botão do meio) e arraste para se mover; gire a roda para dar
                zoom.
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
            {items.map((it) => {
              const isGroup = it.type === "group";
              const gc = it.color ?? "var(--accent)";
              return (
                <div
                  key={it.id}
                  data-id={it.id}
                  className={"item" + (sel === it.id ? " sel" : "")}
                  style={{
                    left: it.x,
                    top: it.y,
                    width: it.w,
                    height: it.h,
                    // groups sit behind every other item
                    zIndex: isGroup ? 0 : it.z,
                  }}
                  onDoubleClick={() => {
                    if (it.type === "text") setEditingText(it.id);
                    if (isGroup) setEditingGroup(it.id);
                  }}
                  onPointerDown={(e) => startDrag(e, it, "move")}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                >
                  {isGroup ? (
                    <>
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          boxSizing: "border-box",
                          border: `2px solid ${gc}`,
                          borderRadius: 10,
                          background: `color-mix(in srgb, ${gc} 8%, transparent)`,
                        }}
                      />
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          top: -32,
                          width: "100%",
                          height: 28,
                        }}
                      >
                        {editingGroup === it.id ? (
                          <input
                            ref={groupRef}
                            value={it.text ?? ""}
                            placeholder="Título do grupo"
                            maxLength={120}
                            onChange={(e) => {
                              const value = e.target.value;
                              setItems((p) =>
                                p.map((i) =>
                                  i.id === it.id ? { ...i, text: value } : i,
                                ),
                              );
                              setStatus("Salvando…");
                            }}
                            onBlur={() => setEditingGroup(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Escape")
                                e.currentTarget.blur();
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
                              background: "transparent",
                              color: gc,
                              fontFamily: fontCss(),
                              fontSize: 16,
                              fontWeight: 600,
                              userSelect: "text",
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              color: gc,
                              fontFamily: fontCss(),
                              fontSize: 16,
                              fontWeight: 600,
                              lineHeight: "28px",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {it.text || "Grupo"}
                          </div>
                        )}
                      </div>
                    </>
                  ) : it.type === "text" ? (
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
              );
            })}
            {draw && (
              <div
                style={{
                  position: "absolute",
                  left: draw.x,
                  top: draw.y,
                  width: draw.w,
                  height: draw.h,
                  boxSizing: "border-box",
                  border: "2px dashed var(--accent)",
                  borderRadius: 10,
                  background:
                    "color-mix(in srgb, var(--accent) 8%, transparent)",
                  pointerEvents: "none",
                  zIndex: 100000,
                }}
              />
            )}
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
