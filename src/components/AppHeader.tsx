import { FolderKanban, Globe, Home, LogOut, Moon, Settings, Sparkles, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COPY } from '../i18n';
import { useViewportBreakpoints } from '../hooks/useMediaQuery';
import type { UserProfile } from '../types';

export type MainRoute = 'home' | 'projects' | 'skills' | 'settings';

interface AppHeaderProps {
  user: UserProfile;
  route: MainRoute;
  onNavigate: (route: MainRoute) => void;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onLogout: () => void;
}

function getInitials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function CarmenBrandMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'h-3 w-3' : size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  return (
    <span
      className={`${dim} rotate-45 rounded-[2px] bg-[var(--accent)] shrink-0 inline-block`}
      aria-hidden="true"
    />
  );
}

export function AppHeader({
  user,
  route,
  onNavigate,
  onToggleTheme,
  onToggleLocale,
  onLogout,
}: AppHeaderProps) {
  const t = COPY[user.locale];
  const { isMobile } = useViewportBreakpoints();
  const initials = getInitials(user.name, user.email);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [mobileMenuOpen]);

  return (
    <header className="sticky top-0 z-30 w-full border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-sm pt-safe shrink-0">
      <div className="h-12 max-w-[1440px] mx-auto px-3 sm:px-6 flex items-center justify-between gap-2 sm:gap-6">
        {/* Zone 1: Brand wordmark + Carmen Diamond */}
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="flex items-center gap-2.5 text-[14px] sm:text-[15px] font-bold tracking-[0.04em] text-[var(--text)] whitespace-nowrap shrink-0 hover:opacity-85 cursor-pointer min-h-[40px] sm:min-h-0"
        >
          <CarmenBrandMark />
          <span>CARMEN</span>
        </button>

        {/* Zone 2: Desktop & Tablet clean horizontal nav (mobile uses thumb-zone bottom bar for zero overflow at 320px) */}
        {!isMobile && (
          <nav aria-label={t.navMainAria} className="flex items-center gap-1 md:gap-2 text-[13px] font-medium">
            {(['home', 'projects', 'skills', 'settings'] as MainRoute[]).map((item) => {
              const label =
                item === 'home'
                  ? t.navHome
                  : item === 'projects'
                    ? t.navProjects
                    : item === 'skills'
                      ? t.navSkills
                      : t.navSettings;
              const active = route === item;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => onNavigate(item)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative h-12 px-3 transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center ${
                    active
                      ? 'text-[var(--text)] font-semibold'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <span>{label}</span>
                  {active && (
                    <span
                      className="absolute bottom-0 inset-x-2 h-[2px] bg-[var(--accent)] rounded-t-full"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}

        {/* Zone 3: Compact account & preference controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={onToggleLocale}
            aria-label={t.switchLangLabel}
            title={t.switchLangLabel}
            className="h-9 sm:h-8 px-2.5 sm:px-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text)] hover:border-[var(--border-strong)] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-[var(--text-muted)] hidden sm:block" strokeWidth={1.6} />
            <span>{user.locale.toUpperCase()}</span>
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={user.theme === 'dark' ? t.switchThemeToLight : t.switchThemeToDark}
            title={user.theme === 'dark' ? t.themeLightTitle : t.themeDarkTitle}
            className="h-9 w-9 sm:h-8 sm:w-8 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--border-strong)] flex items-center justify-center shrink-0 cursor-pointer"
          >
            {user.theme === 'dark' ? (
              <Sun className="w-4 h-4" strokeWidth={1.6} />
            ) : (
              <Moon className="w-4 h-4" strokeWidth={1.6} />
            )}
          </button>

          {/* Desktop & Tablet account controls */}
          <div className="hidden sm:flex items-center gap-1.5 pl-1 border-l border-[var(--border)] ml-0.5">
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              aria-label={`${user.name || user.email}`}
              title={user.name || user.email}
              className="h-8 w-8 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] text-[12px] font-semibold text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer hover:border-[var(--accent)]"
            >
              {initials}
            </button>
            <button
              type="button"
              onClick={onLogout}
              aria-label={t.logout}
              title={t.logout}
              className="h-8 w-8 rounded-[6px] border border-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>

          {/* Mobile account menu (keeps Sign Out & account info accessible on <640px) */}
          <div ref={mobileMenuRef} className="relative sm:hidden">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              aria-label={t.openAccountMenu}
              aria-haspopup="menu"
              aria-expanded={mobileMenuOpen}
              className="h-9 w-9 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] text-[12px] font-semibold text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer"
            >
              {initials}
            </button>
            {mobileMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 z-50 w-56 max-w-[calc(100vw-24px)] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-1.5 space-y-1 text-[13px]"
                style={{ boxShadow: 'var(--shadow-float)' }}
              >
                <div className="px-2.5 py-2 border-b border-[var(--border)]">
                  <div className="font-semibold text-[var(--text)] truncate">{user.name}</div>
                  <div className="text-[12px] font-mono text-[var(--text-muted)] truncate">{user.email}</div>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onNavigate('settings');
                  }}
                  className="w-full h-10 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-2 text-left cursor-pointer"
                >
                  <Settings className="w-4 h-4 text-[var(--text-muted)]" strokeWidth={1.6} />
                  <span>{t.navSettings}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onLogout();
                  }}
                  className="w-full h-10 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--error-text)] flex items-center gap-2 text-left cursor-pointer"
                >
                  <LogOut className="w-4 h-4" strokeWidth={1.6} />
                  <span>{t.logout}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

interface MobileBottomNavProps {
  locale: UserProfile['locale'];
  route: MainRoute;
  onNavigate: (route: MainRoute) => void;
}

export function MobileBottomNav({ locale, route, onNavigate }: MobileBottomNavProps) {
  const t = COPY[locale];
  const items: Array<{ id: MainRoute; label: string; icon: typeof Home }> = [
    { id: 'home', label: t.navHome, icon: Home },
    { id: 'projects', label: t.navProjects, icon: FolderKanban },
    { id: 'skills', label: t.navSkills, icon: Sparkles },
    { id: 'settings', label: t.navSettings, icon: Settings },
  ];

  return (
    <nav
      aria-label={t.navMainAria}
      className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-sm pb-safe"
    >
      <div className="grid grid-cols-4 h-[54px] px-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = route === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[44px] rounded-[6px] text-[11px] font-medium cursor-pointer ${
                active ? 'text-[var(--accent-text)] font-semibold' : 'text-[var(--text-muted)]'
              }`}
            >
              {active && (
                <span
                  className="absolute top-0 inset-x-4 h-[2px] bg-[var(--accent)] rounded-b-full"
                  aria-hidden="true"
                />
              )}
              <Icon className="w-4 h-4 shrink-0" strokeWidth={active ? 2 : 1.6} />
              <span className="truncate max-w-full px-1">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
