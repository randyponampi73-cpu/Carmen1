import { safeOutboundFetch, readResponseTextWithLimit } from '../security';
import { listSkillsForContext } from './registry';
import type { SkillCategory, SkillPermission } from './types';

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
}

export interface MarketplaceCatalogResponse {
  items: MarketplaceSkillListing[];
  remoteConfigured: boolean;
  remoteAvailable: boolean;
  remoteNotice: string;
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
    }));

  const remoteUrl = (process.env.CARMEN_SKILL_REGISTRY_URL || '').trim();
  if (!remoteUrl) {
    return {
      items: curatedItems,
      remoteConfigured: false,
      remoteAvailable: false,
      remoteNotice: 'Menampilkan katalog terkurasi lokal (CARMEN_SKILL_REGISTRY_URL belum dikonfigurasi).',
    };
  }

  try {
    const res = await safeOutboundFetch(remoteUrl, { method: 'GET' }, { timeoutMs: 8000 });
    if (!res.ok) {
      return {
        items: curatedItems,
        remoteConfigured: true,
        remoteAvailable: false,
        remoteNotice: `Registry eksternal merespons HTTP ${res.status}; menampilkan katalog lokal.`,
      };
    }
    const rawText = await readResponseTextWithLimit(res, 512 * 1024);
    const parsed = JSON.parse(rawText) as { items?: MarketplaceSkillListing[] };
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
      });
    }
    return {
      items: merged,
      remoteConfigured: true,
      remoteAvailable: true,
      remoteNotice: 'Tersinkronisasi dengan katalog lokal dan registry terkurasi.',
    };
  } catch (err) {
    return {
      items: curatedItems,
      remoteConfigured: true,
      remoteAvailable: false,
      remoteNotice: `Registry eksternal tidak terjangkau (${err instanceof Error ? err.message : 'network error'}); menampilkan katalog lokal.`,
    };
  }
}
