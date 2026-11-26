import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSystemPrompt, parseStructuredActions } from './parser';
import { buildGeminiContents } from '../providers/gemini';
import { deduplicateModels, isNonChatModel } from '../providers/catalog';

test('parseStructuredActions extracts write_file and run_command blocks cleanly', () => {
  const sample = `Saya akan memperbarui halaman utama.
<carmen_action tool="write_file" path="index.html">
<h1>Halo CARMEN</h1>
</carmen_action>
<carmen_action tool="run_command">npm run build</carmen_action>`;

  const parsed = parseStructuredActions(sample);
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].tool, 'write_file');
  assert.equal(parsed.actions[0].args.path, 'index.html');
  assert.equal(parsed.actions[0].args.content, '<h1>Halo CARMEN</h1>');
  assert.equal(parsed.actions[1].tool, 'run_command');
  assert.equal(parsed.actions[1].args.cmd, 'npm run build');
  assert.equal(parsed.cleanText, 'Saya akan memperbarui halaman utama.');
});

test('buildAgentSystemPrompt includes project rules, last error, and discuss mode guard', () => {
  const prompt = buildAgentSystemPrompt({
    projectName: 'Todo SQLite',
    projectType: 'web',
    stack: 'React + SQLite',
    filePaths: ['index.html', 'schema.sql'],
    rules: 'Selalu pakai Bahasa Indonesia.',
    lastError: 'SQLite syntax error near SELECT',
    mode: 'discuss',
    useStructuredFallback: false,
  });

  assert.match(prompt, /Todo SQLite/);
  assert.match(prompt, /Selalu pakai Bahasa Indonesia/);
  assert.match(prompt, /SQLite syntax error near SELECT/);
  assert.match(prompt, /MODE DISKUSI AKTIF/);
});

test('buildAgentSystemPrompt includes direct write_file instruction in build mode', () => {
  const prompt = buildAgentSystemPrompt({
    projectName: 'Kalkulator',
    projectType: 'web',
    stack: 'HTML/CSS/JS',
    filePaths: ['index.html'],
    rules: '',
    lastError: null,
    mode: 'build',
    useStructuredFallback: false,
  });

  assert.match(prompt, /langsung panggil write_file untuk index\.html yang LENGKAP dan mandiri/);
  assert.match(prompt, /multi-file/);
});

test('buildGeminiContents preserves thoughtSignature on functionCall parts and groups tool responses', () => {
  const contents = buildGeminiContents([
    { role: 'user', content: 'buatkan kalkulator sederhana' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'tc_1',
          name: 'write_file',
          arguments: { path: 'index.html', content: '<h1>Kalkulator</h1>' },
          thoughtSignature: 'sig_abc_123',
        },
        {
          id: 'tc_2',
          name: 'list_files',
          arguments: {},
        },
      ],
    },
    { role: 'tool', toolName: 'write_file', toolCallId: 'tc_1', content: '{"ok":true}' },
    { role: 'tool', toolName: 'list_files', toolCallId: 'tc_2', content: '{"files":["index.html"]}' },
  ]) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;

  assert.equal(contents.length, 3);
  assert.equal(contents[1].role, 'model');
  const firstPart = contents[1].parts[0];
  assert.equal(firstPart.thoughtSignature, 'sig_abc_123');
  assert.deepEqual(firstPart.functionCall, {
    id: 'tc_1',
    name: 'write_file',
    args: { path: 'index.html', content: '<h1>Kalkulator</h1>' },
  });
  // Second call had no thoughtSignature so key should not be fabricated
  const secondPart = contents[1].parts[1];
  assert.equal('thoughtSignature' in secondPart, false);
  // Consecutive tool responses merged into a single user turn
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts.length, 2);
});

test('isNonChatModel and deduplicateModels filter image/audio/embedding models and remove duplicates', () => {
  assert.equal(isNonChatModel('imagen-3.0-generate-002', 'Imagen 3'), true);
  assert.equal(isNonChatModel('gemini-2.5-flash-image-preview', 'Nano Banana'), true);
  assert.equal(isNonChatModel('gemini-2.5-flash-preview-tts', 'Gemini TTS'), true);
  assert.equal(isNonChatModel('text-embedding-004', 'Embedding'), true);
  assert.equal(isNonChatModel('veo-2.0-generate-001', 'Veo 2'), true);
  assert.equal(isNonChatModel('gemini-2.0-flash-live-001', 'Gemini Live'), true);
  assert.equal(isNonChatModel('models/aqa', 'AQA'), true);
  assert.equal(isNonChatModel('whisper-large-v3', 'Transcribe'), true);

  assert.equal(isNonChatModel('gemini-2.5-flash', 'Gemini 2.5 Flash'), false);
  assert.equal(isNonChatModel('llama-3.3-70b-versatile', 'Llama 3.3 70B'), false);

  const baseModel = {
    providerKeyId: 'k1',
    provider: 'gemini' as const,
    providerLabel: 'Gemini',
    toolCalling: 'yes' as const,
    vision: 'yes' as const,
    maxContext: 1000000 as const,
    maxOutput: 8192 as const,
    pricingNote: 'Gratis',
    status: 'active' as const,
    source: 'api' as const,
    lastVerified: '2026-01-01T00:00:00.000Z',
  };

  const deduped = deduplicateModels([
    {
      ...baseModel,
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      tier: 'free',
    },
    {
      ...baseModel,
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash Duplicate',
      tier: 'free',
    },
    {
      ...baseModel,
      id: 'imagen-3',
      name: 'Imagen 3',
      tier: 'paid',
      isNonChat: true,
    },
  ]);

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].name, 'Gemini 2.5 Flash');
});

test('parseStructuredActions supports edit_file search/replace tags and read/list/search/validate/memory actions', () => {
  const sample = `Saya memeriksa dan memperbaiki file.
<carmen_action tool="list_files" dir="src" />
<carmen_action tool="read_file" path="src/app.ts" start_line="10" end_line="40" />
<carmen_action tool="search_files" query="fetchUsers" dir="src" />
<carmen_action tool="edit_file" path="src/app.ts"><search>const x = 1;</search><replace>const x = 2;</replace></carmen_action>
<carmen_action tool="validate_project" />
<carmen_action tool="update_project_memory">Status: langkah 1 selesai.</carmen_action>
Selesai diperbarui.`;

  const parsed = parseStructuredActions(sample);
  assert.equal(parsed.actions.length, 6);
  assert.deepEqual(parsed.actions[0], { tool: 'list_files', args: { dir: 'src' } });
  assert.deepEqual(parsed.actions[1], {
    tool: 'read_file',
    args: { path: 'src/app.ts', start_line: '10', end_line: '40' },
  });
  assert.deepEqual(parsed.actions[2], { tool: 'search_files', args: { query: 'fetchUsers', dir: 'src' } });
  assert.deepEqual(parsed.actions[3], {
    tool: 'edit_file',
    args: { path: 'src/app.ts', search: 'const x = 1;', replace: 'const x = 2;' },
  });
  assert.deepEqual(parsed.actions[4], { tool: 'validate_project', args: {} });
  assert.deepEqual(parsed.actions[5], {
    tool: 'update_project_memory',
    args: { content: 'Status: langkah 1 selesai.' },
  });
  assert.equal(parsed.cleanText, 'Saya memeriksa dan memperbaiki file.\n\n\n\n\n\n\nSelesai diperbarui.');
});

test('buildAgentSystemPrompt caps large file lists at 300 and injects handoff above project memory', () => {
  const manyFiles = Array.from({ length: 325 }, (_, i) => `src/file_${i + 1}.ts`);
  const prompt = buildAgentSystemPrompt({
    projectName: 'Big Project',
    projectType: 'web',
    stack: 'React + Vite',
    filePaths: manyFiles,
    rules: '',
    lastError: null,
    mode: 'build',
    useStructuredFallback: true,
    projectHandoff: 'Status giliran terakhir: batas langkah tercapai\nTujuan: Bangun dashboard analytics',
    projectMemory: 'Keputusan: pakai Recharts',
  });

  assert.match(prompt, /\(\+25 file lainnya; gunakan list_files atau search_files\)/);
  assert.doesNotMatch(prompt, /src\/file_325\.ts/);
  const handoffIdx = prompt.indexOf('<serah_terima_proyek>');
  const memoryIdx = prompt.indexOf('<catatan_proyek>');
  assert.ok(handoffIdx > 0);
  assert.ok(memoryIdx > handoffIdx, 'Handoff must appear above permanent memory');
  assert.match(prompt, /update_project_memory/);
});

test('buildAgentSystemPrompt guides modular multi-file architecture for React/Vite projects (B3)', () => {
  const prompt = buildAgentSystemPrompt({
    projectName: 'SaaS App',
    projectType: 'web',
    stack: 'React + Vite + Tailwind',
    filePaths: ['package.json', 'index.html', 'src/App.tsx'],
    rules: '',
    lastError: null,
    mode: 'build',
    useStructuredFallback: false,
  });

  assert.match(prompt, /aplikasi modular/i);
  assert.doesNotMatch(prompt, /HTML \+ CSS \+ JS dalam satu file/);
});

test('parseStructuredActions and structured prompt include read_logs tool support', () => {
  const parsed = parseStructuredActions('Periksa log terbaru.\n<carmen_action tool="read_logs" />');
  assert.deepEqual(parsed.actions, [{ tool: 'read_logs', args: {} }]);
  assert.equal(parsed.cleanText, 'Periksa log terbaru.');

  const prompt = buildAgentSystemPrompt({
    projectName: 'Log Test',
    projectType: 'web',
    stack: 'React + Vite',
    filePaths: ['index.html'],
    rules: '',
    lastError: null,
    mode: 'build',
    useStructuredFallback: true,
  });
  assert.match(prompt, /tool="read_logs"/);
});

test('planner and parser support full-stack client/server/shared architecture and backend keywords', async () => {
  const { classifyAgentIntent, selectRelevantFiles } = await import('./planner');

  const intent = classifyAgentIntent({
    prompt: 'Tambahkan REST API Express dengan middleware JWT dan skema PostgreSQL Drizzle',
    mode: 'build',
    existingFiles: ['client/index.html', 'client/src/App.tsx', 'server/index.ts', 'shared/schema.ts'],
    hasRuntimeError: false,
    isBlankStarter: false,
  });
  assert.equal(intent.intent, 'fullstack_feature');
  assert.equal(intent.complexity, 'high');

  const relevant = selectRelevantFiles('Perbaiki endpoint auth di backend server', [
    'client/index.html',
    'client/src/App.tsx',
    'server/index.ts',
    'server/routes/auth.ts',
    'shared/types.ts',
    'package.json',
  ]);
  assert.ok(relevant.includes('server/index.ts'));
  assert.ok(relevant.includes('server/routes/auth.ts'));

  const prompt = buildAgentSystemPrompt({
    projectName: 'Fullstack Bolt Clone',
    projectType: 'web',
    stack: 'React + Express + PostgreSQL',
    filePaths: ['client/index.html', 'server/index.ts', 'shared/schema.ts'],
    rules: '',
    lastError: null,
    mode: 'build',
    useStructuredFallback: false,
  });
  assert.match(prompt, /aplikasi modular/i);
  assert.match(prompt, /client\/index\.html/);
  assert.match(prompt, /server\/\*/);
});
