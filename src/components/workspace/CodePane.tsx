import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileCode,
  FileJson,
  FilePlus,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Save,
  Search,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useViewportBreakpoints } from '../../hooks/useMediaQuery';
import { COPY } from '../../i18n';
import type { Locale, ProjectFile, ThemeMode } from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';

// Configure Monaco to use local bundled workers (no external CDN fetches)
if (typeof self !== 'undefined') {
  const g = self as unknown as {
    MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
  };
  if (!g.MonacoEnvironment) {
    g.MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        if (label === 'json') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
      },
    };
  }
}
loader.config({ monaco });

interface CodePaneProps {
  locale: Locale;
  theme: ThemeMode;
  files: ProjectFile[];
  onSaveFile: (path: string, content: string) => Promise<void>;
  onDeleteFile: (path: string) => Promise<void>;
  onDirtyChange?: (hasDirty: boolean) => void;
  onOpenMobileTerminal?: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: TreeNode[];
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  type: 'file' | 'folder';
}

function getMonacoLanguage(filePath: string): { id: string; label: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
      return { id: 'html', label: 'HTML' };
    case 'css':
      return { id: 'css', label: 'CSS' };
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return { id: 'javascript', label: ext === 'jsx' ? 'JavaScript JSX' : 'JavaScript' };
    case 'ts':
      return { id: 'typescript', label: 'TypeScript' };
    case 'tsx':
      return { id: 'typescript', label: 'TypeScript JSX' };
    case 'json':
      return { id: 'json', label: 'JSON' };
    case 'sql':
      return { id: 'sql', label: 'SQL' };
    case 'md':
    case 'markdown':
      return { id: 'markdown', label: 'Markdown' };
    case 'xml':
    case 'svg':
      return { id: 'xml', label: ext.toUpperCase() };
    default:
      return { id: 'plaintext', label: 'Plain Text' };
  }
}

function buildFileTree(files: ProjectFile[], extraFolders: string[]): TreeNode[] {
  interface MutableFolder {
    name: string;
    path: string;
    folders: Map<string, MutableFolder>;
    files: Map<string, TreeNode>;
  }

  const root: MutableFolder = { name: '', path: '', folders: new Map(), files: new Map() };

  function ensureFolder(folderPath: string): MutableFolder {
    const parts = folderPath.split('/').filter(Boolean);
    let current = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = current.folders.get(part);
      if (!next) {
        next = { name: part, path: acc, folders: new Map(), files: new Map() };
        current.folders.set(part, next);
      }
      current = next;
    }
    return current;
  }

  for (const folderPath of extraFolders) {
    if (folderPath.trim()) ensureFolder(folderPath.trim().replace(/^\/+|\/+$/g, ''));
  }

  for (const file of files) {
    const clean = file.path.replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = parentPath ? ensureFolder(parentPath) : root;
    parent.files.set(fileName, { name: fileName, path: clean, type: 'file' });
  }

  function toNodes(folder: MutableFolder): TreeNode[] {
    const folderNodes: TreeNode[] = Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        name: f.name,
        path: f.path,
        type: 'folder' as const,
        children: toNodes(f),
      }));

    const fileNodes: TreeNode[] = Array.from(folder.files.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return [...folderNodes, ...fileNodes];
  }

  return toNodes(root);
}

function FileIcon({ fileName }: { fileName: string }) {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
    case 'js':
    case 'mjs':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return <FileCode className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />;
    case 'css':
      return <FileType className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />;
    case 'json':
      return <FileJson className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />;
    case 'sql':
      return <Database className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />;
    default:
      return <FileText className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />;
  }
}

export function CodePane({
  locale,
  theme,
  files,
  onSaveFile,
  onDeleteFile,
  onDirtyChange,
  onOpenMobileTerminal,
}: CodePaneProps) {
  const t = COPY[locale];
  const isDark = theme === 'dark';
  const { isMobile } = useViewportBreakpoints();

  const [openTabs, setOpenTabs] = useState<string[]>(() => (files[0]?.path ? [files[0].path] : []));
  const [activePath, setActivePath] = useState<string>(() => files[0]?.path || '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [creatingMode, setCreatingMode] = useState<'none' | 'file' | 'folder'>('none');
  const [newItemPath, setNewItemPath] = useState('');

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameSubmittingRef = useRef(false);

  const [deleteTarget, setDeleteTarget] = useState<{ path: string; type: 'file' | 'folder' } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [sidebarMode, setSidebarMode] = useState<'explorer' | 'search'>('explorer');
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState<{ line: number; seq: number } | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveActionRef = useRef<() => void>(() => {});

  const subscribeReducedMotion = useCallback((onStoreChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener('change', onStoreChange);
    return () => mq.removeEventListener('change', onStoreChange);
  }, []);
  const getReducedMotionSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);

  useEffect(() => {
    if (!contextMenu) return;
    function close() {
      setContextMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setContextMenu(null);
    }
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const fileMap = useMemo(() => {
    const map = new Map<string, ProjectFile>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  const effectiveOpenTabs = useMemo(() => {
    const existing = openTabs.filter((p) => fileMap.has(p));
    if (existing.length === 0 && files[0]?.path) {
      return [files[0].path];
    }
    return existing;
  }, [openTabs, fileMap, files]);

  const effectiveActivePath =
    activePath && fileMap.has(activePath) ? activePath : (files[0]?.path || '');

  const currentFile = effectiveActivePath ? fileMap.get(effectiveActivePath) ?? null : null;
  const activeContent = currentFile ? (drafts[currentFile.path] ?? currentFile.content) : '';
  const isDirty = useCallback(
    (path: string) => {
      const file = fileMap.get(path);
      return file !== undefined && drafts[path] !== undefined && drafts[path] !== file.content;
    },
    [fileMap, drafts]
  );
  const currentDirty = currentFile ? isDirty(currentFile.path) : false;

  const hasAnyDirty = useMemo(
    () => files.some((f) => drafts[f.path] !== undefined && drafts[f.path] !== f.content),
    [files, drafts]
  );

  useEffect(() => {
    onDirtyChange?.(hasAnyDirty);
  }, [hasAnyDirty, onDirtyChange]);

  useEffect(() => {
    if (!revealRequest) return;
    const targetLine = revealRequest.line;
    const timer = window.setTimeout(() => {
      if (editorRef.current && targetLine > 0) {
        editorRef.current.revealLineInCenter(targetLine);
        editorRef.current.setPosition({ lineNumber: targetLine, column: 1 });
        editorRef.current.focus();
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [revealRequest]);

  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const openFile = useCallback(
    (path: string, line?: number) => {
      setOpenTabs((prev) => {
        const base = prev.filter((p) => fileMap.has(p));
        return base.includes(path) ? base : [...base, path];
      });
      setActivePath(path);
      setCursor({ line: line || 1, column: 1 });
      if (isMobile) setMobileDrawerOpen(false);
      if (line && line > 0) {
        setRevealRequest((prev) => ({ line, seq: (prev?.seq ?? 0) + 1 }));
      }
    },
    [fileMap, isMobile]
  );

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ path: string; line: number; snippet: string }> = [];
    for (const file of files) {
      const content = drafts[file.path] ?? file.content;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({
            path: file.path,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 90),
          });
          if (results.length >= 100) return results;
        }
      }
    }
    return results;
  }, [files, drafts, searchQuery]);

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.indexOf(path);
        if (idx === -1) return prev;
        const next = prev.filter((p) => p !== path);
        if (activePath === path) {
          const fallback = next[Math.min(idx, next.length - 1)] || '';
          setActivePath(fallback);
        }
        return next;
      });
      setDrafts((prev) => {
        if (!(path in prev)) return prev;
        const copy = { ...prev };
        delete copy[path];
        return copy;
      });
    },
    [activePath]
  );

  const handleSave = useCallback(async () => {
    if (!currentFile || saving) return;
    const contentToSave = drafts[currentFile.path];
    if (contentToSave === undefined || contentToSave === currentFile.content) return;
    setActionError(null);
    setSaving(true);
    try {
      await onSaveFile(currentFile.path, contentToSave);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[currentFile.path];
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.codeActionFail);
    } finally {
      setSaving(false);
    }
  }, [currentFile, drafts, onSaveFile, saving, t.codeActionFail]);

  useEffect(() => {
    saveActionRef.current = () => {
      void handleSave();
    };
  }, [handleSave]);

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clean = newItemPath.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) {
      setCreatingMode('none');
      return;
    }
    setActionError(null);
    try {
      if (creatingMode === 'folder') {
        setExtraFolders((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
        setCollapsedFolders((prev) => ({ ...prev, [clean]: false }));
      } else if (creatingMode === 'file') {
        await onSaveFile(clean, '');
        openFile(clean);
      }
      setNewItemPath('');
      setCreatingMode('none');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.codeActionFail);
    }
  }

  async function commitRename() {
    if (renameSubmittingRef.current || !renamingPath) return;
    renameSubmittingRef.current = true;
    const sourcePath = renamingPath;
    const target = renameValue.trim().replace(/^\/+|\/+$/g, '');
    const original = fileMap.get(sourcePath);
    setRenamingPath(null);
    try {
      if (!original || !target || target === sourcePath) return;
      setActionError(null);
      const content = drafts[sourcePath] ?? original.content;
      await onSaveFile(target, content);
      if (sourcePath !== 'index.html') {
        await onDeleteFile(sourcePath);
      }
      setOpenTabs((prev) => prev.map((p) => (p === sourcePath ? target : p)));
      if (activePath === sourcePath) setActivePath(target);
      setDrafts((prev) => {
        if (!(sourcePath in prev)) return prev;
        const next = { ...prev };
        delete next[sourcePath];
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t.codeActionFail);
    } finally {
      renameSubmittingRef.current = false;
    }
  }

  async function confirmDeleteTarget() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (deleteTarget.type === 'file') {
        if (deleteTarget.path === 'index.html') {
          setDeleteTarget(null);
          return;
        }
        await onDeleteFile(deleteTarget.path);
        closeTab(deleteTarget.path);
      } else {
        setExtraFolders((prev) =>
          prev.filter((f) => f !== deleteTarget.path && !f.startsWith(`${deleteTarget.path}/`))
        );
        const nestedFiles = files.filter(
          (f) => f.path.startsWith(`${deleteTarget.path}/`) && f.path !== 'index.html'
        );
        for (const nf of nestedFiles) {
          await onDeleteFile(nf.path);
          closeTab(nf.path);
        }
      }
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t.codeActionFail);
    } finally {
      setDeleting(false);
    }
  }

  async function handleCopyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedNotice(t.copiedPathNotice.replace('{path}', path));
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedNotice(null);
      }, 2000);
    } catch {
      // Clipboard may be unavailable in restricted iframe
    }
  }

  const handleBeforeMount: BeforeMount = useCallback((monacoInstance) => {
    monacoInstance.editor.defineTheme('carmen-vs-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0E0F11',
        'editor.foreground': '#E8E9EA',
        'editorLineNumber.foreground': '#8B8F96',
        'editorLineNumber.activeForeground': '#E8E9EA',
        'editor.lineHighlightBackground': '#1B1D20',
        'editor.selectionBackground': '#3A2027',
        'editor.inactiveSelectionBackground': '#26282C',
        'editorCursor.foreground': '#E8E9EA',
        'editorIndentGuide.background1': '#26282C',
        'editorIndentGuide.activeBackground1': '#656B75',
      },
    });
    monacoInstance.editor.defineTheme('carmen-vs-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#1A1A1A',
        'editorLineNumber.foreground': '#6B6F76',
        'editorLineNumber.activeForeground': '#1A1A1A',
        'editor.lineHighlightBackground': '#F3F3F1',
        'editor.selectionBackground': '#F3D5DB',
        'editor.inactiveSelectionBackground': '#E4E4E1',
        'editorCursor.foreground': '#1A1A1A',
        'editorIndentGuide.background1': '#E4E4E1',
        'editorIndentGuide.activeBackground1': '#858991',
      },
    });
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((ev) => {
      setCursor({ line: ev.position.lineNumber, column: ev.position.column });
    });
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      saveActionRef.current();
    });
  }, []);

  const treeNodes = useMemo(() => buildFileTree(files, extraFolders), [files, extraFolders]);
  const langInfo = currentFile ? getMonacoLanguage(currentFile.path) : { id: 'plaintext', label: 'Plain Text' };

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes.map((node) => {
      const paddingLeft = depth * 10 + 8;

      if (node.type === 'folder') {
        const isCollapsed = Boolean(collapsedFolders[node.path]);
        return (
          <div key={`folder:${node.path}`}>
            <button
              type="button"
              onClick={() =>
                setCollapsedFolders((prev) => ({ ...prev, [node.path]: !prev[node.path] }))
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, path: node.path, type: 'folder' });
              }}
              style={{ paddingLeft: `${paddingLeft}px` }}
              className="w-full h-7 pr-2 flex items-center gap-1.5 text-[13px] text-left select-none cursor-pointer text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              {isCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.75} />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.75} />
              )}
              {isCollapsed ? (
                <Folder className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              ) : (
                <FolderOpen className="w-4 h-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {!isCollapsed && node.children && renderNodes(node.children, depth + 1)}
          </div>
        );
      }

      const active = activePath === node.path;
      const dirty = isDirty(node.path);

      if (renamingPath === node.path) {
        return (
          <form
            key={`rename:${node.path}`}
            onSubmit={(e) => {
              e.preventDefault();
              void commitRename();
            }}
            style={{ paddingLeft: `${paddingLeft + 16}px` }}
            className="pr-2 py-0.5"
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  renameSubmittingRef.current = true;
                  setRenamingPath(null);
                  window.setTimeout(() => {
                    renameSubmittingRef.current = false;
                  }, 0);
                }
              }}
              onBlur={() => {
                if (!renameSubmittingRef.current) {
                  void commitRename();
                }
              }}
              aria-label={t.rename}
              className="w-full h-7 px-2 rounded-[6px] text-[12px] font-mono border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </form>
        );
      }

      return (
        <div
          key={`file:${node.path}`}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, path: node.path, type: 'file' });
          }}
          style={{ paddingLeft: `${paddingLeft + 16}px` }}
          className={`group w-full min-h-[36px] sm:min-h-0 sm:h-7 pr-1.5 flex items-center justify-between gap-1 text-[13px] select-none ${
            active
              ? 'bg-[var(--surface-2)] text-[var(--text)] font-medium'
              : 'text-[var(--text)] hover:bg-[var(--surface-2)]'
          }`}
        >
          <button
            type="button"
            onClick={() => openFile(node.path)}
            className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left cursor-pointer"
          >
            <FileIcon fileName={node.name} />
            <span className="truncate">{node.name}</span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            {dirty && (
              <span
                aria-label={t.unsavedIndicatorAria}
                className="w-2 h-2 rounded-full shrink-0 bg-[var(--warning)]"
              />
            )}
            <button
              type="button"
              aria-label={`Actions for ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const clampedX = Math.max(8, Math.min(rect.left - 120, window.innerWidth - 180));
                const clampedY = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 140));
                setContextMenu({ x: clampedX, y: clampedY, path: node.path, type: 'file' });
              }}
              className="h-7 w-7 sm:h-6 sm:w-6 rounded-[4px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
            >
              <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.6} />
            </button>
          </div>
        </div>
      );
    });
  }

  const deleteDisplayName = deleteTarget?.path.split('/').pop() || deleteTarget?.path || '';
  const deleteFolderFileCount =
    deleteTarget?.type === 'folder'
      ? files.filter((f) => f.path.startsWith(`${deleteTarget.path}/`) && f.path !== 'index.html').length
      : 0;

  const explorerSidebar = (
    <aside
      aria-label="Explorer"
      className={
        isMobile
          ? 'w-[240px] max-w-[82vw] h-full border-r border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0 select-none'
          : 'w-[220px] sm:w-[232px] border-r border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0 select-none'
      }
    >
      <div className="h-9 px-3 border-b border-[var(--border)] flex items-center justify-between gap-1 shrink-0">
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          {sidebarMode === 'search' ? t.searchTitle : t.explorerTitle}
        </span>
        <div className="flex items-center gap-0.5">
          {onOpenMobileTerminal && (
            <button
              type="button"
              onClick={onOpenMobileTerminal}
              aria-label={t.openTerminalMobileAria}
              title={t.terminal}
              className="sm:hidden h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              <TerminalIcon className="w-3.5 h-3.5" strokeWidth={1.6} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setSidebarMode((m) => (m === 'search' ? 'explorer' : 'search'))}
            aria-label={t.searchFilesAria}
            aria-pressed={sidebarMode === 'search'}
            title={t.searchFilesAria}
            className={`h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer ${
              sidebarMode === 'search'
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
            }`}
          >
            <Search className="w-3.5 h-3.5" strokeWidth={1.6} />
          </button>
          <button
            type="button"
            onClick={() => {
              setSidebarMode('explorer');
              setCreatingMode((m) => (m === 'file' ? 'none' : 'file'));
              setNewItemPath('');
            }}
            aria-label={t.newFileAria}
            title={t.newFileTitle}
            className="h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
          >
            <FilePlus className="w-3.5 h-3.5" strokeWidth={1.6} />
          </button>
          <button
            type="button"
            onClick={() => {
              setSidebarMode('explorer');
              setCreatingMode((m) => (m === 'folder' ? 'none' : 'folder'));
              setNewItemPath('');
            }}
            aria-label={t.newFolderAria}
            title={t.newFolderTitle}
            className="h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
          >
            <FolderPlus className="w-3.5 h-3.5" strokeWidth={1.6} />
          </button>
          {isMobile && (
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(false)}
              aria-label={t.closeExplorerAria}
              className="h-7 w-7 rounded-[6px] flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>

      {sidebarMode === 'search' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2 border-b border-[var(--border)]">
            <input
              autoFocus
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchFilesPlaceholder}
              aria-label={t.searchFilesAria}
              className="w-full h-7 px-2 rounded-[6px] text-[12px] font-mono border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {searchQuery.trim() === '' ? (
              <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t.searchFilesEmptyHint}</div>
            ) : searchMatches.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t.searchFilesNoMatch}</div>
            ) : (
              searchMatches.map((m, idx) => (
                <button
                  key={`${m.path}:${m.line}:${idx}`}
                  type="button"
                  onClick={() => openFile(m.path, m.line)}
                  className="w-full px-2.5 py-1.5 text-left cursor-pointer border-b border-[var(--border)] hover:bg-[var(--surface-2)]"
                >
                  <div className="flex items-center justify-between gap-1 text-[12px] font-mono text-[var(--text)]">
                    <span className="truncate font-medium">{m.path}</span>
                    <span className="shrink-0 text-[var(--text-muted)] tabular-nums">:{m.line}</span>
                  </div>
                  <div className="text-[12px] font-mono truncate text-[var(--text-muted)]">{m.snippet}</div>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          {creatingMode !== 'none' && (
            <form onSubmit={handleCreateSubmit} className="p-2 border-b border-[var(--border)]">
              <input
                autoFocus
                value={newItemPath}
                onChange={(e) => setNewItemPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setCreatingMode('none');
                }}
                placeholder={creatingMode === 'folder' ? 'src/components' : 'src/app.js'}
                aria-label={creatingMode === 'folder' ? t.newFolderAria : t.newFileAria}
                className="w-full h-7 px-2 rounded-[6px] text-[12px] font-mono border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </form>
          )}

          <div role="tree" aria-label={t.fileTreeAria} className="flex-1 overflow-y-auto py-1">
            {renderNodes(treeNodes, 0)}
          </div>
        </>
      )}
    </aside>
  );

  return (
    <div
      data-testid="vscode-code-pane"
      data-theme={theme}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void handleSave();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
          if (effectiveActivePath) {
            e.preventDefault();
            closeTab(effectiveActivePath);
          }
        }
      }}
      className="h-full flex flex-col min-w-0 bg-[var(--bg)] text-[var(--text)] relative"
    >
      {actionError && (
        <div
          role="alert"
          className="px-3 py-2 border-b border-[var(--error)] bg-[var(--surface-2)] text-[12px] text-[var(--error-text)] flex items-center justify-between gap-2 shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={1.6} />
            <span className="truncate">{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label={t.close}
            className="h-7 w-7 rounded-[6px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.6} />
          </button>
        </div>
      )}

      {/* Main Split: Explorer + Editor */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        {!isMobile && explorerSidebar}

        {isMobile && mobileDrawerOpen && (
          <div className="absolute inset-0 z-30 flex">
            {explorerSidebar}
            <div
              className="flex-1 bg-black/45"
              onClick={() => setMobileDrawerOpen(false)}
              aria-hidden="true"
            />
          </div>
        )}

        {/* Right Area: Tabs + Monaco Editor */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="h-9 border-b border-[var(--border)] bg-[var(--surface)] flex items-stretch justify-between shrink-0 overflow-hidden">
            <div className="flex items-stretch min-w-0 flex-1 overflow-hidden">
              {isMobile && (
                <button
                  type="button"
                  onClick={() => setMobileDrawerOpen((o) => !o)}
                  aria-label={t.openExplorerAria}
                  aria-expanded={mobileDrawerOpen}
                  className="px-2.5 border-r border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <PanelLeft className="w-4 h-4" strokeWidth={1.6} />
                </button>
              )}

              <div role="tablist" aria-label={t.openFileTabsAria} className="flex items-stretch overflow-x-auto min-w-0">
                {effectiveOpenTabs.map((tabPath) => {
                  const isActive = tabPath === effectiveActivePath;
                  const dirty = isDirty(tabPath);
                  const fileName = tabPath.split('/').pop() || tabPath;
                  return (
                    <div
                      key={tabPath}
                      role="tab"
                      aria-selected={isActive}
                      title={tabPath}
                      onClick={() => setActivePath(tabPath)}
                      className={`group flex items-center gap-1.5 pl-3 pr-2 border-r border-[var(--border)] text-[13px] select-none cursor-pointer shrink-0 max-w-[200px] ${
                        isActive
                          ? 'bg-[var(--bg)] text-[var(--text)] border-t-2 border-t-[var(--accent)] font-medium'
                          : 'bg-[var(--surface-2)] text-[var(--text-muted)] border-t-2 border-t-transparent hover:text-[var(--text)]'
                      }`}
                    >
                      <FileIcon fileName={fileName} />
                      <span className="truncate">{fileName}</span>
                      {dirty ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tabPath);
                          }}
                          aria-label={t.closeTabAria.replace('{name}', fileName)}
                          title={t.unsavedIndicatorAria}
                          className="w-5 h-5 rounded-[6px] flex items-center justify-center shrink-0 cursor-pointer hover:bg-[var(--surface-2)]"
                        >
                          <span className="group-hover:hidden w-2 h-2 rounded-full bg-[var(--warning)]" />
                          <X className="hidden group-hover:block w-3.5 h-3.5" strokeWidth={1.75} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tabPath);
                          }}
                          aria-label={t.closeTabAria.replace('{name}', fileName)}
                          className={`w-5 h-5 rounded-[6px] flex items-center justify-center shrink-0 cursor-pointer hover:bg-[var(--surface-2)] ${
                            isActive ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover:opacity-80 hover:opacity-100'
                          }`}
                        >
                          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-1 px-2 shrink-0">
              {isMobile && onOpenMobileTerminal && (
                <button
                  type="button"
                  onClick={onOpenMobileTerminal}
                  aria-label={t.openTerminalMobileAria}
                  title={t.terminal}
                  className="h-7 w-7 rounded-[6px] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center justify-center cursor-pointer"
                >
                  <TerminalIcon className="w-3.5 h-3.5" strokeWidth={1.6} />
                </button>
              )}
              <button
                type="button"
                disabled={!currentDirty || saving}
                onClick={() => void handleSave()}
                title="Ctrl+S"
                className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-40 ${
                  currentDirty
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                }`}
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.6} />
                ) : (
                  <Save className="w-3.5 h-3.5" strokeWidth={1.6} />
                )}
                <span>{saving ? t.saving : t.save}</span>
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 relative bg-[var(--bg)]">
            {currentFile ? (
              <Editor
                path={currentFile.path}
                language={langInfo.id}
                value={activeContent}
                theme={isDark ? 'carmen-vs-dark' : 'carmen-vs-light'}
                beforeMount={handleBeforeMount}
                onMount={handleEditorMount}
                onChange={(val) => {
                  const nextVal = val ?? '';
                  setDrafts((prev) => ({ ...prev, [currentFile.path]: nextVal }));
                }}
                options={{
                  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 13,
                  lineNumbers: 'on',
                  minimap: { enabled: false },
                  automaticLayout: true,
                  tabSize: 2,
                  scrollBeyondLastLine: false,
                  renderLineHighlight: 'line',
                  wordWrap: 'off',
                  smoothScrolling: !reducedMotion,
                  cursorBlinking: reducedMotion ? 'solid' : 'blink',
                  cursorSmoothCaretAnimation: reducedMotion ? 'off' : 'on',
                  padding: { top: 8, bottom: 8 },
                }}
                loading={
                  <div className="h-full w-full flex items-center justify-center text-[13px] font-mono text-[var(--text-muted)]">
                    {t.editorLoading}
                  </div>
                }
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-[13px] text-[var(--text-muted)] px-4 text-center">
                {t.selectFilePrompt}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Editor Status Bar */}
      <footer
        aria-label={t.statusBarAria}
        className="h-7 bg-[var(--surface)] border-t border-[var(--border)] text-[var(--text-muted)] px-3 flex items-center justify-between gap-3 text-[12px] leading-none shrink-0 select-none"
      >
        <div className="flex items-center gap-3 min-w-0 truncate">
          <span className="truncate font-mono text-[12px] text-[var(--text)]">
            {copiedNotice || currentFile?.path || 'CARMEN'}
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-[12px] font-mono tabular-nums">
          <span>
            {locale === 'id'
              ? `Baris ${cursor.line}, Kolom ${cursor.column}`
              : `Ln ${cursor.line}, Col ${cursor.column}`}
          </span>
          <span className="hidden sm:inline">UTF-8</span>
          <span>{langInfo.label}</span>
        </div>
      </footer>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          role="menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px`, boxShadow: 'var(--shadow-float)' }}
          className="fixed z-50 min-w-[168px] rounded-[6px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] py-1 text-[13px]"
        >
          {contextMenu.type === 'file' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setRenamingPath(contextMenu.path);
                setRenameValue(contextMenu.path);
                setContextMenu(null);
              }}
              className="w-full px-3 h-7 flex items-center gap-2 text-left cursor-pointer hover:bg-[var(--surface-2)]"
            >
              <Pencil className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span>{t.rename}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void handleCopyPath(contextMenu.path);
              setContextMenu(null);
            }}
            className="w-full px-3 h-7 flex items-center gap-2 text-left cursor-pointer hover:bg-[var(--surface-2)]"
          >
            <Copy className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.6} />
            <span>{t.copyPathAction}</span>
          </button>
          {!(contextMenu.type === 'file' && contextMenu.path === 'index.html') && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setDeleteError(null);
                setDeleteTarget({ path: contextMenu.path, type: contextMenu.type });
                setContextMenu(null);
              }}
              className="w-full px-3 h-7 flex items-center gap-2 text-left cursor-pointer text-[var(--error-text)] hover:bg-[var(--surface-2)]"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.6} />
              <span>{t.delete}</span>
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        locale={locale}
        title={
          deleteTarget?.type === 'folder'
            ? t.deleteFolderTitle.replace('{name}', deleteDisplayName)
            : t.deleteFileTitle.replace('{name}', deleteDisplayName)
        }
        description={
          deleteTarget?.type === 'folder'
            ? t.deleteFolderBody
                .replace('{path}', deleteTarget.path)
                .replace('{count}', String(deleteFolderFileCount))
            : t.deleteFileBody.replace('{path}', deleteTarget?.path || '')
        }
        confirmLabel={t.deleteConfirmButton}
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDeleteTarget()}
        onClose={() => {
          if (!deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      />
    </div>
  );
}
