import type { ProjectType } from '../../src/types';

export type AgentIntent =
  | 'new_app'
  | 'fullstack_feature'
  | 'bug_repair'
  | 'simple_edit'
  | 'architecture_discuss';

export type TaskComplexity = 'low' | 'medium' | 'high';

export interface StructuredPlanStep {
  id: string;
  phase: 'inspect' | 'design' | 'implement' | 'verify' | 'repair';
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface AgentExecutionPlan {
  intent: AgentIntent;
  complexity: TaskComplexity;
  objective: string;
  requiresHeavyPlanning: boolean;
  requirements: string[];
  relevantFiles: string[];
  steps: StructuredPlanStep[];
  verificationCriteria: string[];
  activeSkills?: string[];
}

const REPAIR_KEYWORDS =
  /\b(error|bug|fix|perbaiki|gagal|broken|crash|exception|undefined|syntaxerror|referenceerror|typeerror|tidak jalan|rusak|repair|debug)\b/i;

const NEW_APP_KEYWORDS =
  /\b(buatkan|buat|bangun|create|build|generate|rancang)\b.*\b(aplikasi|website|web|landing|toko|e-?commerce|dashboard|saas|blog|cms|portal|kalkulator|kasir|todo|inventory|portfolio|sistem|manajemen|app)\b/i;

const FULLSTACK_KEYWORDS =
  /\b(database|sqlite|postgres(?:ql)?|pg|schema|sql|api|backend|endpoint|auth|login|register|crud|admin|pembayaran|checkout|cart|keranjang|multi-?page|tabel|table|express|hono|fastify|drizzle|prisma|fullstack|full-?stack|rest\s*api|sse|streaming|upload|jwt|cookie|middleware|webhook)\b/i;

const PERSISTENT_DATA_APP_KEYWORDS =
  /\b(toko|e-?commerce|kasir|pos|inventory|inventaris|gudang|crm|cms|booking|reservasi|todo|to-?do|catatan|notes|tracker|manajemen|absensi|perpustakaan|klinik|tiket|pesanan|transaksi|keuangan|pelanggan|karyawan|siswa|blog|forum|dashboard|saas)\b/i;

const EXPLICIT_STATIC_KEYWORDS =
  /\b(landing(?:\s*page)?|portfolio|portofolio|company\s*profile|profil\s*(?:perusahaan|bisnis|diri)|brosur|brochure|kalkulator|calculator|konverter|converter|timer|stopwatch|countdown|undangan|invitation|statis|static)\b/i;

const SIMPLE_EDIT_KEYWORDS =
  /\b((?:ganti|ubah)\s+(?:warna|teks|judul|label|ukuran|font|tombol)|typo|change color|change title|rename|adjust padding|margin|font size|perbesar|perkecil)\b/i;

const CONTINUATION_PROMPT_RE =
  /^(?:tolong\s+|silakan\s+|coba\s+|please\s+)?(?:lanjut(?:kan)?|teruskan|terusin|sambung|continue|resume|keep\s+going|go\s+on|proceed)(?:\s+(?:pekerjaan|tugas|proyek|project|work|this|that|ini|itu|ya|dong|step|langkah|dari\s+titik\s+ini)){0,3}[\s.!?,]*$/i;

export function isContinuationPrompt(prompt: string): boolean {
  const normalized = prompt.trim().replace(/\s+/g, ' ');
  return CONTINUATION_PROMPT_RE.test(normalized);
}

export function parseProjectHandoffForPlan(handoff?: string): {
  objective: string;
  remainingSteps: string[];
  hadError: boolean;
} {
  if (!handoff || !handoff.trim()) {
    return { objective: '', remainingSteps: [], hadError: false };
  }
  let objective = '';
  const remainingSteps: string[] = [];
  let inRemaining = false;
  let hadError = false;

  for (const rawLine of handoff.split('\n')) {
    const line = rawLine.trim();
    if (/^Tujuan:\s*/i.test(line)) {
      objective = line.replace(/^Tujuan:\s*/i, '').trim();
      inRemaining = false;
      continue;
    }
    if (/^(Error terakhir:|Aksi gagal:)/i.test(line)) {
      hadError = true;
      inRemaining = false;
      continue;
    }
    if (/^Status giliran terakhir:.*\b(gagal|error|belum selesai|dihentikan)/i.test(line)) {
      hadError = hadError || /gagal|error/i.test(line);
      inRemaining = false;
      continue;
    }
    if (/^Sisa langkah:/i.test(line)) {
      inRemaining = true;
      continue;
    }
    if (/^[A-Za-z][A-Za-z /()-]+:\s*/.test(line)) {
      inRemaining = false;
      continue;
    }
    if (inRemaining && line.startsWith('- ')) {
      const title = line.slice(2).trim();
      if (title) remainingSteps.push(title);
    }
  }
  return { objective, remainingSteps, hadError };
}

function inferStepPhase(title: string): StructuredPlanStep['phase'] {
  const lower = title.toLowerCase();
  if (/inspeksi|baca|periksa|inspect|read|search/.test(lower)) return 'inspect';
  if (/rancang|desain|design/.test(lower)) return 'design';
  if (/perbaik|repair|fix|debug/.test(lower)) return 'repair';
  if (/validasi|verifikasi|test|uji|build|pratinjau|verify/.test(lower)) return 'verify';
  return 'implement';
}

export function classifyAgentIntent(params: {
  prompt: string;
  mode: 'build' | 'discuss';
  existingFiles: string[];
  hasRuntimeError: boolean;
  isBlankStarter: boolean;
}): { intent: AgentIntent; complexity: TaskComplexity } {
  const { prompt, mode, existingFiles, hasRuntimeError, isBlankStarter } = params;
  const trimmed = prompt.trim();

  if (mode === 'discuss') {
    return { intent: 'architecture_discuss', complexity: trimmed.length > 180 ? 'medium' : 'low' };
  }

  if (hasRuntimeError || REPAIR_KEYWORDS.test(trimmed)) {
    const complexRepair = FULLSTACK_KEYWORDS.test(trimmed) || existingFiles.length > 5;
    return { intent: 'bug_repair', complexity: complexRepair ? 'high' : 'medium' };
  }

  if (isBlankStarter || NEW_APP_KEYWORDS.test(trimmed)) {
    const isComplex = FULLSTACK_KEYWORDS.test(trimmed) || trimmed.length > 160;
    return { intent: 'new_app', complexity: isComplex ? 'high' : 'medium' };
  }

  if (SIMPLE_EDIT_KEYWORDS.test(trimmed) && trimmed.length < 140 && !FULLSTACK_KEYWORDS.test(trimmed)) {
    return { intent: 'simple_edit', complexity: 'low' };
  }

  const complexity: TaskComplexity =
    FULLSTACK_KEYWORDS.test(trimmed) || trimmed.length > 200 || existingFiles.length > 8
      ? 'high'
      : trimmed.length > 80
        ? 'medium'
        : 'low';

  return { intent: 'fullstack_feature', complexity };
}

export function extractRequirementsFromPrompt(prompt: string): string[] {
  const lines = prompt
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length >= 6);

  if (lines.length > 1) {
    return lines.slice(0, 6).map((l) => l.slice(0, 140));
  }

  const clauses = prompt
    .split(/(?:,|;|\bdengan\b|\bserta\b|\bdan\b|\bwith\b|\band\b)/i)
    .map((c) => c.trim())
    .filter((c) => c.length >= 8);

  if (clauses.length > 1) {
    return clauses.slice(0, 5).map((c) => c.slice(0, 140));
  }

  return [prompt.trim().slice(0, 160)];
}

export function selectRelevantFiles(prompt: string, existingFiles: string[]): string[] {
  if (existingFiles.length === 0) {
    const wantsDb =
      FULLSTACK_KEYWORDS.test(prompt) ||
      (PERSISTENT_DATA_APP_KEYWORDS.test(prompt) && !EXPLICIT_STATIC_KEYWORDS.test(prompt));
    return wantsDb ? ['index.html', 'schema.sql', 'package.json'] : ['index.html', 'package.json'];
  }
  const lower = prompt.toLowerCase();
  const matched = existingFiles.filter((filePath) => {
    const base = filePath.toLowerCase();
    const stem = base.split('/').pop()?.replace(/\.[^.]+$/, '') || base;
    if (lower.includes(base) || (stem.length >= 3 && lower.includes(stem))) return true;
    if (/sql|database|tabel|table|schema|api|drizzle|postgres/.test(lower) && (base.endsWith('.sql') || base.startsWith('db/') || base.includes('schema'))) {
      return true;
    }
    if (
      /backend|server|api|endpoint|auth|login|route|express|hono|fastify|middleware|fullstack|full-stack|webhook|upload|sse|stream/.test(lower) &&
      (base === 'server.ts' ||
        base === 'server.js' ||
        base.startsWith('server/') ||
        base.startsWith('api/') ||
        base.startsWith('routes/') ||
        base.startsWith('shared/'))
    ) {
      return true;
    }
    if (/test|uji|spec/.test(lower) && /test|spec/.test(base)) return true;
    if (/package|dependen|script|build/.test(lower) && base === 'package.json') return true;
    if (
      /ui|style|css|tampilan|layout|halaman|page|nav|form|button|frontend|client|komponen|component/.test(lower) &&
      (base === 'index.html' || base === 'client/index.html' || base.startsWith('client/') || base.startsWith('src/') || base.endsWith('.css'))
    ) {
      return true;
    }
    return false;
  });

  if (matched.length > 0) return matched.slice(0, 10);
  const anchors = ['package.json', 'schema.sql', 'server.ts', 'server/index.ts', 'index.html', 'client/index.html'].filter((a) =>
    existingFiles.includes(a)
  );
  const merged = Array.from(new Set([...anchors, ...existingFiles]));
  return merged.slice(0, 8);
}

export function buildExecutionPlan(params: {
  prompt: string;
  mode: 'build' | 'discuss';
  projectType: ProjectType;
  existingFiles: string[];
  lastError: string | null;
  isBlankStarter: boolean;
  projectHandoff?: string;
}): AgentExecutionPlan {
  const { prompt, mode, existingFiles, lastError, isBlankStarter, projectHandoff } = params;
  const continuation = mode === 'build' && isContinuationPrompt(prompt);
  const handoffCtx = continuation ? parseProjectHandoffForPlan(projectHandoff) : null;

  if (continuation && handoffCtx && (handoffCtx.objective || handoffCtx.remainingSteps.length > 0)) {
    const inheritedObjective = handoffCtx.objective || prompt.trim().replace(/\s+/g, ' ').slice(0, 160);
    const inheritedIntent: AgentIntent =
      lastError || handoffCtx.hadError ? 'bug_repair' : 'fullstack_feature';
    const inheritedComplexity: TaskComplexity =
      handoffCtx.remainingSteps.length > 1 || existingFiles.length > 4 || inheritedObjective.length > 80
        ? 'high'
        : 'medium';
    const steps: StructuredPlanStep[] =
      handoffCtx.remainingSteps.length > 0
        ? handoffCtx.remainingSteps.slice(0, 5).map((title, idx) => ({
            id: `step_${idx + 1}`,
            phase: inferStepPhase(title),
            title,
            status: 'pending' as const,
          }))
        : [
            { id: 'step_1', phase: 'inspect', title: 'Periksa status file & serah-terima giliran sebelumnya', status: 'pending' },
            { id: 'step_2', phase: inheritedIntent === 'bug_repair' ? 'repair' : 'implement', title: `Lanjutkan implementasi: ${inheritedObjective.slice(0, 90)}`, status: 'pending' },
            { id: 'step_3', phase: 'verify', title: 'Jalankan validasi proyek & pengujian', status: 'pending' },
          ];
    return {
      intent: inheritedIntent,
      complexity: inheritedComplexity,
      objective: inheritedObjective,
      requiresHeavyPlanning: true,
      requirements: [
        inheritedObjective,
        ...handoffCtx.remainingSteps.slice(0, 4),
      ],
      relevantFiles: selectRelevantFiles(`${inheritedObjective} ${prompt}`, existingFiles),
      steps,
      verificationCriteria: [
        'Melanjutkan pekerjaan sesuai serah-terima sebelumnya tanpa mengulang dari nol',
        'validate_project dan pengujian lulus',
      ],
    };
  }

  const { intent, complexity } = classifyAgentIntent({
    prompt,
    mode,
    existingFiles,
    hasRuntimeError: Boolean(lastError),
    isBlankStarter,
  });

  const requirements = extractRequirementsFromPrompt(prompt);
  const relevantFiles = selectRelevantFiles(prompt, existingFiles);
  const objective = prompt.trim().replace(/\s+/g, ' ').slice(0, 160);

  if (intent === 'architecture_discuss') {
    return {
      intent,
      complexity,
      objective,
      requiresHeavyPlanning: false,
      requirements,
      relevantFiles,
      steps: [
        { id: 'step_1', phase: 'inspect', title: 'Analisis konteks & arsitektur proyek', status: 'running' },
        { id: 'step_2', phase: 'design', title: 'Susun rekomendasi arsitektur tanpa mengubah file', status: 'pending' },
      ],
      verificationCriteria: ['Tidak ada file proyek yang dimodifikasi dalam mode Diskusi'],
    };
  }

  if (intent === 'simple_edit') {
    return {
      intent,
      complexity,
      objective,
      requiresHeavyPlanning: false,
      requirements,
      relevantFiles,
      steps: [
        { id: 'step_1', phase: 'implement', title: `Terapkan perubahan terarah pada ${relevantFiles[0] || 'index.html'}`, status: 'pending' },
        { id: 'step_2', phase: 'verify', title: 'Validasi integritas proyek & pratinjau', status: 'pending' },
      ],
      verificationCriteria: ['Perubahan tersimpan bersih tanpa merusak fitur eksisting'],
    };
  }

  if (intent === 'bug_repair') {
    return {
      intent,
      complexity,
      objective,
      requiresHeavyPlanning: true,
      requirements,
      relevantFiles,
      steps: [
        { id: 'step_1', phase: 'inspect', title: 'Inspeksi file terdampak, log runtime, dan error preview', status: 'pending' },
        { id: 'step_2', phase: 'repair', title: 'Terapkan patch minimal untuk akar masalah', status: 'pending' },
        { id: 'step_3', phase: 'verify', title: 'Jalankan validasi proyek & pengujian regresi', status: 'pending' },
      ],
      verificationCriteria: [
        'Error runtime/preview teratasi',
        'Validasi proyek dan pengujian (bila tersedia) lulus tanpa error',
      ],
    };
  }

  if (intent === 'new_app') {
    const wantsDbOrBackend =
      FULLSTACK_KEYWORDS.test(prompt) ||
      (PERSISTENT_DATA_APP_KEYWORDS.test(prompt) && !EXPLICIT_STATIC_KEYWORDS.test(prompt));
    const needsDb = wantsDbOrBackend;
    const steps: StructuredPlanStep[] = [
      { id: 'step_1', phase: 'design', title: 'Rancang struktur UI responsif, alur data, dan komponen utama', status: 'pending' },
      ...(needsDb
        ? [{ id: 'step_2', phase: 'implement' as const, title: 'Tulis skema SQLite (schema.sql) & antarmuka penuh (index.html)', status: 'pending' as const }]
        : [{ id: 'step_2', phase: 'implement' as const, title: 'Implementasikan antarmuka aplikasi lengkap (index.html)', status: 'pending' as const }]),
      { id: 'step_3', phase: 'verify', title: needsDb ? 'Verifikasi skema, validasi proyek, dan pratinjau aktif' : 'Verifikasi antarmuka, validasi proyek, dan pratinjau aktif', status: 'pending' },
    ];
    return {
      intent,
      complexity,
      objective,
      requiresHeavyPlanning: true,
      requirements,
      relevantFiles,
      steps,
      verificationCriteria: [
        'index.html lengkap, responsif, dan bebas template starter',
        ...(needsDb ? ['Skema SQLite valid bila aplikasi menggunakan database'] : []),
        'validate_project lulus tanpa error maupun kebocoran secret',
      ],
    };
  }

  // fullstack_feature
  return {
    intent,
    complexity,
    objective,
    requiresHeavyPlanning: true,
    requirements,
    relevantFiles,
    steps: [
      { id: 'step_1', phase: 'inspect', title: 'Inspeksi file proyek & dependensi terkait', status: 'pending' },
      { id: 'step_2', phase: 'implement', title: 'Terapkan pembaruan multi-file (frontend, skema/API, logika)', status: 'pending' },
      { id: 'step_3', phase: 'verify', title: 'Jalankan validasi, build/test, dan perbaiki error bila ada', status: 'pending' },
    ],
    verificationCriteria: [
      'Fitur baru terintegrasi tanpa merusak fitur sebelumnya',
      'validate_project dan pengujian lulus',
    ],
  };
}

export function formatPlanMarkdown(plan: AgentExecutionPlan): string {
  const lines: string[] = [];
  lines.push(`Tujuan: ${plan.objective}`);
  lines.push(`Klasifikasi: ${plan.intent} (kompleksitas: ${plan.complexity})`);
  if (plan.activeSkills && plan.activeSkills.length > 0) {
    lines.push(`Skill Opsional: ${plan.activeSkills.join(', ')}`);
  }
  if (plan.steps.length > 0) {
    lines.push('Langkah:');
    plan.steps.forEach((step, idx) => {
      const icon = step.status === 'done' ? '[x]' : step.status === 'failed' ? '[!]' : '[ ]';
      lines.push(`${idx + 1}. ${icon} ${step.title}`);
    });
  }
  return lines.join('\n');
}

export function advancePlanForTool(
  plan: AgentExecutionPlan,
  toolName: string,
  status: 'running' | 'success' | 'error'
): AgentExecutionPlan {
  if (toolName === 'update_project_memory') return plan;
  const phaseMap: Record<string, StructuredPlanStep['phase']> = {
    list_files: 'inspect',
    read_file: 'inspect',
    search_files: 'inspect',
    inspect_dependencies: 'inspect',
    workspace_diff: 'inspect',
    write_file: 'implement',
    edit_file: 'implement',
    delete_file: 'implement',
    create_directory: 'implement',
    install_dependencies: 'implement',
    validate_project: 'verify',
    run_tests: 'verify',
    build_project: 'verify',
    run_command: 'verify',
    read_logs: 'inspect',
    rollback_checkpoint: 'repair',
  };

  const targetPhase = phaseMap[toolName] || 'implement';
  let matched = false;
  const nextSteps = plan.steps.map((step) => {
    if (!matched && (step.phase === targetPhase || (targetPhase === 'implement' && step.phase === 'repair'))) {
      matched = true;
      return {
        ...step,
        status: status === 'running' ? ('running' as const) : status === 'success' ? ('done' as const) : ('failed' as const),
      };
    }
    // Mark earlier design/inspect steps done once implementation begins
    if (targetPhase === 'implement' && (step.phase === 'design' || step.phase === 'inspect') && step.status === 'pending') {
      return { ...step, status: 'done' as const };
    }
    if (targetPhase === 'verify' && (step.phase === 'design' || step.phase === 'inspect' || step.phase === 'implement') && step.status === 'running') {
      return { ...step, status: 'done' as const };
    }
    return step;
  });

  return { ...plan, steps: nextSteps };
}
