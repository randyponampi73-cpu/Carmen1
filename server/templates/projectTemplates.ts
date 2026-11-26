import type { ApkConfig, ProjectType } from '../../src/types';

export interface ProjectTemplate {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  type: ProjectType;
  stack: string;
  defaultRules: string;
  apkConfig: ApkConfig;
  files: Record<string, string>;
}

const TODO_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO todos (title, priority, completed)
SELECT 'Siapkan skema SQLite dan endpoint API', 'high', 1
WHERE NOT EXISTS (SELECT 1 FROM todos);
INSERT INTO todos (title, priority, completed)
SELECT 'Uji tambah, centang, dan hapus tugas', 'normal', 0
WHERE (SELECT COUNT(*) FROM todos) < 2;
INSERT INTO todos (title, priority, completed)
SELECT 'Ekspor proyek ke ZIP untuk deployment', 'low', 0
WHERE (SELECT COUNT(*) FROM todos) < 3;`;

const TODO_PREVIEW_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Daftar Tugas — SQLite Fullstack</title>
  <style>
    :root { --bg: #0E0F11; --surface: #151618; --surface2: #1B1D20; --border: #26282C; --text: #E8E9EA; --muted: #8B8F96; --accent: #C8324B; --ok: #3FA66B; --warn: #D9A441; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
    .wrap { max-width: 680px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 600; }
    .meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    form { display: flex; gap: 8px; margin-bottom: 16px; }
    input[type="text"], select { background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px 12px; font-size: 14px; }
    input[type="text"] { flex: 1; }
    button { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; }
    button.ghost { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 4px 10px; font-size: 12px; }
    button.ghost.active { border-color: var(--accent); color: var(--text); }
    .filters { display: flex; gap: 8px; margin-bottom: 12px; }
    ul { list-style: none; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
    li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
    li:last-child { border-bottom: none; }
    .left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .title { font-size: 14px; }
    .done .title { text-decoration: line-through; color: var(--muted); }
    .prio { font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; color: var(--muted); }
    .prio.high { border-color: var(--accent); color: var(--accent); }
    .prio.normal { border-color: var(--warn); color: var(--warn); }
    .empty { padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Daftar Tugas</h1>
      <span class="meta" id="stats">Memuat dari SQLite...</span>
    </header>
    <form id="todo-form">
      <input id="todo-input" type="text" placeholder="Tulis tugas baru..." required />
      <select id="todo-prio" aria-label="Prioritas">
        <option value="high">Tinggi</option>
        <option value="normal" selected>Normal</option>
        <option value="low">Rendah</option>
      </select>
      <button type="submit">Tambah</button>
    </form>
    <div class="filters">
      <button type="button" class="ghost active" data-filter="all">Semua</button>
      <button type="button" class="ghost" data-filter="active">Aktif</button>
      <button type="button" class="ghost" data-filter="done">Selesai</button>
    </div>
    <ul id="todo-list"></ul>
  </div>
  <script>
    const API = './api/todos';
    let todos = [];
    let filter = 'all';

    async function load() {
      const res = await fetch(API);
      const data = await res.json();
      todos = data.rows || [];
      render();
    }

    function render() {
      const list = document.getElementById('todo-list');
      const stats = document.getElementById('stats');
      const doneCount = todos.filter(t => Number(t.completed) === 1).length;
      stats.textContent = doneCount + ' / ' + todos.length + ' selesai · SQLite';
      const visible = todos.filter(t => filter === 'all' ? true : filter === 'done' ? Number(t.completed) === 1 : Number(t.completed) === 0);
      if (!visible.length) {
        list.innerHTML = '<li class="empty">Belum ada tugas pada filter ini.</li>';
        return;
      }
      list.innerHTML = visible.map(t => \`
        <li class="\${Number(t.completed) === 1 ? 'done' : ''}">
          <label class="left">
            <input type="checkbox" \${Number(t.completed) === 1 ? 'checked' : ''} onchange="toggleTodo(\${t.id}, this.checked)" />
            <span class="title">\${escapeHtml(t.title)}</span>
          </label>
          <span class="prio \${escapeHtml(t.priority)}">\${escapeHtml(t.priority)}</span>
          <button type="button" class="ghost" onclick="deleteTodo(\${t.id})">Hapus</button>
        </li>\`).join('');
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    window.toggleTodo = async (id, checked) => {
      await fetch(API + '/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ completed: checked ? 1 : 0 }) });
      await load();
    };

    window.deleteTodo = async (id) => {
      await fetch(API + '/' + id, { method: 'DELETE' });
      await load();
    };

    document.getElementById('todo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('todo-input');
      const prio = document.getElementById('todo-prio');
      if (!input.value.trim()) return;
      await fetch(API, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title: input.value.trim(), priority: prio.value, completed: 0 }) });
      input.value = '';
      await load();
    });

    document.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        filter = btn.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });

    load();
  </script>
</body>
</html>`;

const TODO_REACT_APP = `import { useEffect, useState } from 'react';

interface Todo {
  id: number;
  title: string;
  priority: 'high' | 'normal' | 'low';
  completed: number;
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');

  async function refresh() {
    const res = await fetch('/api/todos');
    const data = await res.json();
    setTodos(data.rows ?? []);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), priority, completed: 0 }),
    });
    setTitle('');
    await refresh();
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Daftar Tugas</h1>
      <form onSubmit={addTodo} className="mt-4 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Tulis tugas baru..."
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as 'high' | 'normal' | 'low')}
          className="rounded border px-3 py-2 text-sm"
        >
          <option value="high">Tinggi</option>
          <option value="normal">Normal</option>
          <option value="low">Rendah</option>
        </select>
        <button type="submit" className="rounded bg-[#C8324B] px-4 py-2 text-sm text-white">
          Tambah
        </button>
      </form>
      <ul className="mt-4 divide-y rounded border">
        {todos.map((item) => (
          <li key={item.id} className="flex items-center justify-between px-3 py-2.5 text-sm">
            <span className={item.completed ? 'line-through opacity-60' : ''}>{item.title}</span>
            <span className="text-xs opacity-70">{item.priority}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;

const TODO_SERVER_ROUTES = `import express from 'express';
import { DatabaseSync } from 'node:sqlite';

const router = express.Router();
const db = new DatabaseSync('./data.db');

db.exec(\`CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)\`);

router.get('/api/todos', (_req, res) => {
  const rows = db.prepare('SELECT * FROM todos ORDER BY id DESC').all();
  res.json({ rows });
});

router.post('/api/todos', (req, res) => {
  const { title, priority = 'normal' } = req.body;
  const info = db.prepare('INSERT INTO todos (title, priority) VALUES (?, ?)').run(title, priority);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/api/todos/:id', (req, res) => {
  const { completed } = req.body;
  db.prepare('UPDATE todos SET completed = ? WHERE id = ?').run(completed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/api/todos/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
`;

const HABIT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_per_week INTEGER NOT NULL DEFAULT 7,
  streak INTEGER NOT NULL DEFAULT 0,
  done_today INTEGER NOT NULL DEFAULT 0
);
INSERT INTO habits (name, target_per_week, streak, done_today)
SELECT 'Minum 2 liter air', 7, 5, 1
WHERE NOT EXISTS (SELECT 1 FROM habits);
INSERT INTO habits (name, target_per_week, streak, done_today)
SELECT 'Membaca dokumentasi 20 menit', 5, 3, 0
WHERE (SELECT COUNT(*) FROM habits) < 2;
INSERT INTO habits (name, target_per_week, streak, done_today)
SELECT 'Jalan kaki 30 menit', 5, 4, 1
WHERE (SELECT COUNT(*) FROM habits) < 3;`;

const HABIT_PREVIEW_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kebiasaan Harian — Android</title>
  <style>
    :root { --bg: #0E0F11; --surface: #151618; --surface2: #1B1D20; --border: #26282C; --text: #E8E9EA; --muted: #8B8F96; --accent: #C8324B; --ok: #3FA66B; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 16px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .sub { font-size: 12px; color: var(--muted); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
    form { display: flex; gap: 6px; margin-bottom: 14px; }
    input { flex: 1; background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    button { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 12px; font-size: 12px; font-weight: 500; cursor: pointer; }
    .list { display: flex; flex-direction: column; gap: 8px; }
    .card { display: flex; align-items: center; justify-content: space-between; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
    .card.done { border-color: var(--ok); }
    .name { font-size: 14px; font-weight: 500; }
    .streak { font-size: 12px; color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
    .check { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
    .card.done .check { background: var(--ok); border-color: var(--ok); color: #fff; }
  </style>
</head>
<body>
  <h1>Kebiasaan Harian</h1>
  <div class="sub" id="summary">Memuat...</div>
  <form id="habit-form">
    <input id="habit-name" type="text" placeholder="Tambah kebiasaan baru..." required />
    <button type="submit">Tambah</button>
  </form>
  <div class="list" id="habit-list"></div>
  <script>
    const API = './api/habits';
    let habits = [];
    async function load() {
      const res = await fetch(API);
      const data = await res.json();
      habits = data.rows || [];
      render();
    }
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function render() {
      const done = habits.filter(h => Number(h.done_today) === 1).length;
      document.getElementById('summary').textContent = done + ' dari ' + habits.length + ' selesai hari ini · Capacitor + SQLite';
      document.getElementById('habit-list').innerHTML = habits.map(h => \`
        <div class="card \${Number(h.done_today) === 1 ? 'done' : ''}">
          <div>
            <div class="name">\${escapeHtml(h.name)}</div>
            <div class="streak">Rangkaian: \${Number(h.streak) || 0} hari · Target \${Number(h.target_per_week) || 0}x/minggu</div>
          </div>
          <button type="button" class="check" onclick="toggleHabit(\${Number(h.id) || 0}, \${Number(h.done_today) === 1 ? 0 : 1}, \${Number(h.streak) || 0})">
            \${Number(h.done_today) === 1 ? 'Selesai' : 'Tandai'}
          </button>
        </div>\`).join('');
    }
    window.toggleHabit = async (id, nextDone, curStreak) => {
      const streak = nextDone ? Number(curStreak) + 1 : Math.max(0, Number(curStreak) - 1);
      await fetch(API + '/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ done_today: nextDone, streak }) });
      await load();
    };
    document.getElementById('habit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('habit-name');
      if (!input.value.trim()) return;
      await fetch(API, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: input.value.trim(), target_per_week: 7, streak: 0, done_today: 0 }) });
      input.value = '';
      await load();
    });
    load();
  </script>
</body>
</html>`;

const POS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
INSERT INTO products (sku, name, price, stock)
SELECT 'KOP-01', 'Kopi Arabika Gayo 250g', 68000, 24
WHERE NOT EXISTS (SELECT 1 FROM products);
INSERT INTO products (sku, name, price, stock)
SELECT 'KOP-02', 'Kopi Robusta Lampung 250g', 45000, 38
WHERE (SELECT COUNT(*) FROM products) < 2;
INSERT INTO products (sku, name, price, stock)
SELECT 'TEH-01', 'Teh Hijau Ciwidey 100g', 32000, 19
WHERE (SELECT COUNT(*) FROM products) < 3;`;

const POS_PREVIEW_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Inventaris & Kasir UMKM</title>
  <style>
    :root { --bg:#0E0F11; --surface:#151618; --border:#26282C; --text:#E8E9EA; --muted:#8B8F96; --accent:#C8324B; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
    th { color: var(--muted); font-weight: 500; font-size: 12px; }
    .num { text-align: right; }
    button { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  </style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <h1>Inventaris Produk UMKM</h1>
    <button onclick="exportCsv()">Ekspor CSV</button>
  </div>
  <table>
    <thead><tr><th>SKU</th><th>Produk</th><th class="num">Harga (Rp)</th><th class="num">Stok</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    let items = [];
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    async function load() {
      const res = await fetch('./api/products');
      const data = await res.json();
      items = data.rows || [];
      document.getElementById('rows').innerHTML = items.map(p => \`
        <tr><td>\${escapeHtml(p.sku)}</td><td>\${escapeHtml(p.name)}</td><td class="num">\${(Number(p.price) || 0).toLocaleString('id-ID')}</td><td class="num">\${Number(p.stock) || 0}</td></tr>
      \`).join('');
    }
    window.exportCsv = () => {
      const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const csv = ['sku,name,price,stock', ...items.map(i => \`\${q(i.sku)},\${q(i.name)},\${Number(i.price) || 0},\${Number(i.stock) || 0}\`)].join('\\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'inventaris.csv';
      a.click();
    };
    load();
  </script>
</body>
</html>`;

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'web-todo-sqlite',
    name: 'Aplikasi Todo Fullstack',
    nameEn: 'Fullstack Todo App',
    description: 'React + Vite + Express API + SQLite dengan filter prioritas dan penyimpanan permanen.',
    descriptionEn: 'React + Vite + Express API + SQLite with priority filters and persistent storage.',
    type: 'web',
    stack: 'React + Vite + Tailwind + Node API + SQLite',
    defaultRules: 'Gunakan Bahasa Indonesia pada teks UI, simpan data ke tabel SQLite todos, dan pastikan kode tidak memuat API key.',
    apkConfig: {
      appName: 'Daftar Tugas',
      packageId: 'id.carmen.todo',
      versionName: '1.0.0',
      versionCode: 1,
      iconColor: '#C8324B',
      buildType: 'debug',
    },
    files: {
      'index.html': TODO_PREVIEW_HTML,
      'src/App.tsx': TODO_REACT_APP,
      'server/routes.ts': TODO_SERVER_ROUTES,
      'schema.sql': TODO_SCHEMA_SQL,
      'package.json': JSON.stringify(
        {
          name: 'carmen-todo-fullstack',
          version: '1.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', start: 'node server/routes.ts' },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', express: '^4.21.0' },
          devDependencies: { vite: '^8.3.0' },
        },
        null,
        2
      ),
      'README.md': '# Aplikasi Todo Fullstack\n\nDibuat di CARMEN dengan React, Node API, dan SQLite.\n',
    },
  },
  {
    id: 'android-habit-capacitor',
    name: 'Pencatat Kebiasaan (Android)',
    nameEn: 'Daily Habit Tracker (Android)',
    description: 'Aplikasi Android berbasis React + Capacitor dengan pelacak rangkaian harian dan SQLite.',
    descriptionEn: 'Android app built with React + Capacitor with daily streak tracker and SQLite.',
    type: 'android',
    stack: 'React + Vite + Capacitor (Android) + SQLite',
    defaultRules: 'Desain tata letak mobile-first selebar 390px untuk Capacitor Android dengan target sentuh minimal 44px.',
    apkConfig: {
      appName: 'Kebiasaan Harian',
      packageId: 'id.carmen.habittracker',
      versionName: '1.0.0',
      versionCode: 1,
      iconColor: '#C8324B',
      buildType: 'debug',
    },
    files: {
      'index.html': HABIT_PREVIEW_HTML,
      'capacitor.config.json': JSON.stringify(
        {
          appId: 'id.carmen.habittracker',
          appName: 'Kebiasaan Harian',
          webDir: 'dist',
          android: { allowMixedContent: false },
        },
        null,
        2
      ),
      'android/app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="id.carmen.habittracker">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="Kebiasaan Harian" android:allowBackup="true">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`,
      'schema.sql': HABIT_SCHEMA_SQL,
      'package.json': JSON.stringify(
        {
          name: 'carmen-habit-android',
          version: '1.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', 'cap:sync': 'npx cap sync android' },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', '@capacitor/core': '^6.0.0' },
          devDependencies: { vite: '^8.3.0' },
        },
        null,
        2
      ),
    },
  },
  {
    id: 'web-umkm-inventory',
    name: 'Inventaris & Kasir UMKM',
    nameEn: 'SME Inventory & POS',
    description: 'Tabel stok produk tabular, ekspor CSV, dan penyimpanan SQLite lokal.',
    descriptionEn: 'Tabular inventory ledger, CSV export, and SQLite persistence.',
    type: 'web',
    stack: 'React + Vite + Tailwind + Node API + SQLite',
    defaultRules: 'Gunakan angka tabular dan format Rupiah Indonesia pada tabel harga.',
    apkConfig: {
      appName: 'Kasir UMKM',
      packageId: 'id.carmen.umkm',
      versionName: '1.0.0',
      versionCode: 1,
      iconColor: '#C8324B',
      buildType: 'debug',
    },
    files: {
      'index.html': POS_PREVIEW_HTML,
      'schema.sql': POS_SCHEMA_SQL,
      'package.json': JSON.stringify(
        {
          name: 'carmen-umkm-inventory',
          version: '1.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build' },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', express: '^4.21.0' },
          devDependencies: { vite: '^8.3.0' },
        },
        null,
        2
      ),
    },
  },
];

export function buildBlankProjectFiles(name: string, type: ProjectType, _prompt?: string): Record<string, string> {
  const safeName = name.replace(/[<>"]/g, '');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'app';
  const html = `<!doctype html>
<!-- carmen:blank-starter -->
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName}</title>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;

  const files: Record<string, string> = {
    'index.html': html,
    'schema.sql': `CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`,
    'package.json': JSON.stringify(
      {
        name: `carmen-${slug}`,
        version: '1.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build' },
        dependencies:
          type === 'android'
            ? { react: '^19.0.0', 'react-dom': '^19.0.0', '@capacitor/core': '^6.0.0' }
            : { react: '^19.0.0', 'react-dom': '^19.0.0', express: '^4.21.0' },
        devDependencies: { vite: '^8.3.0' },
      },
      null,
      2
    ),
  };

  if (type === 'android') {
    files['capacitor.config.json'] = JSON.stringify(
      { appId: `id.carmen.${slug}`, appName: safeName, webDir: 'dist' },
      null,
      2
    );
  }

  return files;
}
