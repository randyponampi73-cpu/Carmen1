import { getRequiredPermissionsForTools } from '../agent/toolRegistry';
import type { SkillMetadata, SkillPermission } from './types';

export interface PermissionCheckResult {
  allowed: boolean;
  forbidden: boolean;
  needsApproval: boolean;
  missingPermissions: SkillPermission[];
  reason: string;
}

const ELEVATED_PERMISSIONS = new Set<SkillPermission>(['WRITE', 'EXECUTE', 'NETWORK', 'DEPLOY']);

export function computeEffectivePermissions(skill: SkillMetadata): SkillPermission[] {
  const perms = new Set<SkillPermission>(skill.manifest.permissions);
  for (const derived of getRequiredPermissionsForTools(skill.manifest.tools)) {
    perms.add(derived);
  }
  return Array.from(perms);
}

export function checkSkillExecutionPermissions(params: {
  skill: SkillMetadata;
  approvedPermissions?: SkillPermission[];
  hasScriptExecution?: boolean;
}): PermissionCheckResult {
  const { skill, approvedPermissions = [], hasScriptExecution = false } = params;
  const required = computeEffectivePermissions(skill);

  // Guard against any tampered permission entries
  if ((required as string[]).some((p) => String(p).toUpperCase() === 'ADMIN')) {
    return {
      allowed: false,
      forbidden: true,
      needsApproval: false,
      missingPermissions: [],
      reason: 'Izin ADMIN ditolak: Skill tidak boleh memperoleh hak administrator sistem.',
    };
  }

  if (skill.trustLevel === 'REVOKED') {
    return {
      allowed: false,
      forbidden: true,
      needsApproval: false,
      missingPermissions: [],
      reason: `Skill "${skill.slug}" telah dicabut (REVOKED) dan diblokir dari eksekusi.`,
    };
  }

  if (skill.trustLevel === 'DRAFT') {
    return {
      allowed: false,
      forbidden: false,
      needsApproval: true,
      missingPermissions: required,
      reason: `Skill "${skill.slug}" masih berstatus DRAFT dan harus divalidasi/disetujui terlebih dahulu.`,
    };
  }

  if (skill.trustLevel === 'UNTRUSTED') {
    return {
      allowed: false,
      forbidden: false,
      needsApproval: true,
      missingPermissions: required,
      reason: `Skill impor "${skill.slug}" berstatus UNTRUSTED; setujui izin sebelum mengaktifkan.`,
    };
  }

  const approvedSet = new Set<SkillPermission>([...skill.approvedPermissions, ...approvedPermissions]);

  // Builtin & Verified skills may execute core project READ/DATABASE/WRITE/EXECUTE tools when enabled,
  // unless external/created or executing custom scripts without explicit approval.
  if (skill.trustLevel === 'BUILTIN' || skill.trustLevel === 'VERIFIED') {
    if (hasScriptExecution && !approvedSet.has('EXECUTE')) {
      return {
        allowed: false,
        forbidden: false,
        needsApproval: true,
        missingPermissions: ['EXECUTE'],
        reason: `Eksekusi script dari skill "${skill.slug}" memerlukan persetujuan izin EXECUTE eksplisit.`,
      };
    }
    return {
      allowed: true,
      forbidden: false,
      needsApproval: false,
      missingPermissions: [],
      reason: 'Skill tepercaya diizinkan pada batas sandbox proyek.',
    };
  }

  // APPROVED custom/imported skills require explicit grants for elevated capabilities
  const missing = required.filter((perm) => ELEVATED_PERMISSIONS.has(perm) && !approvedSet.has(perm));
  if (missing.length > 0) {
    return {
      allowed: false,
      forbidden: false,
      needsApproval: true,
      missingPermissions: missing,
      reason: `Skill "${skill.slug}" memerlukan persetujuan izin: ${missing.join(', ')}.`,
    };
  }

  return {
    allowed: true,
    forbidden: false,
    needsApproval: false,
    missingPermissions: [],
    reason: 'Seluruh izin skill telah disetujui.',
  };
}
