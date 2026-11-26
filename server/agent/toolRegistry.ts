import type { AdapterToolDefinition } from '../providers';

export type SkillToolPermission =
  | 'READ'
  | 'WRITE'
  | 'EXECUTE'
  | 'NETWORK'
  | 'DATABASE'
  | 'DEPLOY';

export interface RegisteredToolSpec {
  name: string;
  category: 'filesystem' | 'analysis' | 'execution' | 'verification' | 'memory' | 'recovery';
  requiredPermission: SkillToolPermission;
  mutating: boolean;
  definition: AdapterToolDefinition;
}

export const CANONICAL_AGENT_TOOLS: AdapterToolDefinition[] = [
  {
    name: 'write_file',
    description: 'Membuat file baru atau menimpa seluruh isi file di dalam proyek.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif terhadap root proyek, mis. index.html atau schema.sql' },
        content: { type: 'string', description: 'Isi lengkap file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Mengubah bagian tertentu dari file dengan search-and-replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif.' },
        search: { type: 'string', description: 'Teks persis yang akan diganti.' },
        replace: { type: 'string', description: 'Teks pengganti.' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'read_file',
    description:
      'Membaca isi file proyek. Untuk file besar (>16.000 karakter), gunakan start_line dan end_line (1-based inklusif) agar tidak terpotong.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif.' },
        start_line: { type: 'number', description: 'Baris awal yang dibaca (opsional, mulai dari 1).' },
        end_line: { type: 'number', description: 'Baris akhir yang dibaca (opsional, inklusif).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'update_project_memory',
    description:
      'Menyimpan catatan proyek permanen (arsitektur, keputusan penting, daftar tugas beserta status, langkah berikutnya) yang otomatis dibaca di awal setiap giliran berikutnya. Mengganti seluruh catatan sebelumnya; maksimal 4000 karakter. Jangan simpan rahasia.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Seluruh isi catatan baru (Markdown ringkas).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Menghapus file dari proyek.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path file relatif.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'Melihat daftar file pada proyek.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Direktori opsional (kosongkan untuk root).' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: 'Mencari teks atau simbol di seluruh file proyek.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Kata kunci teks yang ingin dicari (case-insensitive).' },
        dir: { type: 'string', description: 'Prefix direktori opsional untuk mempersempit pencarian.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_directory',
    description: 'Membuat direktori baru di dalam workspace proyek.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path direktori relatif, mis. src/components.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Menjalankan perintah sandbox yang diizinkan (ls, db:sync, node, npm, npx) di direktori proyek.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Perintah aman di dalam proyek.' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'install_dependencies',
    description: 'Menjalankan npm install (atau menambahkan paket tertentu) di workspace proyek.',
    parameters: {
      type: 'object',
      properties: {
        packages: { type: 'string', description: 'Daftar nama paket opsional dipisahkan spasi, kosongkan untuk npm install.' },
      },
      required: [],
    },
  },
  {
    name: 'run_tests',
    description: 'Menjalankan pengujian proyek (npm test) di sandbox.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'build_project',
    description: 'Menjalankan build proyek (npm run build) untuk memverifikasi tidak ada error kompilasi.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'validate_project',
    description: 'Memvalidasi integritas proyek (index.html, package.json, schema.sql, deteksi kebocoran secret, dan error preview/runtime terakhir).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'inspect_dependencies',
    description: 'Memeriksa package.json proyek (daftar dependensi, skrip, dan audit keamanan skrip lifecycle).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'workspace_diff',
    description: 'Melihat ringkasan perubahan file (ditambah, diubah, dihapus) dibandingkan snapshot versi terakhir.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'rollback_checkpoint',
    description: 'Mengembalikan file workspace ke checkpoint sebelum giliran perubahan saat ini bila perbaikan gagal.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_logs',
    description: 'Membaca log terminal dan preview terbaru dari proyek.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

const TOOL_METADATA: Record<
  string,
  { category: RegisteredToolSpec['category']; requiredPermission: SkillToolPermission; mutating: boolean }
> = {
  read_file: { category: 'filesystem', requiredPermission: 'READ', mutating: false },
  list_files: { category: 'filesystem', requiredPermission: 'READ', mutating: false },
  search_files: { category: 'analysis', requiredPermission: 'READ', mutating: false },
  write_file: { category: 'filesystem', requiredPermission: 'WRITE', mutating: true },
  edit_file: { category: 'filesystem', requiredPermission: 'WRITE', mutating: true },
  delete_file: { category: 'filesystem', requiredPermission: 'WRITE', mutating: true },
  create_directory: { category: 'filesystem', requiredPermission: 'WRITE', mutating: true },
  update_project_memory: { category: 'memory', requiredPermission: 'WRITE', mutating: false },
  run_command: { category: 'execution', requiredPermission: 'EXECUTE', mutating: true },
  install_dependencies: { category: 'execution', requiredPermission: 'EXECUTE', mutating: true },
  run_tests: { category: 'verification', requiredPermission: 'EXECUTE', mutating: false },
  build_project: { category: 'verification', requiredPermission: 'EXECUTE', mutating: false },
  validate_project: { category: 'verification', requiredPermission: 'READ', mutating: false },
  inspect_dependencies: { category: 'analysis', requiredPermission: 'READ', mutating: false },
  workspace_diff: { category: 'analysis', requiredPermission: 'READ', mutating: false },
  rollback_checkpoint: { category: 'recovery', requiredPermission: 'WRITE', mutating: true },
  read_logs: { category: 'analysis', requiredPermission: 'READ', mutating: false },
};

const REGISTERED_MAP = new Map<string, RegisteredToolSpec>(
  CANONICAL_AGENT_TOOLS.map((definition) => {
    const meta = TOOL_METADATA[definition.name] ?? {
      category: 'analysis' as const,
      requiredPermission: 'READ' as const,
      mutating: false,
    };
    return [
      definition.name,
      {
        name: definition.name,
        category: meta.category,
        requiredPermission: meta.requiredPermission,
        mutating: meta.mutating,
        definition,
      },
    ];
  })
);

export function listRegisteredTools(): RegisteredToolSpec[] {
  return Array.from(REGISTERED_MAP.values());
}

export function getRegisteredTool(name: string): RegisteredToolSpec | undefined {
  return REGISTERED_MAP.get(name.trim());
}

export function isKnownAgentTool(name: string): boolean {
  return REGISTERED_MAP.has(name.trim());
}

export function resolveToolNamesForSkill(requestedTools: string[]): {
  validTools: RegisteredToolSpec[];
  unknownTools: string[];
} {
  const validTools: RegisteredToolSpec[] = [];
  const unknownTools: string[] = [];
  const seen = new Set<string>();
  for (const raw of requestedTools) {
    const clean = raw.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const spec = REGISTERED_MAP.get(clean);
    if (spec) validTools.push(spec);
    else unknownTools.push(clean);
  }
  return { validTools, unknownTools };
}

export function getRequiredPermissionsForTools(toolNames: string[]): SkillToolPermission[] {
  const perms = new Set<SkillToolPermission>();
  for (const raw of toolNames) {
    const spec = REGISTERED_MAP.get(raw.trim());
    if (spec) perms.add(spec.requiredPermission);
  }
  return Array.from(perms);
}
