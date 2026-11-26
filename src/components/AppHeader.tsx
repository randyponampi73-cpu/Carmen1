import { Globe, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COPY } from '../i18n';
import type { UserProfile } from '../types';

export type MainRoute = 'home' | 'projects' | 'settings';

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

export function AppHeader({
  user,
  route,
  onNavigate,
  onToggleTheme,
  onToggleLocale,
  onLogout,
}: AppHeaderProps) {
  const t = COPY[user.locale];
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
    <header className="h-12 w-full border-b border-[var(--border)] bg-[var(--surface)] px-3 sm:px-6 flex items-center justify-between gap-2 sm:gap-6 shrink-0">
      {/* Zone 1: Brand wordmark */}
      <button
        type="button"
        onClick={() => onNavigate('home')}
        className="flex items-center gap-2 text-[14px] sm:text-[16px] font-semibold tracking-tight text-[var(--text)] whitespace-nowrap shrink-0 hover:opacity-85 cursor-pointer"
      >
        <span className="h-2.5 w-2.5 rounded-[6px] bg-[var(--accent)] shrink-0" aria-hidden="true" />
        <span>CARMEN</span>
      </button>

      {/* Zone 2: Clean single-line nav links */}
      <nav aria-label={t.navMainAria} className="flex items-center gap-3 sm:gap-5 text-[13px] font-medium">
        {(['home', 'projects', 'settings'] as MainRoute[]).map((item) => {
          const label = item === 'home' ? t.navHome : item === 'projects' ? t.navProjects : t.navSettings;
          const active = route === item;
          return (
            <button
              key={item}
              type="button"
              onClick={() => onNavigate(item)}
              aria-current={active ? 'page' : undefined}
              className={`h-12 px-0.5 sm:px-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                active
                  ? 'border-[var(--accent)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Compact account & preference controls */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={onToggleLocale}
          aria-label={t.switchLangLabel}
          title={t.switchLangLabel}
          className="h-8 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text)] hover:border-[var(--text-muted)] flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Globe className="w-3.5 h-3.5 hidden sm:block" strokeWidth={1.5} />
          <span>{user.locale.toUpperCase()}</span>
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={user.theme === 'dark' ? t.switchThemeToLight : t.switchThemeToDark}
          title={user.theme === 'dark' ? t.themeLightTitle : t.themeDarkTitle}
          className="h-8 w-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--text-muted)] flex items-center justify-center shrink-0 cursor-pointer"
        >
          {user.theme === 'dark' ? (
            <Sun className="w-4 h-4" strokeWidth={1.5} />
          ) : (
            <Moon className="w-4 h-4" strokeWidth={1.5} />
          )}
        </button>

        {/* Desktop & Tablet account controls */}
        <div className="hidden sm:flex items-center gap-2 pl-1">
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            aria-label={`${user.name || user.email}`}
            title={user.name || user.email}
            className="h-8 w-8 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] text-[12px] font-semibold text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer hover:border-[var(--text-muted)]"
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
            <LogOut className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Mobile account menu (keeps Sign Out & Settings accessible on <640px) */}
        <div ref={mobileMenuRef} className="relative sm:hidden">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((o) => !o)}
            aria-label={t.openAccountMenu}
            aria-haspopup="menu"
            aria-expanded={mobileMenuOpen}
            className="h-8 w-8 rounded-full bg-[var(--surface-2)] border border-[var(--border-strong)] text-[12px] font-semibold text-[var(--text)] flex items-center justify-center shrink-0 cursor-pointer"
          >
            {initials}
          </button>
          {mobileMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-10 z-50 w-52 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-1.5 space-y-1 text-[13px]"
              style={{ boxShadow: 'var(--shadow-float)' }}
            >
              <div className="px-2.5 py-1.5 border-b border-[var(--border)]">
                <div className="font-medium text-[var(--text)] truncate">{user.name}</div>
                <div className="text-[12px] font-mono text-[var(--text-muted)] truncate">{user.email}</div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onNavigate('settings');
                }}
                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--text)] flex items-center gap-2 text-left cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
                <span>{t.navSettings}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onLogout();
                }}
                className="w-full h-8 px-2.5 rounded-[6px] hover:bg-[var(--surface-2)] text-[var(--error-text)] flex items-center gap-2 text-left cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>{t.logout}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
