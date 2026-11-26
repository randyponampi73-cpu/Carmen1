import { AlertCircle, CheckCircle2, ExternalLink, Globe, KeyRound, Loader2, LogOut, Moon, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { COPY, PROVIDER_CATALOG_META, PROVIDER_KEY_PLACEHOLDERS } from '../i18n';
import { ApiError, api } from '../lib/api';
import type { Locale, ModelTier, ProviderType, ThemeMode, UserProfile } from '../types';
import { CustomSelect } from './CustomSelect';

const LAST_EMAIL_STORAGE_KEY = 'carmen_last_email';

function readRememberedEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveRememberedEmail(email: string): void {
  try {
    if (email) localStorage.setItem(LAST_EMAIL_STORAGE_KEY, email);
  } catch {
    // Ignore storage access restrictions
  }
}

interface AuthViewProps {
  locale: Locale;
  theme: ThemeMode;
  demoEnabled: boolean;
  emailEnabled: boolean;
  initialNotice?: string | null;
  onToggleLocale: () => void;
  onToggleTheme: () => void;
  onAuthenticated: (user: UserProfile, showOnboarding: boolean) => void;
}

export function AuthView({
  locale,
  theme,
  demoEnabled,
  emailEnabled,
  initialNotice,
  onToggleLocale,
  onToggleTheme,
  onAuthenticated,
}: AuthViewProps) {
  const t = COPY[locale];
  const [mode, setMode] = useState<'login' | 'register' | 'magic'>('login');
  const [email, setEmail] = useState<string>(readRememberedEmail);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [magicToken, setMagicToken] = useState('');
  const [magicAwaitingCode, setMagicAwaitingCode] = useState(false);
  const [magicNotice, setMagicNotice] = useState<string | null>(null);
  const [registeredEmailConflict, setRegisteredEmailConflict] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialNotice || null);
  const tabBaseId = useId();

  const availableTabs: Array<{ id: 'login' | 'register' | 'magic'; label: string }> = emailEnabled
    ? [
        { id: 'login', label: t.authTabLogin },
        { id: 'register', label: t.authTabRegister },
        { id: 'magic', label: t.authTabMagic },
      ]
    : [
        { id: 'login', label: t.authTabLogin },
        { id: 'register', label: t.authTabRegister },
      ];

  const effectiveMode = !emailEnabled && mode === 'magic' ? 'login' : mode;

  function switchAuthMode(nextMode: 'login' | 'register' | 'magic', nextNotice: string | null = null) {
    setMode(nextMode);
    setError(null);
    setRegisteredEmailConflict(false);
    setMagicNotice(nextNotice);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail !== email) setEmail(cleanEmail);

    setError(null);
    setRegisteredEmailConflict(false);
    setMagicNotice(null);
    setLoading(true);
    try {
      if (effectiveMode === 'login') {
        const res = await api.login(cleanEmail, password);
        saveRememberedEmail(res.user.email || cleanEmail);
        onAuthenticated(res.user, false);
      } else if (effectiveMode === 'register') {
        const res = await api.register(cleanEmail, password, name.trim());
        saveRememberedEmail(res.user.email || cleanEmail);
        onAuthenticated(res.user, res.isNewUser);
      } else if (magicAwaitingCode && magicToken.trim()) {
        const res = await api.verifyMagicLink(magicToken.trim());
        saveRememberedEmail(res.user.email || cleanEmail);
        onAuthenticated(res.user, res.isNewUser);
      } else {
        const res = await api.magicLink(cleanEmail);
        setMagicAwaitingCode(true);
        setMagicNotice(res.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.authErrorFallback;
      const isConflict =
        effectiveMode === 'register' &&
        ((err instanceof ApiError && (err.status === 409 || err.code === 'EMAIL_EXISTS')) ||
          /sudah terdaftar|already registered/i.test(msg));
      if (isConflict) {
        setRegisteredEmailConflict(true);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoLogin() {
    if (loading || !demoEnabled) return;
    setError(null);
    setRegisteredEmailConflict(false);
    setLoading(true);
    try {
      const res = await api.loginDemo();
      onAuthenticated(res.user, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.authDemoErrorFallback);
    } finally {
      setLoading(false);
    }
  }

  function handleTabKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = availableTabs[(idx + delta + availableTabs.length) % availableTabs.length];
      switchAuthMode(next.id);
      document.getElementById(`${tabBaseId}-tab-${next.id}`)?.focus();
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-[400px] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center justify-between gap-2 mb-5">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-[6px] bg-[var(--accent)]" aria-hidden="true" />
            <span className="text-[16px] font-semibold tracking-tight">CARMEN</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleLocale}
              aria-label={t.switchLangLabel}
              className="h-8 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] flex items-center gap-1 cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>{locale.toUpperCase()}</span>
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? t.switchThemeToLight : t.switchThemeToDark}
              title={theme === 'dark' ? t.themeLightTitle : t.themeDarkTitle}
              className="h-8 w-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[var(--text)] flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4" strokeWidth={1.5} />
              ) : (
                <Moon className="w-4 h-4" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>

        <h1 className="text-[20px] font-semibold leading-tight mb-1">
          {effectiveMode === 'login'
            ? t.authLoginTitle
            : effectiveMode === 'register'
              ? t.authRegisterTitle
              : t.authMagicTitle}
        </h1>
        <p className="text-[13px] text-[var(--text-muted)] mb-5">{t.authSubtitle}</p>

        <div
          role="tablist"
          aria-label={t.authModeTabsAria}
          className={`grid ${emailEnabled ? 'grid-cols-3' : 'grid-cols-2'} gap-1 p-1 rounded-[6px] bg-[var(--surface-2)] border border-[var(--border)] mb-5`}
        >
          {availableTabs.map((item, idx) => (
            <button
              key={item.id}
              id={`${tabBaseId}-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={effectiveMode === item.id}
              aria-controls={`${tabBaseId}-panel`}
              tabIndex={effectiveMode === item.id ? 0 : -1}
              onClick={() => switchAuthMode(item.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={`h-7 rounded-[6px] text-[12px] font-medium cursor-pointer ${
                effectiveMode === item.id
                  ? 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div id={`${tabBaseId}-panel`} role="tabpanel" aria-labelledby={`${tabBaseId}-tab-${effectiveMode}`}>
          {error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--error-text)]"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div>{error}</div>
                {registeredEmailConflict && (
                  <button
                    type="button"
                    onClick={() => {
                      switchAuthMode('login', t.authRegisteredLoginHint);
                      requestAnimationFrame(() => {
                        document.getElementById('auth-password')?.focus();
                      });
                    }}
                    className="inline-flex items-center text-[12px] font-semibold underline text-[var(--text)] hover:text-[var(--accent-text)] cursor-pointer"
                  >
                    {t.authSwitchToLoginWithEmail}
                  </button>
                )}
              </div>
            </div>
          )}

          {magicNotice && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-[6px] border border-[var(--success)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--success-text)]"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <span>{magicNotice}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {effectiveMode === 'register' && (
              <div>
                <label htmlFor="auth-name" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.authNameLabel}
                </label>
                <input
                  id="auth-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.authNamePlaceholder}
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.authEmailLabel}
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (registeredEmailConflict) setRegisteredEmailConflict(false);
                }}
                placeholder={t.authEmailPlaceholder}
                className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>

            {effectiveMode === 'magic' && magicAwaitingCode && (
              <div>
                <label htmlFor="auth-magic-token" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.authMagicTokenLabel}
                </label>
                <input
                  id="auth-magic-token"
                  type="text"
                  required
                  autoComplete="one-time-code"
                  value={magicToken}
                  onChange={(e) => setMagicToken(e.target.value)}
                  placeholder={t.authMagicTokenPlaceholder}
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            )}

            {effectiveMode !== 'magic' && (
              <div>
                <label htmlFor="auth-password" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.authPasswordLabel}
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={effectiveMode === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-9 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />}
              <span>
                {effectiveMode === 'login'
                  ? t.authSubmitLogin
                  : effectiveMode === 'register'
                    ? t.authSubmitRegister
                    : magicAwaitingCode
                      ? t.authVerifyToken
                      : t.authSendMagicLink}
              </span>
            </button>
          </form>

          {effectiveMode !== 'magic' && (
            <div className="mt-3 text-center text-[12px] text-[var(--text-muted)]">
              <span>{effectiveMode === 'register' ? t.authPromptHaveAccount : t.authPromptNeedAccount} </span>
              <button
                type="button"
                onClick={() => switchAuthMode(effectiveMode === 'register' ? 'login' : 'register')}
                className="font-medium text-[var(--text)] hover:text-[var(--accent-text)] underline cursor-pointer"
              >
                {effectiveMode === 'register' ? t.authTabLogin : t.authTabRegister}
              </button>
            </div>
          )}

          {demoEnabled && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleDemoLogin()}
                className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[13px] font-medium text-[var(--text)] disabled:opacity-50 cursor-pointer"
              >
                {t.authDemoButton}
              </button>
              <p className="mt-2 text-[12px] text-[var(--text-muted)]">{t.authDemoDesc}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface OnboardingConnectProps {
  locale: Locale;
  onComplete: () => Promise<void> | void;
  onSkip: () => void;
  onLogout: () => Promise<void> | void;
}

export function OnboardingConnectView({ locale, onComplete, onSkip, onLogout }: OnboardingConnectProps) {
  const t = COPY[locale];
  const [provider, setProvider] = useState<ProviderType>('gemini');
  const [customLabel, setCustomLabel] = useState('Custom Provider');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [customModels, setCustomModels] = useState('');
  const [tierDeclared, setTierDeclared] = useState<ModelTier>('unknown');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const selectedMeta = PROVIDER_CATALOG_META.find((p) => p.id === provider)!;

  async function handleTest() {
    if (testing || saving) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testEphemeralKey({
        provider,
        label: provider === 'custom' ? customLabel.trim() || 'Custom Provider' : selectedMeta.name,
        apiKey,
        tierDeclared,
        baseUrl: provider === 'custom' || provider === 'coarena' ? baseUrl.trim() || undefined : undefined,
        customModels:
          provider === 'custom' ? customModels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      });
      setTestResult({ ok: res.ok, message: res.message });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : t.onboardingTestFail });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setTestResult(null);
    try {
      await api.addKey({
        provider,
        label: provider === 'custom' ? customLabel.trim() || 'Custom Provider' : selectedMeta.name,
        apiKey,
        tierDeclared,
        baseUrl: provider === 'custom' || provider === 'coarena' ? baseUrl.trim() || undefined : undefined,
        customModels:
          provider === 'custom' ? customModels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      });
      await onComplete();
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : t.onboardingSaveFail });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-[540px] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[var(--accent-text)]" strokeWidth={1.5} />
            <h1 className="text-[20px] font-semibold">{t.onboardingTitle}</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSkip}
              className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
            >
              {t.onboardingSkip}
            </button>
            <button
              type="button"
              onClick={() => void onLogout()}
              aria-label={t.logout}
              className="inline-flex items-center gap-1 text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>{t.logout}</span>
            </button>
          </div>
        </div>

        <p className="text-[13px] text-[var(--text-muted)] mb-5">{t.onboardingSubtitle}</p>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor="onb-provider" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              {t.onboardingProviderLabel}
            </label>
            <CustomSelect
              id="onb-provider"
              locale={locale}
              ariaLabel={t.onboardingProviderLabel}
              value={provider}
              onChange={(val) => {
                const nextProv = val as ProviderType;
                setProvider(nextProv);
                setBaseUrl(nextProv === 'coarena' ? 'https://coarena.ai/api/v1' : '');
                setTierDeclared('unknown');
                setTestResult(null);
              }}
              triggerClassName="h-9"
              options={PROVIDER_CATALOG_META.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
            <div className="mt-1.5 flex items-center justify-between text-[12px] text-[var(--text-muted)]">
              <span>{locale === 'id' ? selectedMeta.noteId : selectedMeta.noteEn}</span>
              {provider !== 'custom' && (
                <a
                  href={selectedMeta.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--text)] hover:underline whitespace-nowrap ml-2"
                >
                  <span>{t.onboardingGetKey}</span>
                  <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
                </a>
              )}
            </div>
          </div>

          {provider === 'coarena' && (
            <div>
              <label htmlFor="onb-coarena-baseurl" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.coarenaBaseUrlLabel}
              </label>
              <input
                id="onb-coarena-baseurl"
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://coarena.ai/api/v1"
                className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          )}

          {provider === 'custom' && (
            <>
              <div>
                <label htmlFor="onb-custom-name" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.onboardingCustomNameLabel}
                </label>
                <input
                  id="onb-custom-name"
                  type="text"
                  required
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder={t.onboardingCustomNamePlaceholder}
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="onb-baseurl" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.onboardingBaseUrlLabel}
                </label>
                <input
                  id="onb-baseurl"
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t.onboardingBaseUrlPlaceholder}
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="onb-models" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.onboardingManualModelsLabel}
                </label>
                <input
                  id="onb-models"
                  type="text"
                  value={customModels}
                  onChange={(e) => setCustomModels(e.target.value)}
                  placeholder={t.onboardingManualModelsPlaceholder}
                  className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="onb-key" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              API Key
            </label>
            <input
              id="onb-key"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={PROVIDER_KEY_PLACEHOLDERS[provider]}
              className="w-full h-9 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>

          {selectedMeta.supportsAccountTier && (
            <div>
              <label htmlFor="onb-tier" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.onboardingTierLabel}
              </label>
              <CustomSelect
                id="onb-tier"
                locale={locale}
                ariaLabel={t.onboardingTierLabel}
                value={tierDeclared}
                onChange={(val) => setTierDeclared(val as ModelTier)}
                triggerClassName="h-9"
                options={[
                  { value: 'free', label: t.filterFree },
                  { value: 'paid', label: t.filterPaid },
                  { value: 'unknown', label: t.unknown },
                ]}
              />
            </div>
          )}

          {testResult && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-[6px] border px-3 py-2 text-[13px] bg-[var(--surface-2)] ${
                testResult.ok
                  ? 'border-[var(--success)] text-[var(--success-text)]'
                  : 'border-[var(--error)] text-[var(--error-text)]'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={!apiKey.trim() || testing || saving}
              onClick={() => void handleTest()}
              className="h-9 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[13px] font-medium text-[var(--text)] disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.testConnection}</span>
            </button>
            <button
              type="submit"
              disabled={!apiKey.trim() || saving}
              className="h-9 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.onboardingSaveContinue}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
