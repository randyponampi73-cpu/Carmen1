import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  COPY,
  PROVIDER_CATALOG_META,
  PROVIDER_KEY_PLACEHOLDERS,
  formatCompactNumber,
} from '../i18n';
import { api, loadLocalOnlyKeys, removeLocalOnlyKey, saveLocalOnlyKey, updateLocalOnlyKey } from '../lib/api';
import { ACCENT_PRESETS } from '../lib/theme';
import type {
  AccentColorId,
  Locale,
  ModelTier,
  ProviderKeyRecord,
  ProviderModel,
  ProviderType,
  ThemeMode,
  TriState,
  UserProfile,
} from '../types';
import { ConfirmDialog, ModalShell } from './ConfirmDialog';
import { CustomSelect, isModelNonChat, ModelSelect } from './CustomSelect';
import { ProviderBadge, TierBadge } from './ProviderBadge';

interface SettingsViewProps {
  user: UserProfile;
  keys: ProviderKeyRecord[];
  masterKeyConfigured?: boolean;
  models: ProviderModel[];
  modelWarnings: string[];
  accentColor?: AccentColorId;
  onSelectAccentColor?: (id: AccentColorId) => void;
  onRefreshKeysAndModels: (forceRefresh?: boolean) => Promise<void>;
  onUpdateProfile: (patch: Partial<UserProfile>) => Promise<void>;
  onDeleteAccount: () => Promise<void>;
}

type SettingsTab = 'providers' | 'models' | 'appearance' | 'account';

export function SettingsView({
  user,
  keys,
  masterKeyConfigured = true,
  models,
  modelWarnings,
  accentColor = 'crimson',
  onSelectAccentColor,
  onRefreshKeysAndModels,
  onUpdateProfile,
  onDeleteAccount,
}: SettingsViewProps) {
  const t = COPY[user.locale];
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const tabBaseId = useId();
  const providerModalTitleId = useId();

  // Add or rotate built-in or custom provider modal state
  const [modalMode, setModalMode] = useState<'none' | 'builtin' | 'custom' | 'rotate'>('none');
  const [editingKey, setEditingKey] = useState<ProviderKeyRecord | null>(null);
  const [formProvider, setFormProvider] = useState<ProviderType>('anthropic');
  const [formLabel, setFormLabel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formAuthHeader, setFormAuthHeader] = useState('Authorization');
  const [formChatPath, setFormChatPath] = useState('/chat/completions');
  const [formCustomModels, setFormCustomModels] = useState('');
  const [formTier, setFormTier] = useState<ModelTier>('unknown');
  const [formTools, setFormTools] = useState<TriState>('unknown');
  const [formVision, setFormVision] = useState<TriState>('unknown');
  const [formExtraHeaderKey, setFormExtraHeaderKey] = useState('');
  const [formExtraHeaderVal, setFormExtraHeaderVal] = useState('');
  const [formLocalOnly, setFormLocalOnly] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);
  const [formTestResult, setFormTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);

  // Confirmations
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<ProviderKeyRecord | null>(null);
  const [deleteKeyError, setDeleteKeyError] = useState<string | null>(null);
  const [confirmDeleteAccountOpen, setConfirmDeleteAccountOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

  // Model catalog filter (KEY-5)
  const [modelFilter, setModelFilter] = useState<'all' | 'free' | 'paid' | 'tools'>('all');
  const [showAllCatalogModels, setShowAllCatalogModels] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const selectedModalProviderMeta = useMemo(
    () => PROVIDER_CATALOG_META.find((p) => p.id === formProvider),
    [formProvider]
  );

  const { filteredModels, hiddenNonChatCount } = useMemo(() => {
    let hidden = 0;
    const out: ProviderModel[] = [];
    for (const m of models) {
      if (isModelNonChat(m) && !showAllCatalogModels) {
        hidden += 1;
        continue;
      }
      if (modelFilter === 'free' && m.tier !== 'free') continue;
      if (modelFilter === 'paid' && m.tier !== 'paid') continue;
      if (modelFilter === 'tools' && m.toolCalling !== 'yes') continue;
      out.push(m);
    }
    return { filteredModels: out, hiddenNonChatCount: hidden };
  }, [models, modelFilter, showAllCatalogModels]);

  function openBuiltInModal(provider: ProviderType) {
    const meta = PROVIDER_CATALOG_META.find((p) => p.id === provider);
    setEditingKey(null);
    setModalMode('builtin');
    setFormProvider(provider);
    setFormLabel(meta?.name || provider);
    setFormApiKey('');
    setFormBaseUrl(provider === 'coarena' ? 'https://coarena.ai/api/v1' : '');
    setFormTier(provider === 'groq' || provider === 'gemini' || provider === 'coarena' ? 'unknown' : 'paid');
    setFormLocalOnly(false);
    setFormError(null);
    setFormTestResult(null);
  }

  function openCustomModal() {
    setEditingKey(null);
    setModalMode('custom');
    setFormProvider('custom');
    setFormLabel('');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormAuthHeader('Authorization');
    setFormChatPath('/chat/completions');
    setFormCustomModels('');
    setFormTier('unknown');
    setFormTools('unknown');
    setFormVision('unknown');
    setFormExtraHeaderKey('');
    setFormExtraHeaderVal('');
    setFormLocalOnly(false);
    setFormError(null);
    setFormTestResult(null);
  }

  function openRotateModal(keyRecord: ProviderKeyRecord) {
    setEditingKey(keyRecord);
    setModalMode('rotate');
    setFormProvider(keyRecord.provider);
    setFormLabel(keyRecord.label);
    setFormApiKey('');
    setFormBaseUrl(keyRecord.baseUrl || '');
    setFormAuthHeader(keyRecord.authHeader || 'Authorization');
    setFormChatPath(keyRecord.chatPath || '/chat/completions');
    setFormCustomModels((keyRecord.customModels || []).join(', '));
    setFormTier(keyRecord.tierDeclared);
    setFormTools(keyRecord.supportsTools);
    setFormVision(keyRecord.supportsVision);
    setFormExtraHeaderKey('');
    setFormExtraHeaderVal('');
    setFormLocalOnly(Boolean(keyRecord.localOnly));
    setFormError(null);
    setFormTestResult(null);
  }

  async function handleTestFormKey() {
    if (busyKeyId) return;
    setFormError(null);
    setFormTestResult(null);
    setBusyKeyId('form-test');
    try {
      const res = await api.testEphemeralKey({
        provider: formProvider,
        label: formLabel || formProvider,
        apiKey: formApiKey,
        tierDeclared: formTier,
        baseUrl: formProvider === 'custom' || formProvider === 'coarena' ? formBaseUrl.trim() || undefined : undefined,
        authHeader: formProvider === 'custom' ? formAuthHeader : undefined,
        chatPath: formProvider === 'custom' ? formChatPath : undefined,
        customModels:
          formProvider === 'custom'
            ? formCustomModels.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
      });
      setFormTestResult({ ok: res.ok, message: res.message });
    } catch (err) {
      setFormTestResult({ ok: false, message: err instanceof Error ? err.message : t.providerTestFail });
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleSaveFormKey(e: React.FormEvent) {
    e.preventDefault();
    if (busyKeyId) return;
    setFormError(null);
    setBusyKeyId('form-save');
    try {
      const extraHeaders =
        formExtraHeaderKey.trim() && formExtraHeaderVal.trim()
          ? { [formExtraHeaderKey.trim()]: formExtraHeaderVal.trim() }
          : undefined;
      const parsedCustomModels =
        formProvider === 'custom'
          ? formCustomModels.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      const fallbackDefaultLabel =
        formProvider === 'coarena'
          ? 'Coarena AI'
          : formProvider === 'custom'
            ? 'Custom Provider'
            : selectedModalProviderMeta?.name || formProvider;

      if (modalMode === 'rotate' && editingKey) {
        if (editingKey.localOnly) {
          updateLocalOnlyKey(editingKey.id, {
            label: formLabel.trim() || editingKey.label,
            apiKey: formApiKey.trim(),
            tierDeclared: formTier,
            baseUrl: formProvider === 'custom' || formProvider === 'coarena' ? formBaseUrl.trim() || undefined : undefined,
            authHeader: formProvider === 'custom' ? formAuthHeader.trim() : undefined,
            chatPath: formProvider === 'custom' ? formChatPath.trim() : undefined,
            customModels: parsedCustomModels,
            supportsTools: formTools,
            supportsVision: formVision,
          });
        } else {
          await api.updateKey(editingKey.id, {
            label: formLabel.trim() || editingKey.label,
            apiKey: formApiKey.trim(),
            tierDeclared: formTier,
            baseUrl: formProvider === 'custom' || formProvider === 'coarena' ? formBaseUrl.trim() || undefined : undefined,
            authHeader: formProvider === 'custom' ? formAuthHeader.trim() : undefined,
            chatPath: formProvider === 'custom' ? formChatPath.trim() : undefined,
            customModels: parsedCustomModels,
            supportsTools: formTools,
            supportsVision: formVision,
          });
        }
      } else if (formLocalOnly) {
        const trimmedApiKey = formApiKey.trim();
        const localId = `key_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        saveLocalOnlyKey({
          id: localId,
          provider: formProvider,
          label: formLabel.trim() || fallbackDefaultLabel,
          apiKey: trimmedApiKey,
          keyLast4: trimmedApiKey.slice(-4),
          tierDeclared: formTier,
          baseUrl: formProvider === 'custom' || formProvider === 'coarena' ? formBaseUrl.trim() || undefined : undefined,
          authHeader: formProvider === 'custom' ? formAuthHeader.trim() : undefined,
          chatPath: formProvider === 'custom' ? formChatPath.trim() : undefined,
          customModels: parsedCustomModels,
          supportsTools: formTools,
          supportsVision: formVision,
          createdAt: new Date().toISOString(),
        });
      } else {
        await api.addKey({
          provider: formProvider,
          label: formLabel.trim() || fallbackDefaultLabel,
          apiKey: formApiKey.trim(),
          tierDeclared: formTier,
          baseUrl: formProvider === 'custom' || formProvider === 'coarena' ? formBaseUrl.trim() || undefined : undefined,
          authHeader: formProvider === 'custom' ? formAuthHeader.trim() : undefined,
          chatPath: formProvider === 'custom' ? formChatPath.trim() : undefined,
          customModels: parsedCustomModels,
          extraHeaders,
          supportsTools: formTools,
          supportsVision: formVision,
        });
      }
      await onRefreshKeysAndModels(true);
      setEditingKey(null);
      setModalMode('none');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t.providerSaveFail);
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleConfirmDeleteKey() {
    if (!deleteKeyTarget || busyKeyId) return;
    setDeleteKeyError(null);
    setBusyKeyId(deleteKeyTarget.id);
    try {
      if (deleteKeyTarget.localOnly) {
        removeLocalOnlyKey(deleteKeyTarget.id);
      } else {
        await api.deleteKey(deleteKeyTarget.id);
      }
      setDeleteKeyTarget(null);
      await onRefreshKeysAndModels(true);
    } catch (err) {
      setDeleteKeyError(err instanceof Error ? err.message : t.providerDeleteFail);
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleConfirmDeleteAccount() {
    if (deletingAccount) return;
    setDeleteAccountError(null);
    setDeletingAccount(true);
    try {
      await onDeleteAccount();
      setConfirmDeleteAccountOpen(false);
    } catch (err) {
      setDeleteAccountError(err instanceof Error ? err.message : t.accountDeleteFail);
    } finally {
      setDeletingAccount(false);
    }
  }

  const tabs: Array<[SettingsTab, string]> = [
    ['providers', t.tabProviders],
    ['models', t.tabModels],
    ['appearance', t.tabAppearance],
    ['account', t.tabAccount],
  ];

  function handleTabKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(idx + delta + tabs.length) % tabs.length];
      setTab(next[0]);
      setSettingsError(null);
      document.getElementById(`${tabBaseId}-tab-${next[0]}`)?.focus();
    }
  }

  return (
    <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-8">
      <div className="mx-auto max-w-[1040px] space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[20px] font-semibold text-[var(--text)]">{t.settingsTitle}</h1>
          <div
            role="tablist"
            aria-label={t.settingsTabsAria}
            className="flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-0.5 overflow-x-auto max-w-full"
          >
            {tabs.map(([id, label], idx) => (
              <button
                key={id}
                id={`${tabBaseId}-tab-${id}`}
                role="tab"
                type="button"
                aria-selected={tab === id}
                aria-controls={`${tabBaseId}-panel`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => {
                  setTab(id);
                  setSettingsError(null);
                }}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={`h-7 px-3 rounded-[6px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
                  tab === id
                    ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {settingsError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[6px] border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--error-text)]"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <span>{settingsError}</span>
          </div>
        )}

        <div id={`${tabBaseId}-panel`} role="tabpanel" aria-labelledby={`${tabBaseId}-tab-${tab}`}>
          {/* TAB 1: PROVIDER & KEY */}
          {tab === 'providers' && (
            <div className="space-y-6">
              {!masterKeyConfigured && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-[8px] border border-[var(--error)] bg-[var(--surface)] p-4 text-[13px] text-[var(--error-text)]"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                  <div className="space-y-1.5">
                    <div className="font-medium">{t.masterKeyTitle}</div>
                    <div className="text-[12px] text-[var(--text-muted)]">{t.masterKeyHelp}</div>
                    <details className="text-[12px] text-[var(--text-muted)]">
                      <summary className="cursor-pointer hover:text-[var(--text)] select-none">
                        {t.masterKeyDetailToggle}
                      </summary>
                      <p className="mt-1 font-mono text-[12px] text-[var(--text)]">{t.masterKeyDetailText}</p>
                    </details>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex items-start gap-2.5 text-[13px] text-[var(--text-muted)] max-w-[65ch]">
                  <ShieldCheck className="w-4 h-4 text-[var(--success-text)] shrink-0 mt-0.5" strokeWidth={1.5} />
                  <span>{t.encryptionNotice}</span>
                </div>
                <button
                  type="button"
                  onClick={() => openCustomModal()}
                  className="h-8 px-3.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-4 h-4" strokeWidth={1.5} />
                  <span>{t.addCustomProvider}</span>
                </button>
              </div>

              {/* 7 Provider Slots Grid (Anthropic, OpenAI, Coarena AI, OpenRouter, Groq, Gemini, Custom) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {PROVIDER_CATALOG_META.map((meta) => {
                  const slotKeys = keys.filter((k) => k.provider === meta.id);
                  return (
                    <div
                      key={meta.id}
                      className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <h2 className="text-[14px] font-semibold text-[var(--text)] truncate">{meta.name}</h2>
                            <ProviderBadge provider={meta.id} />
                          </div>
                          {meta.id !== 'custom' && (
                            <a
                              href={meta.keyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] inline-flex items-center gap-1 whitespace-nowrap"
                            >
                              <span>{t.getKeyLink}</span>
                              <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
                            </a>
                          )}
                        </div>
                        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                          {user.locale === 'id' ? meta.noteId : meta.noteEn}
                        </p>

                        {slotKeys.length > 0 && (
                          <div className="mt-3 divide-y divide-[var(--border)] border border-[var(--border)] rounded-[6px] bg-[var(--surface-2)]">
                            {slotKeys.map((k) => (
                              <div key={k.id} className="p-2.5 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="text-[13px] font-medium text-[var(--text)] truncate">{k.label}</span>
                                        {k.localOnly && (
                                          <span className="px-1.5 py-0.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] text-[10px] font-medium text-[var(--text-muted)] shrink-0">
                                            {t.localOnlyBadge}
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[12px] text-[var(--text-muted)] font-mono tabular-nums truncate">
                                        ••••{k.keyLast4}
                                        {k.baseUrl ? ` · ${k.baseUrl}` : ''}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <button
                                        type="button"
                                        disabled={busyKeyId === k.id}
                                        onClick={async () => {
                                          setSettingsError(null);
                                          setBusyKeyId(k.id);
                                          try {
                                            if (k.localOnly) {
                                              const rawLocal = loadLocalOnlyKeys().find((lk) => lk.id === k.id);
                                              if (!rawLocal) throw new Error(t.providerTestFail);
                                              const testRes = await api.testEphemeralKey({
                                                provider: rawLocal.provider,
                                                label: rawLocal.label,
                                                apiKey: rawLocal.apiKey,
                                                tierDeclared: rawLocal.tierDeclared,
                                                baseUrl: rawLocal.baseUrl,
                                                authHeader: rawLocal.authHeader,
                                                chatPath: rawLocal.chatPath,
                                                customModels: rawLocal.customModels,
                                              });
                                              updateLocalOnlyKey(k.id, {
                                                lastTestStatus: testRes.ok ? 'ok' : 'error',
                                                lastTestMessage: testRes.message,
                                              });
                                            } else {
                                              await api.testKey(k.id);
                                            }
                                            await onRefreshKeysAndModels(false);
                                          } catch (err) {
                                            const msg = err instanceof Error ? err.message : t.providerTestFail;
                                            if (k.localOnly) {
                                              updateLocalOnlyKey(k.id, {
                                                lastTestStatus: 'error',
                                                lastTestMessage: msg,
                                              });
                                              await onRefreshKeysAndModels(false);
                                            }
                                            setSettingsError(msg);
                                          } finally {
                                            setBusyKeyId(null);
                                          }
                                        }}
                                        className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text)] flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                                      >
                                      {busyKeyId === k.id && <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />}
                                      <span>{t.testConnection}</span>
                                    </button>
                                    {!k.isServerEnv && (
                                      <>
                                        <button
                                          type="button"
                                          disabled={busyKeyId === k.id}
                                          aria-label={`${t.rotateKey} ${k.label}`}
                                          title={t.rotateKey}
                                          onClick={() => openRotateModal(k)}
                                          className="h-7 px-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--text-muted)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                                        >
                                          <KeyRound className="w-3 h-3" strokeWidth={1.5} />
                                          <span className="hidden sm:inline">{t.rotateKey}</span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={busyKeyId === k.id}
                                          aria-label={`${t.delete} ${k.label}`}
                                          onClick={() => {
                                            setDeleteKeyError(null);
                                            setDeleteKeyTarget(k);
                                          }}
                                          className="h-7 w-7 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--error-text)] flex items-center justify-center disabled:opacity-50 cursor-pointer"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>

                                {meta.supportsAccountTier && (
                                  <div className="flex items-center justify-between gap-2 text-[12px]">
                                    <span className="text-[var(--text-muted)]">{t.accountTierLabel}</span>
                                    <div className="w-[150px]">
                                      <CustomSelect
                                        locale={user.locale}
                                        ariaLabel={`${t.accountTierModalLabel} ${k.label}`}
                                        value={k.tierDeclared}
                                        onChange={async (val) => {
                                          setSettingsError(null);
                                          try {
                                            if (k.localOnly) {
                                              updateLocalOnlyKey(k.id, { tierDeclared: val as ModelTier });
                                            } else {
                                              await api.updateKey(k.id, { tierDeclared: val as ModelTier });
                                            }
                                            await onRefreshKeysAndModels(true);
                                          } catch (err) {
                                            setSettingsError(
                                              err instanceof Error ? err.message : t.providerUpdateTierFail
                                            );
                                          }
                                        }}
                                        align="right"
                                        triggerClassName="h-7 bg-[var(--surface)] text-[12px]"
                                        options={[
                                          { value: 'free', label: t.filterFree },
                                          { value: 'paid', label: t.filterPaid },
                                          { value: 'unknown', label: t.unknown },
                                        ]}
                                      />
                                    </div>
                                  </div>
                                )}

                                {k.lastTestMessage && (
                                  <div
                                    className={`flex items-start gap-1.5 text-[12px] ${
                                      k.lastTestStatus === 'ok'
                                        ? 'text-[var(--success-text)]'
                                        : 'text-[var(--error-text)]'
                                    }`}
                                  >
                                    {k.lastTestStatus === 'ok' ? (
                                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
                                    ) : (
                                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={1.5} />
                                    )}
                                    <span>{k.lastTestMessage}</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[12px] text-[var(--text-muted)]">
                          {slotKeys.length > 0 ? `${slotKeys.length} ${t.connectedCount}` : t.notConnected}
                        </span>
                        <button
                          type="button"
                          onClick={() => (meta.id === 'custom' ? openCustomModal() : openBuiltInModal(meta.id))}
                          className="h-7 px-2.5 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[12px] font-medium text-[var(--text)] cursor-pointer"
                        >
                          {meta.id === 'custom' ? t.addCustomProvider : t.addKey}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: MODEL DEFAULT, FALLBACK & CATALOG (KEY-4, KEY-5, KEY-6) */}
          {tab === 'models' && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4">
                <div>
                  <label htmlFor="default-model-select" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.defaultModelLabel}
                  </label>
                  <ModelSelect
                    id="default-model-select"
                    ariaLabel={t.defaultModelLabel}
                    locale={user.locale}
                    models={models}
                    value={user.defaultProviderKeyId && user.defaultModelId ? `${user.defaultProviderKeyId}::${user.defaultModelId}` : ''}
                    allowEmptyLabel={t.defaultModelEmpty}
                    triggerClassName="h-9"
                    popoverClassName="w-full min-w-[300px]"
                    onChange={async (val) => {
                      setSettingsError(null);
                      const sepIdx = val.indexOf('::');
                      const pkId = sepIdx >= 0 ? val.slice(0, sepIdx) : val;
                      const mid = sepIdx >= 0 ? val.slice(sepIdx + 2) : '';
                      try {
                        await onUpdateProfile({ defaultProviderKeyId: pkId || null, defaultModelId: mid || null });
                      } catch (err) {
                        setSettingsError(err instanceof Error ? err.message : t.profileUpdateFail);
                      }
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="fallback-model-select" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.fallbackModelLabel}
                  </label>
                  <ModelSelect
                    id="fallback-model-select"
                    ariaLabel={t.fallbackModelLabel}
                    locale={user.locale}
                    models={models}
                    value={user.fallbackProviderKeyId && user.fallbackModelId ? `${user.fallbackProviderKeyId}::${user.fallbackModelId}` : ''}
                    allowEmptyLabel={t.fallbackModelEmpty}
                    triggerClassName="h-9"
                    popoverClassName="w-full min-w-[300px]"
                    onChange={async (val) => {
                      setSettingsError(null);
                      const sepIdx = val.indexOf('::');
                      const pkId = sepIdx >= 0 ? val.slice(0, sepIdx) : val;
                      const mid = sepIdx >= 0 ? val.slice(sepIdx + 2) : '';
                      try {
                        await onUpdateProfile({ fallbackProviderKeyId: pkId || null, fallbackModelId: mid || null });
                      } catch (err) {
                        setSettingsError(err instanceof Error ? err.message : t.profileUpdateFail);
                      }
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="group"
                  aria-label={t.filterModelsAria}
                  className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-0.5 overflow-x-auto max-w-full"
                >
                  {(
                    [
                      ['all', t.filterAll],
                      ['free', t.filterFree],
                      ['paid', t.filterPaid],
                      ['tools', t.filterTools],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={modelFilter === id}
                      onClick={() => setModelFilter(id)}
                      className={`h-7 px-2.5 rounded-[6px] text-[12px] font-medium whitespace-nowrap cursor-pointer ${
                        modelFilter === id
                          ? 'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  {(hiddenNonChatCount > 0 || showAllCatalogModels) && (
                    <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showAllCatalogModels}
                        onChange={(e) => setShowAllCatalogModels(e.target.checked)}
                        className="accent-[var(--accent)]"
                      />
                      <span>
                        {t.showAllModels}
                        {!showAllCatalogModels && hiddenNonChatCount > 0 ? ` (+${hiddenNonChatCount})` : ''}
                      </span>
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={refreshingModels}
                    onClick={async () => {
                      setSettingsError(null);
                      setRefreshingModels(true);
                      try {
                        await onRefreshKeysAndModels(true);
                      } catch (err) {
                        setSettingsError(err instanceof Error ? err.message : t.modelsRefreshFail);
                      } finally {
                        setRefreshingModels(false);
                      }
                    }}
                    className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text)] flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshingModels ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                    <span>{t.refreshModels}</span>
                  </button>
                </div>
              </div>

              {modelWarnings.length > 0 && (
                <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--warning-text)] space-y-1">
                  {modelWarnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}

              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
                <table aria-label={t.modelCatalogAria} className="w-full text-left border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-muted)]">
                      <th scope="col" className="py-2.5 px-4 font-medium">Model</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">Provider</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">Tier</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">Tool-calling</th>
                      <th scope="col" className="py-2.5 px-3 font-medium">{t.colVision}</th>
                      <th scope="col" className="py-2.5 px-4 font-medium text-right tabular-nums">{t.colContext}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {filteredModels.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 px-4 text-center text-[13px] text-[var(--text-muted)]">
                          {t.noModelsForFilter}
                        </td>
                      </tr>
                    ) : (
                      filteredModels.map((m) => (
                        <tr key={`${m.providerKeyId}::${m.id}`} className="hover:bg-[var(--surface-2)]">
                          <td className="py-2 px-4">
                            <div className="font-medium text-[var(--text)]">{m.name}</div>
                            <div className="text-[12px] font-mono text-[var(--text-muted)]">{m.id}</div>
                          </td>
                          <td className="py-2 px-3">
                            <ProviderBadge provider={m.provider} label={m.providerLabel} />
                          </td>
                          <td className="py-2 px-3">
                            <TierBadge tier={m.tier} locale={user.locale} note={m.tierNote} />
                          </td>
                          <td className="py-2 px-3 text-[12px] text-[var(--text-muted)]">
                            {m.toolCalling === 'yes' ? t.yes : m.toolCalling === 'no' ? t.no : t.unknown}
                          </td>
                          <td className="py-2 px-3 text-[12px] text-[var(--text-muted)]">
                            {m.vision === 'yes' ? t.yes : m.vision === 'no' ? t.no : t.unknown}
                          </td>
                          <td className="py-2 px-4 text-right font-mono text-[12px] text-[var(--text-muted)] tabular-nums">
                            {m.maxContext === 'unknown' ? t.unknown : formatCompactNumber(m.maxContext, user.locale)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: APPEARANCE (AUTH-3) */}
          {tab === 'appearance' && (
            <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-5 max-w-[540px]">
              <div>
                <span className="block text-[13px] font-medium text-[var(--text)] mb-2">
                  {t.appearanceThemeLabel}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['dark', t.appearanceDarkOpt],
                      ['light', t.appearanceLightOpt],
                    ] as Array<[ThemeMode, string]>
                  ).map(([modeOpt, label]) => (
                    <button
                      key={modeOpt}
                      type="button"
                      aria-pressed={user.theme === modeOpt}
                      onClick={async () => {
                        setSettingsError(null);
                        try {
                          await onUpdateProfile({ theme: modeOpt });
                        } catch (err) {
                          setSettingsError(err instanceof Error ? err.message : t.profileUpdateFail);
                        }
                      }}
                      className={`h-9 rounded-[6px] border text-[13px] font-medium cursor-pointer ${
                        user.theme === modeOpt
                          ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                          : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-[13px] font-medium text-[var(--text)] mb-2">
                  {t.appearanceLangLabel}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['id', 'Bahasa Indonesia'],
                      ['en', 'English'],
                    ] as Array<[Locale, string]>
                  ).map(([locOpt, label]) => (
                    <button
                      key={locOpt}
                      type="button"
                      aria-pressed={user.locale === locOpt}
                      onClick={async () => {
                        setSettingsError(null);
                        try {
                          await onUpdateProfile({ locale: locOpt });
                        } catch (err) {
                          setSettingsError(err instanceof Error ? err.message : t.profileUpdateFail);
                        }
                      }}
                      className={`h-9 rounded-[6px] border text-[13px] font-medium cursor-pointer ${
                        user.locale === locOpt
                          ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                          : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-[13px] font-medium text-[var(--text)] mb-1">
                  {t.appearanceAccentLabel}
                </span>
                <p className="text-[12px] text-[var(--text-muted)] mb-2.5">{t.appearanceAccentHint}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label={t.appearanceAccentLabel}>
                  {ACCENT_PRESETS.map((preset) => {
                    const selected = accentColor === preset.id;
                    const label = user.locale === 'id' ? preset.labelId : preset.labelEn;
                    const palette = user.theme === 'light' ? preset.light : preset.dark;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectAccentColor?.(preset.id)}
                        className={`h-9 px-3 rounded-[6px] border flex items-center justify-between gap-2 text-[13px] font-medium cursor-pointer ${
                          selected
                            ? 'border-[var(--accent)] bg-[var(--surface-2)] text-[var(--text)]'
                            : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-3.5 h-3.5 rounded-[4px] border border-[var(--border-strong)] shrink-0"
                            style={{ backgroundColor: palette.accent }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{label}</span>
                        </span>
                        {selected && <Check className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" strokeWidth={2} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ACCOUNT & PERMANENT DELETION (AUTH-4) */}
          {tab === 'account' && (
            <div className="space-y-4 max-w-[540px]">
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
                <h2 className="text-[16px] font-semibold text-[var(--text)]">{t.accountInfoTitle}</h2>
                <div className="text-[13px] text-[var(--text-muted)]">
                  <div>
                    Email: <span className="text-[var(--text)] font-mono">{user.email}</span>
                  </div>
                  <div className="mt-1">
                    {t.accountNameLabel}: <span className="text-[var(--text)]">{user.name}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-[8px] border border-[var(--error)] bg-[var(--surface)] p-5 space-y-3">
                <h2 className="text-[16px] font-semibold text-[var(--error-text)]">{t.deleteAccountTitle}</h2>
                <p className="text-[13px] text-[var(--text-muted)]">{t.deleteAccountDesc}</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder="HAPUS"
                    aria-label={t.deleteAccountAria}
                    className="h-8 flex-1 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={deleteConfirm !== 'HAPUS' || deletingAccount}
                    onClick={() => {
                      setDeleteAccountError(null);
                      setConfirmDeleteAccountOpen(true);
                    }}
                    className="h-8 px-3.5 rounded-[6px] bg-[var(--error-fill)] hover:opacity-90 text-white text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {t.deleteAccountButton}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ADD / ROTATE PROVIDER DIALOG */}
      <ModalShell
        open={modalMode !== 'none'}
        onClose={() => {
          setEditingKey(null);
          setModalMode('none');
        }}
        busy={busyKeyId === 'form-save' || busyKeyId === 'form-test'}
        ariaLabelledBy={providerModalTitleId}
        maxWidthClass="max-w-[540px]"
        className="p-5"
      >
        <div className="flex items-center justify-between gap-2 mb-4">
          <h2 id={providerModalTitleId} className="text-[16px] font-semibold text-[var(--text)]">
            {modalMode === 'rotate'
              ? `${t.rotateKeyTitle} · ${editingKey?.label || selectedModalProviderMeta?.name || formProvider}`
              : modalMode === 'custom'
                ? t.modalAddCustomTitle
                : `${t.addKey} · ${selectedModalProviderMeta?.name || formProvider}`}
          </h2>
          {formProvider === 'coarena' && (
            <a
              href="https://coarena.ai/developers"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] inline-flex items-center gap-1"
            >
              <span>coarena.ai/developers</span>
              <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
            </a>
          )}
        </div>

        {modalMode === 'rotate' && (
          <div className="mb-4 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
            {t.rotateKeyHint}
          </div>
        )}

        {formProvider === 'coarena' && (
          <div className="mb-4 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
            {t.coarenaAdapterInfo}
          </div>
        )}

        <form onSubmit={handleSaveFormKey} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="prov-label" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.displayNameLabel}
              </label>
              <input
                id="prov-label"
                required
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder={formProvider === 'coarena' ? 'Coarena AI' : 'Custom Provider'}
                className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="prov-tier" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.accountTierModalLabel}
              </label>
              <CustomSelect
                id="prov-tier"
                locale={user.locale}
                ariaLabel={t.accountTierModalLabel}
                value={formTier}
                onChange={(val) => setFormTier(val as ModelTier)}
                options={[
                  { value: 'free', label: t.filterFree },
                  { value: 'paid', label: t.filterPaid },
                  { value: 'unknown', label: t.unknown },
                ]}
              />
            </div>
          </div>

          {formProvider === 'coarena' && (
            <div>
              <label htmlFor="prov-coarena-baseurl" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                {t.coarenaBaseUrlLabel}
              </label>
              <input
                id="prov-coarena-baseurl"
                type="url"
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                placeholder="https://coarena.ai/api/v1"
                className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          )}

          {modalMode === 'custom' && (
            <>
              <div>
                <label htmlFor="prov-baseurl" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.customBaseUrlLabel}
                </label>
                <input
                  id="prov-baseurl"
                  type="url"
                  required
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                  placeholder={t.onboardingBaseUrlPlaceholder}
                  className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="prov-auth-hdr" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.authHeaderLabel}
                  </label>
                  <input
                    id="prov-auth-hdr"
                    value={formAuthHeader}
                    onChange={(e) => setFormAuthHeader(e.target.value)}
                    placeholder="Authorization"
                    className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="prov-chat-path" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.chatPathLabel}
                  </label>
                  <input
                    id="prov-chat-path"
                    value={formChatPath}
                    onChange={(e) => setFormChatPath(e.target.value)}
                    placeholder="/chat/completions"
                    className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="prov-models" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                  {t.onboardingManualModelsLabel}
                </label>
                <input
                  id="prov-models"
                  value={formCustomModels}
                  onChange={(e) => setFormCustomModels(e.target.value)}
                  placeholder={t.onboardingManualModelsPlaceholder}
                  className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="prov-tools" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.supportsToolsLabel}
                  </label>
                  <CustomSelect
                    id="prov-tools"
                    locale={user.locale}
                    ariaLabel={t.supportsToolsLabel}
                    value={formTools}
                    onChange={(val) => setFormTools(val as TriState)}
                    options={[
                      { value: 'unknown', label: t.unknown },
                      { value: 'yes', label: t.yes },
                      { value: 'no', label: t.no },
                    ]}
                  />
                </div>
                <div>
                  <label htmlFor="prov-vision" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
                    {t.supportsVisionLabel}
                  </label>
                  <CustomSelect
                    id="prov-vision"
                    locale={user.locale}
                    ariaLabel={t.supportsVisionLabel}
                    value={formVision}
                    onChange={(val) => setFormVision(val as TriState)}
                    options={[
                      { value: 'unknown', label: t.unknown },
                      { value: 'yes', label: t.yes },
                      { value: 'no', label: t.no },
                    ]}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={formExtraHeaderKey}
                  onChange={(e) => setFormExtraHeaderKey(e.target.value)}
                  placeholder={t.extraHeaderNamePlaceholder}
                  aria-label={t.extraHeaderNamePlaceholder}
                  className="h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[12px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
                <input
                  type="password"
                  autoComplete="off"
                  value={formExtraHeaderVal}
                  onChange={(e) => setFormExtraHeaderVal(e.target.value)}
                  placeholder={t.extraHeaderValPlaceholder}
                  aria-label={t.extraHeaderValPlaceholder}
                  className="h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[12px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="prov-apikey" className="block text-[12px] font-medium text-[var(--text-muted)] mb-1">
              API Key
            </label>
            <input
              id="prov-apikey"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={modalMode === 'rotate' ? t.rotationPlaceholder : PROVIDER_KEY_PLACEHOLDERS[formProvider]}
              className="w-full h-8 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 text-[13px] font-mono text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>

          {modalMode !== 'rotate' && (
            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-[12px] text-[var(--text)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={formLocalOnly}
                  onChange={(e) => setFormLocalOnly(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                <span>{t.localOnlyToggleLabel}</span>
              </label>
              {formLocalOnly && (
                <div className="rounded-[6px] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--warning-text)]">
                  {t.localOnlyWarningNotice}
                </div>
              )}
            </div>
          )}

          {formError && (
            <div role="alert" className="flex items-start gap-2 rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--error-text)]">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <span>{formError}</span>
            </div>
          )}

          {formTestResult && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-[6px] border px-3 py-2 text-[12px] bg-[var(--surface-2)] ${
                formTestResult.ok
                  ? 'border-[var(--success)] text-[var(--success-text)]'
                  : 'border-[var(--error)] text-[var(--error-text)]'
              }`}
            >
              {formTestResult.ok ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              )}
              <span>{formTestResult.message}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={busyKeyId === 'form-save' || busyKeyId === 'form-test'}
              onClick={() => setModalMode('none')}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50 cursor-pointer"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              disabled={!formApiKey.trim() || busyKeyId === 'form-test' || busyKeyId === 'form-save'}
              onClick={() => void handleTestFormKey()}
              className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[13px] font-medium text-[var(--text)] disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              {busyKeyId === 'form-test' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.testConnection}</span>
            </button>
            <button
              type="submit"
              disabled={!formApiKey.trim() || busyKeyId === 'form-save'}
              className="h-8 px-4 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {busyKeyId === 'form-save' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
              <span>{t.save}</span>
            </button>
          </div>
        </form>
      </ModalShell>

      {/* Delete Key Confirmation */}
      <ConfirmDialog
        open={Boolean(deleteKeyTarget)}
        locale={user.locale}
        title={t.confirmDeleteKeyTitle}
        description={t.confirmDeleteKeyBody.replace('{name}', deleteKeyTarget?.label || '')}
        confirmLabel={t.confirmDeleteKeyButton}
        danger
        busy={Boolean(deleteKeyTarget && busyKeyId === deleteKeyTarget.id)}
        error={deleteKeyError}
        onConfirm={() => void handleConfirmDeleteKey()}
        onClose={() => {
          setDeleteKeyError(null);
          setDeleteKeyTarget(null);
        }}
      />

      {/* Delete Account Final Confirmation */}
      <ConfirmDialog
        open={confirmDeleteAccountOpen}
        locale={user.locale}
        title={t.confirmDeleteAccountTitle}
        description={t.confirmDeleteAccountBody.replace('{email}', user.email)}
        confirmLabel={t.deleteAccountButton}
        danger
        busy={deletingAccount}
        error={deleteAccountError}
        onConfirm={() => void handleConfirmDeleteAccount()}
        onClose={() => {
          setDeleteAccountError(null);
          setConfirmDeleteAccountOpen(false);
        }}
      />
    </main>
  );
}
