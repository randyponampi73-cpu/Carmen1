import type { AccentColorId, ThemeMode } from '../types';

export interface AccentPreset {
  id: AccentColorId;
  labelId: string;
  labelEn: string;
  swatch: string;
  light: {
    accent: string;
    accentText: string;
    accentHover: string;
  };
  dark: {
    accent: string;
    accentText: string;
    accentHover: string;
  };
}

export const ACCENT_STORAGE_KEY = 'carmen_accent';

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'crimson',
    labelId: 'Merah Karmen',
    labelEn: 'Carmen Crimson',
    swatch: '#C8324B',
    light: { accent: '#B52A42', accentText: '#B52A42', accentHover: '#9E2338' },
    dark: { accent: '#C8324B', accentText: '#E8566C', accentHover: '#B22A41' },
  },
  {
    id: 'cobalt',
    labelId: 'Biru Kobalt',
    labelEn: 'Ocean Cobalt',
    swatch: '#2563EB',
    light: { accent: '#1D4ED8', accentText: '#1D4ED8', accentHover: '#1E40AF' },
    dark: { accent: '#2563EB', accentText: '#60A5FA', accentHover: '#1D4ED8' },
  },
  {
    id: 'emerald',
    labelId: 'Hijau Zamrud',
    labelEn: 'Forest Emerald',
    swatch: '#16A34A',
    light: { accent: '#15803D', accentText: '#15803D', accentHover: '#166534' },
    dark: { accent: '#16A34A', accentText: '#4ADE80', accentHover: '#15803D' },
  },
  {
    id: 'amber',
    labelId: 'Kuning Okre',
    labelEn: 'Amber Ochre',
    swatch: '#D97706',
    light: { accent: '#B45309', accentText: '#B45309', accentHover: '#92400E' },
    dark: { accent: '#D97706', accentText: '#FBBF24', accentHover: '#B45309' },
  },
  {
    id: 'indigo',
    labelId: 'Nila Indigo',
    labelEn: 'Slate Indigo',
    swatch: '#4F46E5',
    light: { accent: '#4338CA', accentText: '#4338CA', accentHover: '#3730A3' },
    dark: { accent: '#4F46E5', accentText: '#818CF8', accentHover: '#4338CA' },
  },
];

export function isValidAccentId(val: unknown): val is AccentColorId {
  return ACCENT_PRESETS.some((p) => p.id === val);
}

export function getStoredAccentId(): AccentColorId {
  try {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isValidAccentId(saved)) return saved;
  } catch {
    // Ignore storage access restrictions
  }
  return 'crimson';
}

export function saveStoredAccentId(accentId: AccentColorId): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accentId);
  } catch {
    // Ignore storage access restrictions
  }
}

export function applyAccentCssVariables(accentId: AccentColorId, theme: ThemeMode): void {
  const preset = ACCENT_PRESETS.find((p) => p.id === accentId) ?? ACCENT_PRESETS[0];
  const palette = theme === 'light' ? preset.light : preset.dark;
  const root = document.documentElement;
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--accent-text', palette.accentText);
  root.style.setProperty('--accent-hover', palette.accentHover);
}
