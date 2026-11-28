import { safeOutboundFetch, readResponseTextWithLimit } from '../security';
import { listSkillsForContext } from './registry';
import type { SkillCategory, SkillPermission, SkillProvenance, SkillQualitySummary } from './types';

export interface MarketplaceSkillListing {
  slug: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: string;
  sourceType: 'curated-builtin' | 'remote';
  installed: boolean;
  enabled: boolean;
  trustBadge: string;
  permissions: SkillPermission[];
  tags: string[];
  frameworks: string[];
  dependencies: string[];
  conflicts: string[];
  quality?: SkillQualitySummary;
  provenance?: SkillProvenance;
}

export interface MarketplaceCatalogResponse {
  items: MarketplaceSkillListing[];
  remoteConfigured: boolean;
  remoteAvailable: boolean;
  remoteNotice: string;
  totalBuiltinCount: number;
  categories: SkillCategory[];
  frameworks: string[];
}

export async function getSkillMarketplaceCatalog(params: {
  userId: string;
  projectId?: string;
}): Promise<MarketplaceCatalogResponse> {
  const installed = await listSkillsForContext({
    userId: params.userId,
    projectId: params.projectId,
    includeDisabled: true,
  });

  const curatedItems: MarketplaceSkillListing[] = installed
    .filter((s) => s.source === 'builtin')
    .map((s) => ({
      slug: s.slug,
      name: s.name,
      category: s.category,
      description: s.description,
      version: s.currentVersion,
      sourceType: 'curated-builtin',
      installed: true,
      enabled: s.enabled,
      trustBadge: s.trustLevel,
      permissions: s.manifest.permissions,
      tags: s.manifest.tags || [],
      frameworks: s.manifest.frameworks || [],
      dependencies: s.manifest.dependencies || [],
      conflicts: s.manifest.conflicts || [],
      quality: s.manifest.quality,
      provenance: s.manifest.provenance,
    }));

  const buildFacets = (items: MarketplaceSkillListing[]) => {
    const categories = Array.from(new Set(items.map((i) => i.category))).sort() as SkillCategory[];
    const frameworks = Array.from(new Set(items.flatMap((i) => i.frameworks || []))).sort();
    return { categories, frameworks };
  };

  const remoteUrl = (process.env.CARMEN_SKILL_REGISTRY_URL || '').trim();
  if (!remoteUrl) {
    const facets = buildFacets(curatedItems);
    return {
      items: curatedItems,
      remoteConfigured: false,
      remoteAvailable: false,
      remoteNotice:
        'Menampilkan katalog terkurasi lokal CARMEN (CARMEN_SKILL_REGISTRY_URL belum dikonfigurasi). Tidak ada metrik rating/unduhan palsu.',
      totalBuiltinCount: curatedItems.length,
      ...facets,
    };
  }

  try {
    const res = await safeOutboundFetch(remoteUrl, { method: 'GET' }, { timeoutMs: 8000 });
    if (!res.ok) {
      const facets = buildFacets(curatedItems);
      return {
        items: curatedItems,
        remoteConfigured: true,
        remoteAvailable: false,
        remoteNotice: `Registry eksternal merespons HTTP ${res.status}; menampilkan katalog lokal.`,
        totalBuiltinCount: curatedItems.length,
        ...facets,
      };
    }
    const rawText = await readResponseTextWithLimit(res, 512 * 1024);
    const parsed = JSON.parse(rawText) as { items?: Partial<MarketplaceSkillListing>[] };
    const remoteItems = Array.isArray(parsed?.items) ? parsed.items.slice(0, 50) : [];
    const merged = [...curatedItems];
    const seen = new Set(merged.map((i) => i.slug));
    for (const r of remoteItems) {
      if (!r?.slug || seen.has(r.slug)) continue;
      merged.push({
        slug: String(r.slug),
        name: String(r.name || r.slug),
        category: (r.category as SkillCategory) || 'development',
        description: String(r.description || ''),
        version: String(r.version || '1.0.0'),
        sourceType: 'remote',
        installed: false,
        enabled: false,
        trustBadge: 'UNTRUSTED',
        permissions: Array.isArray(r.permissions)
          ? r.permissions.filter((p) => String(p).toUpperCase() !== 'ADMIN')
          : [],
        tags: Array.isArray(r.tags) ? r.tags.map(String).slice(0, 16) : [],
        frameworks: Array.isArray(r.frameworks) ? r.frameworks.map(String).slice(0, 16) : [],
        dependencies: Array.isArray(r.dependencies) ? r.dependencies.map(String).slice(0, 16) : [],
        conflicts: Array.isArray(r.conflicts) ? r.conflicts.map(String).slice(0, 16) : [],
        provenance: {
          origin: 'remote',
          license: r.provenance?.license || 'Unknown (verify before approval)',
        },
      });
    }
    const facets = buildFacets(merged);
    return {
      items: merged,
      remoteConfigured: true,
      remoteAvailable: true,
      remoteNotice: 'Tersinkronisasi dengan katalog lokal dan registry terkurasi.',
      totalBuiltinCount: curatedItems.length,
      ...facets,
    };
  } catch (err) {
    const facets = buildFacets(curatedItems);
    return {
      items: curatedItems,
      remoteConfigured: true,
      remoteAvailable: false,
      remoteNotice: `Registry eksternal tidak terjangkau (${err instanceof Error ? err.message : 'network error'}); menampilkan katalog lokal.`,
      totalBuiltinCount: curatedItems.length,
      ...facets,
    };
  }
}
