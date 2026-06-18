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
- **Database**: `server/config/database.js` — SQLite with 40+ tables, auto-migrates on startup
- **Routes**: `server/routes/` — auth, admin (nested), frontend, setup, poem-game, image-share, community, content
- **Templates**: `views/` — EJS with `express-ejs-layouts`. Layout selection is path-based in `app.js:156-185`
- **Admin routes**: `server/routes/admin/` — separate layout (`admin/layout.ejs`), all under `/admin`
- **Cache**: `server/config/cache.js` — in-memory LRU cache (settings 60s, queries 15s, pages 60s)

## Key Conventions

- Database uses `better-sqlite3` when available (native), falls back to `sql.js` (WASM). All DB calls go through `queryAll()` / `getDb()` from `server/config/database.js`
- Production requires `SESSION_SECRET` env var — app exits without it
- PM2 process name: `website-admin`. Session secret persisted to `.session_secret` file
- Security middleware applied globally to all routes except `/setup`, `/health`, static assets, and XHR
- Activity logging middleware (`server/middlewares/activity-logger.js`) records user actions globally
- ESLint overrides: `scripts/` allows `no-process-exit` and `no-sync`. `public/js/poems_data.js` disables unused-vars and max-len

## File Patterns

- `.gitignore` excludes `scripts/` (Python deploy scripts are not in repo for JS linting)
- Sensitive files excluded: `*.key`, `*.pem`, `config.json`, `security-config.json`
- Database file: `database.sqlite` (excluded from git)
- Upload directory: `public/uploads/` (excluded except `.gitkeep`)
