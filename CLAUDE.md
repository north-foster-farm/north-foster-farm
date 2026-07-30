# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

North Foster Farm website - a static site built with Hugo (v0.164.0) and hosted on Netlify. The site uses Bootstrap 5.3.3, custom SCSS styling, and vanilla JavaScript with ES modules.

## Development Commands

```bash
# Start local development server (default)
npm start
# or: yarn start
# or: bin/dev

# Start server bound to local IP (requires /etc/hosts configuration)
npm run start:bind

# Run linters
npm run lint                # All linters
npm run lint:scripts        # ESLint for JS files
npm run lint:styles         # Stylelint for SCSS

# Production build. NETLIFY ONLY -- do not run this locally.
# bin/prod installs Dart Sass into /opt/build/repo, a path that only
# exists on the Netlify build image, so this fails on a dev machine.
# Netlify runs it via `yarn deploy && hugo --gc`.
npm run deploy
```

To check a production build locally, run the linters and then
`hugo --environment production` directly, skipping `bin/prod`.

### Development Server Modes

The `bin/dev` script supports two modes via environment variables:
- **Default**: Standard Hugo server on localhost:1313
- **`HUGO_BIND_TO_IP=true`**: Binds to local network IP (requires /etc/hosts entries for `northfosterfarm.local`)

## Architecture

### Hugo Configuration

Configuration is environment-specific using Hugo's layered config system:
- `config/_default/hugo.toml` - Base configuration
- `config/development/hugo.toml` - Dev overrides (title prefix)
- `config/production/hugo.toml` - Production settings (baseURL)

Key Hugo settings:
- Uses Hugo Pipes for asset processing
- Mounts `hugo_stats.json` to assets for PurgeCSS
- Requires extended Hugo >= 0.164.0
- Timezone: America/New_York

### Directory Structure

```
assets/
  images/          # Image assets processed by Hugo
  scripts/         # JavaScript modules (ES6+)
    main.js        # Entry point (imports Bootstrap, Extensions, Copyright, Touchable)
    extensions/    # Custom JS extensions
    copyright/     # Auto-update copyright year
    touchable/     # Touch event handling
    utils/         # Utility functions
  styles/          # SCSS source files
    main.scss      # Entry point (imports Bootstrap + custom styles)
    components/    # Component-specific styles
    mixins/        # SCSS mixins
    utilities/     # Utility classes

config/            # Hugo configuration (layered by environment)
content/           # Markdown content files
  _index.md        # Homepage content
  accessibility.md # Accessibility statement
  privacy.md       # Privacy policy

data/              # YAML data files
  company.yaml     # Company info (name, address, phone, email)
  socialMedia.yaml # Social media links

layouts/           # Hugo templates
  _default/        # Base templates (baseof, list, single)
  partials/        # Reusable template partials
    home/          # Homepage-specific partials (copy.html, contact.html)
    footer/        # Footer components
    head/          # Head tag components
    header/        # Header/navigation
    ctas/          # Call-to-action components
  index.html       # Homepage template

static/            # Static files (copied as-is to output)

bin/
  dev              # Development server wrapper script
  prod             # Production build script (installs Dart Sass)
```

### Build Process

**Development** (`bin/dev`):
- Hugo server runs with live reload
- Builds drafts, expired, and future content
- Disables fast render and HTTP cache for accurate previews
- Template metrics and debug output enabled

**Production** (`bin/prod` + `hugo --gc`):
1. Installs Dart Sass v1.79.5 to `node_modules/.bin`
2. Runs linters (ESLint + Stylelint)
3. Hugo processes SCSS via Dart Sass Embedded
4. PostCSS runs autoprefixer and PurgeCSS
5. JavaScript bundled via Hugo Pipes
6. Output to `public/` directory

### Styling Architecture

Bootstrap 5.3.3 forms the foundation with extensive customization:
- Custom variables in `_variables.scss` override Bootstrap defaults
- Component styles organized by feature in `components/`
- Utility classes extend Bootstrap utilities
- PurgeCSS removes unused CSS in production using `hugo_stats.json`

Import order in `main.scss`:
1. Custom fonts
2. Bootstrap functions → custom variables → Bootstrap variables/maps/mixins
3. Utilities (custom → Bootstrap)
4. Custom mixins
5. Global styles
6. Component styles

### JavaScript Architecture

ES6 modules with explicit imports:
- Bootstrap components imported individually (`Collapse` in `main.js`)
- Custom modules: Extensions (prototype methods), Copyright (year updater), Touchable (touch events)
- No build step - uses native ES modules in browser

## Netlify Configuration

Deployment configured in `netlify.toml`:
- Build command: `yarn deploy && hugo --gc`
- Hugo version: 0.164.0 (pinned; Node 26 via NODE_VERSION and .nvmrc)
- Deploy previews build drafts/future/expired content
- Custom redirects (e.g., `/venmo` → Venmo profile)
- Security headers: CSP, HSTS, nosniff, etc.

## Data Management

Site data stored in YAML files under `data/`:
- Access in templates via `hugo.Data.company` or `hugo.Data.socialMedia`
- Company info includes phone (display + plain formats), email, address
- Centralized data avoids hardcoding in templates

## Important Notes

- **Sass**: Production builds require Dart Sass (auto-installed by `bin/prod`)
- **Images**: Use Hugo's image processing in templates; originals go in `assets/images/`
- **Content**: Markdown files in `content/` are processed by Hugo
- **Linting**: Must pass ESLint (JS) and Stylelint (SCSS) before deployment
- **Bootstrap**: Customizations made via variables, not direct Bootstrap file edits
- **Templates**: Partials are heavily reused; check `layouts/partials/` before creating new ones
