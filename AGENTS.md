# AGENTS.md

## Project Overview

Node.js + Express + EJS website with admin panel. SQLite database (better-sqlite3 preferred, sql.js fallback). Optimized for 2-core 2GB servers.

## Commands

```bash
npm run dev          # Development (Node with --expose-gc --max-old-space-size=768)
npm start            # Same as dev
npm run lint         # ESLint (server + scripts)
npm run lint:fix     # Auto-fix lint issues
npm run lint:server  # Lint server/ and scripts/ only
npm run lint:frontend # Lint public/js/ only
npm run security:full # npm audit + security scan
npm run pm2          # Production via PM2
```

No test suite exists. `npm test` is not configured.

## Architecture

- **Entry point**: `server/app.js` — Express app, middleware stack, route mounting
- **Database**: `server/config/database.js` — SQLite, 79 tables declared in `server/config/db-schema.js`, which is the single source of truth: CREATE TABLE only, no ALTER TABLE migrations (removed in v8.21.0)
- **Routes**: `server/routes/` — auth, admin (nested), frontend, setup, image-share, community, content, characters (角色卡广场 `/characters`)
- **Templates**: `views/` — EJS with `express-ejs-layouts`. Layout selection is path-based in `app.js` (`/ai-chat` and `/characters` render standalone with `layout = false`)
- **Admin routes**: `server/routes/admin/` — separate layout (`admin/layout.ejs`), all under `/admin`
- **AI chat services**: `server/services/ai-chat/` — `characters.js` (Character Card V1/V2/V3 normalize + world book + seed loader + source-type/export rules), `card-import.js` (shared `.json`/`.png` card parsing, PNG `chara` chunk read/rebuild, avatar persistence — used by both the admin importer and the plaza uploader), `context.js` (prompt assembly), `ui-prefs.js` (appearance whitelist), `regex.js`, `index.js`
- **Cache**: `server/config/cache.js` — in-memory LRU cache (settings 60s, queries 15s, pages 60s)

## Key Conventions

- Database uses `better-sqlite3` when available (native), falls back to `sql.js` (WASM). All DB calls go through `queryAll()` / `getDb()` from `server/config/database.js`
- Schema changes are made by editing `CREATE TABLE` in `server/config/db-schema.js` (unique indexes live in `db-indexes.js`). There are no startup migrations or dedup/repair scripts: existing databases are NOT altered in place, so upgrading structure requires re-initializing the DB or restoring a backup
- **Character cards live in the `ai_roles` table** (full Character Card V1/V2/V3 fields + `world_book` JSON + sharing/provenance/stats columns). `source_type` has four values with distinct rights (`services/ai-chat/characters.js`: `SOURCE_TYPES`/`NO_EXPORT_SOURCE`/`canExportCard`/`canShareCard`): `self` (site form) and `external` (file/URL import) can be shared and exported; `hub` (imported from the `/characters` plaza) is **use-only — cannot be re-shared or exported** (anti-leak); `official` (seed cards and admin batch uploads from the plaza) is site-wide, admin-governed, not shareable. The plaza list/detail view (`publicCardView`) hard-codes `can_export:false`; real export only happens on the AI chat page behind the `aichat.export` permission
- **Official seed cards**: `server/config/seed-characters/*.json` (~100 SFW cards, each with `source`/`license`/`source_url` provenance) are loaded by `characters.loadSeedCards()` and seeded idempotently (dedup by lowercase name) via `db-seed.js:seedOfficialCharacterCards()` on first install
- **Appearance customization** (`public/js/ai-appearance.js` + `[data-ac-*]` CSS layer in `ai-chat.css`) applies only to `/ai-chat` and `/characters`; prefs are whitelist-sanitized (`ui-prefs.js`), persisted to `users.ai_ui_settings` for logged-in users and `localStorage` for guests
- **Plaza uploads** (`POST /characters/api/cards/upload`, multipart `files`): needs login + `aichat.use` + CSRF. Managers (`aichat.manage` or super admin) may send up to 50 files and the cards land as **official** (`is_official=1, user_id=NULL, source_type='official'`, instantly site-wide); ordinary users up to 10 files, landing as their own **private** `external` cards (`is_shared=0`) which they must explicitly share. Per-file limit 10MB, `.json`/`.png` only, dedup by lowercase name (against official names for admins, own names for users), user cap 200 cards. Parsing is shared with the admin importer via `services/ai-chat/card-import.js:parseCardFiles()`
- **Card blocking lives in its own table `ai_role_blocks`** (`role_id` UNIQUE, `reason`, `blocked_by`, `blocked_at`) rather than a new `ai_roles` column, because the no-ALTER rule means only new *tables* appear automatically on existing databases. A blocked card is visible **only to its uploader** in the plaza (`characters.js:canViewCard`/`blockedFilterSql`); official cards have no owner so they disappear for everyone. Blocking also clears `is_shared`/`share_token` (old links die) and the card is filtered out of the AI-chat role picker/detail (`frontend.js:ROLE_VISIBLE_WHERE`). Already-created conversations and imported copies keep working. Governance entry points: plaza detail buttons (manager) and `/admin/ai-chat/roles/all*` (super admin, `?blocked=1|0` filter + `batch-block`). Every delete path also removes the `ai_role_blocks` row explicitly (don't rely on FK cascade)
- **Takedown vs block vs delete**: takedown (`/characters/api/cards/takedown`, `/admin/ai-chat/roles/all/unshare`) only removes public exposure — official cards are demoted to `self`, shared user cards lose `is_shared`/`share_token` — and the author can re-share; block hides the card from everyone but its uploader; delete removes the row and nulls `ai_conversations.role_id`. All three accept batch `ids` (array or comma string) and write one `logActivity` entry **per card** with `target_id`
- **Super-admin card governance**: `/admin/ai-chat/roles/all*` routes (`requireSuperAdminJson`) query/govern every user's cards; ordinary users see only their own unless shared. Batch endpoints exist for both the official-card list (`roles/batch-category`, `roles/batch-official`, `aichat.manage`) and site-wide governance (`roles/all/batch-unshare|batch-promote|batch-delete|batch-block`, super admin). Default world-book templates also support batch operations (`world-book-defaults/batch-delete|batch-enabled|batch-constant|batch-position`, `aichat.manage`)
- **In-app Q&A**: `HELP_QA` in `public/js/ai-chat.js` is the single source for the ❓ 指南 modal; categories are derived from the `cat` field, so adding entries needs no UI change. Deep links: `/ai-chat?newrole=1` (open the create-card form), `/ai-chat?help=1` (open the guide), `/ai-chat?help=plaza` (open the guide on the 角色卡广场 category — linked from the plaza footer)
- Production requires `SESSION_SECRET` env var — app exits without it
- PM2 process name: `website-admin`. Session secret persisted to `.session_secret` file
- Security middleware applied globally to all routes except `/setup`, `/health`, static assets, and XHR
- Activity logging middleware (`server/middlewares/activity-logger.js`) records user actions globally
- ESLint overrides: `scripts/` allows `no-process-exit` and `no-sync`.

## File Patterns

- `.gitignore` excludes `scripts/` (Python deploy scripts are not in repo for JS linting)
- Sensitive files excluded: `*.key`, `*.pem`, `config.json`, `security-config.json`
- Database file: `database.sqlite` (excluded from git)
- Upload directory: `public/uploads/` (excluded except `.gitkeep`)
- Official character-card seed corpus: `server/config/seed-characters/*.json` (committed; loaded only on first-install seeding)
