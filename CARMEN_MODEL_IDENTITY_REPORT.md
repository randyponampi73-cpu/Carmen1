# CARMEN — AI Model Identity & Logo System Report

**Date:** 2026-11-28  
**Status:** IMPLEMENTED & VERIFIED  
**Scope:** Centralized AI Model Creator & Provider Brand Identity Registry, Local SVG Asset Pipeline, Backend Enrichment, UI Rendering across All Selectors/Catalogs/Chat, and Security Validation

---

## 1. Architectural Principle: Strict Separation of Provider vs. Model Creator

A critical defect in multi-provider AI platforms is conflating the **API Provider / Aggregator** with the **Model Creator** (for example, showing an OpenRouter logo for `anthropic/claude-3.7-sonnet` or a Groq logo for `llama-3.3-70b-versatile`).

CARMEN implements a unified, strongly typed identity model in `shared/modelIdentity.ts` shared across backend and frontend that separates:

1. **Provider Identity (`provider`, `providerName`, `providerLogo`, `providerMonochrome`)**:
   - The platform/gateway executing the API request: `anthropic`, `gemini`, `openai`, `openrouter`, `groq`, `coarena`, `custom`.
2. **Model Creator Identity (`modelCreator`, `modelCreatorName`, `modelCreatorLogo`, `modelCreatorMonochrome`, `modelFamily`)**:
   - The organization that trained/authored the underlying model: `anthropic`, `openai`, `google`, `meta`, `deepseek`, `mistral`, `qwen`, `xai`, `cohere`, `perplexity`, `nvidia`, `microsoft`, `huggingface`, `coarena`, `custom`, `unknown`.
3. **Aggregation Flag (`isAggregated`)**:
   - Explicitly flags when an API provider (such as `openrouter`, `groq`, or `custom`) routes a model authored by another creator, enabling dual-brand display (`<ModelCreatorLogo />` primary + `<ProviderLogo />` route indicator).

---

## 2. Verified Local SVG Brand Asset Inventory (`/public/logos/`)

All 22 brand marks are stored locally inside `/public/logos/` and served directly by CARMEN via `GET /logos/*.svg` with `X-Content-Type-Options: nosniff` and `Cache-Control: public, max-age=86400`. **Zero external CDN calls are required at runtime**, preventing broken hotlinks, tracking leaks, or CSP violations.

| Asset File | Brand / Entity | Source & License | Theme Handling |
| :--- | :--- | :--- | :--- |
| `/logos/anthropic.svg` | Anthropic (Provider mark) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/claude-color.svg` | Claude / Anthropic (Model Creator) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/openai.svg` | OpenAI (GPT / o-series) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/gemini-color.svg` | Google Gemini | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/google-color.svg` | Google (Gemma / Google AI) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/meta-color.svg` | Meta (Llama 3 / Llama 4) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/deepseek-color.svg` | DeepSeek (R1 / V3 / Coder) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/mistral-color.svg` | Mistral AI (Mistral / Mixtral / Codestral / Devstral) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/qwen-color.svg` | Qwen / Alibaba Cloud (Qwen 2.5 / Qwen 3 / QwQ) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/grok.svg` | Grok / xAI (Model Creator) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/xai.svg` | xAI | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/cohere-color.svg` | Cohere (Command R / Command A) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/groq.svg` | Groq (Inference Provider) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/openrouter.svg` | OpenRouter (Aggregator Provider) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/perplexity-color.svg` | Perplexity (Sonar) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/nvidia-color.svg` | NVIDIA (Nemotron) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/microsoft-color.svg` | Microsoft (Phi) | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/huggingface-color.svg` | Hugging Face | `@lobehub/icons-static-svg@1.106.0` (MIT) | Full-color native |
| `/logos/ollama.svg` | Ollama | `@lobehub/icons-static-svg@1.106.0` (MIT) | Monochrome (`dark:invert`) |
| `/logos/coarena.svg` | Coarena AI | CARMEN-authored geometric mark (MIT) | Full-color native |
| `/logos/custom.svg` | Custom OpenAI-Compatible Endpoint | CARMEN-authored neutral node mark (MIT) | Monochrome (`dark:invert`) |
| `/logos/unknown.svg` | Unclassified / Fallback Model | CARMEN-authored neutral mark (MIT) | Monochrome (`dark:invert`) |

Attribution details are maintained alongside the assets in `/public/logos/ATTRIBUTION.md`.

---

## 3. Resolution Examples & Dual-Identity Mapping

| API Provider | Model ID | Resolved Creator | Creator Logo | Provider Logo | `isAggregated` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `openai` | `gpt-4.1` | OpenAI (`GPT`) | `/logos/openai.svg` | `/logos/openai.svg` | `false` |
| `anthropic` | `claude-sonnet-4-20250514` | Anthropic (`Claude`) | `/logos/claude-color.svg` | `/logos/anthropic.svg` | `false` |
| `gemini` | `gemini-2.5-pro` | Google (`Gemini`) | `/logos/gemini-color.svg` | `/logos/gemini-color.svg` | `false` |
| `openrouter` | `anthropic/claude-3.7-sonnet` | Anthropic (`Claude`) | `/logos/claude-color.svg` | `/logos/openrouter.svg` | `true` |
| `openrouter` | `openai/gpt-4o-mini` | OpenAI (`GPT`) | `/logos/openai.svg` | `/logos/openrouter.svg` | `true` |
| `openrouter` | `google/gemini-2.5-flash` | Google (`Gemini`) | `/logos/gemini-color.svg` | `/logos/openrouter.svg` | `true` |
| `groq` | `llama-3.3-70b-versatile` | Meta (`Llama 3.3`) | `/logos/meta-color.svg` | `/logos/groq.svg` | `true` |
| `groq` | `deepseek-r1-distill-llama-70b` | DeepSeek (`DeepSeek R1`) | `/logos/deepseek-color.svg` | `/logos/groq.svg` | `true` |
| `coarena` | `coarena-coder-pro` | Coarena AI (`Coarena`) | `/logos/coarena.svg` | `/logos/coarena.svg` | `false` |
| `custom` | `internal-ft-v1` | Custom Endpoint (`Custom`) | `/logos/custom.svg` | `/logos/custom.svg` | `true` |
| `openrouter` | `unrecognized-org/mystery-9b` | Other / Unclassified | `/logos/unknown.svg` | `/logos/openrouter.svg` | `true` |

---

## 4. Integration Across Backend & Frontend

- **Shared Registry**: `/shared/modelIdentity.ts` (`MODEL_CREATOR_BRANDS`, `PROVIDER_BRANDS`, `detectModelCreator`, `detectModelFamily`, `resolveModelIdentity`, `validateSafeLogoUrl`, `enrichProviderModel`, `getAllBrandCatalogSummary`).
- **Backend Enrichment**: `/server/providers/catalog.ts` automatically enriches every model passing through `setCachedModels()` and `deduplicateModels()` with `.identity`, `.streaming`, `.structuredOutput`, and `.availability`.
- **REST & Static Endpoints (`/server.ts`)**:
  - `GET /logos/*`: Serves local SVGs with `X-Content-Type-Options: nosniff` and `maxAge: '1d'`.
  - `GET /api/models/identity`: Authenticated catalog endpoint returning all registered creator/provider marks plus optional `?provider=...&modelId=...` identity resolution.
- **UI Components**:
  - `/src/components/ModelIdentityBadge.tsx`: `BrandLogo` (graceful `onError` monogram fallback + `dark:invert` for monochrome SVGs + `loading="lazy"` + accessible `alt`), `ProviderLogo`, `ModelCreatorLogo`, `ModelIdentityInline`.
  - `/src/components/ProviderBadge.tsx`: Displays `<ProviderLogo />` alongside provider label.
  - `/src/components/CustomSelect.tsx`: `ModelSelect` renders `<ModelCreatorLogo />`, dual `<ProviderLogo />` indicator on aggregated models, live search by model name/ID/creator/family/provider, and quick provider filter chips when multiple providers are configured.
  - `/src/components/SettingsView.tsx`: Provider key cards display `<ProviderLogo />`; Models Catalog tab includes search input, dedicated Creator column (`<ModelCreatorLogo />` + family), and Provider column (`<ProviderBadge />`).
  - `/src/components/workspace/ChatPanel.tsx`: Assistant message headers, active streaming header, and provider fallback transition banners display resolved creator/provider logos.

---

## 5. Security Controls on Logo Assets

- `validateSafeLogoUrl()` rejects control characters, whitespace, `javascript:`, `data:`, `file:`, protocol-relative URLs (`//...`), path traversal (`..`), loopback/RFC1918/link-local hosts, and credentialed URLs.
- Automated tests in `/server/providers/modelIdentity.test.ts` assert that every registered `logoPath` exists on disk under `/public/logos/`, contains valid `<svg>` markup, and contains zero `<script>` elements.
