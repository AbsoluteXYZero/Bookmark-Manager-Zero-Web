<div align="center">

<img src="icons/bookmark-96.png" alt="Bookmark Manager Zero Logo" width="128" height="128">

# Bookmark Manager Zero

**A fully static web application for managing bookmarks with GitLab Snippet synchronization.**

<!-- [ZeroLabs] 2026-08-19 7:12 PM - edited: bump badge to 2.0 -->
![Version](https://img.shields.io/badge/version-2.0-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Website](https://img.shields.io/badge/live-website-orange)](https://bmzweb.absolutezero.fyi/)

<br>

**[Launch Website →](https://bmzweb.absolutezero.fyi/)**

</div>

## Overview

Bookmark Manager Zero is a fully static web application for managing bookmarks with GitLab Snippet synchronization. Built from the Bookmark Manager Zero browser extensions, this website provides all the same powerful features without requiring a browser extension installation.

Unlike the browser extensions that work with native browser bookmarks, the website stores your bookmarks in a **private GitLab Snippet** in your own account. This means your data stays under your control, syncs across devices, and can be accessed from any device with a web browser.

Changes sync **bi-directionally and automatically**: edits made on one device automatically appear on all your other devices. Don't worry about accidental changes—the built-in undo feature lets you quickly restore recently deleted bookmarks.

### Why Bookmark Manager Zero Website?

**The only web-based bookmark manager with integrated security scanning and no backend required.**

Other bookmark tools require browser extensions, separate accounts, or self-hosted servers. Bookmark Manager Zero Website is different:

| Feature | Bookmark Manager Zero Website | [Raindrop.io](https://raindrop.io/) | [Pocket](https://getpocket.com/) | [Pinboard](https://pinboard.in/) |
|---------|:-----------------------------:|:------------------:|:--------------:|:----------------:|
| Modern bookmark UI | ✅ | ✅ | ✅ | ❌ |
| No backend required | ✅ | ❌ | ❌ | ❌ |
| Dead link detection | ✅ | ❌ | ❌ | ❌ |
| Parked domain detection | ✅ | ❌ | ❌ | ❌ |
| Multi-source malware scanning | ✅ | ❌ | ❌ | ❌ |
| Safety indicators on bookmarks | ✅ | ❌ | ❌ | ❌ |
| Suspicious pattern detection | ✅ | ❌ | ❌ | ❌ |
| No tracking/analytics | ✅ | ❌ | ❌ | ✅ |
| Website previews | ✅ | ✅ | ✅ | ❌ |
| Free (no premium upsell) | ✅ | ❌ | ❌ | ❌ |
| Works on any device | ✅ | ✅ | ✅ | ✅ |

Stop blindly clicking old bookmarks. Know which links are dead, parked, or potentially dangerous before you visit them.

## Features

### Core Functionality

- **GitLab Snippet Storage** - Store bookmarks in YOUR private GitLab Snippet
- **Auto-Sync with Polling** - Automatic checks every 5 minutes for remote changes
- **Smart Notifications** - Additions auto-sync with toast; deletions require confirmation
- **Change Preview with Diffs** - View detailed line-by-line changes before syncing
- **Edit Lock System** - Prevents concurrent edits across devices with lock notifications
- **Conflict Detection** - Version-based conflict resolution for multi-device safety
- **PAT Authentication** - Secure Personal Access Token authentication for GitLab
- **Modern Material Design UI** - Clean, intuitive interface with multiple themes
- **100% Static** - No backend, hosted entirely on GitLab Pages/Cloudflare Pages
- **Offline Support** - Full offline functionality with IndexedDB caching

### Organization & Search

- **Advanced Search** - Real-time search across titles and URLs
- **Folder Management** - Create, edit, move, and organize folders
- **Smart Filters** - Filter by link status and safety with multi-select support
- **List & Grid Views** - Choose your preferred layout
- **Drag & Drop** - Reorder bookmarks and folders with visual drop indicators
- **Multi-Select Mode** - Bulk operations toolbar with Select All/Deselect All
- **Bulk Operations** - Bulk Recheck security, Bulk Move to folder, Bulk Delete
- **Find Duplicates** - Automatically detect and manage duplicate bookmarks
- **Start Folder** - Set default folder to load on startup
- **Folder State Persistence** - Remembers which folders were expanded

### Link & Safety Checking

- **Link Status Checking** - Automatically detects broken/dead links via HTTP HEAD requests
-️ **Multi-Source Security Scanning** - 6-phase threat detection system with 10 free blocklists + URLVoid
- **Background Scanning** - Web Worker processes scans without blocking UI
- **Safety Indicators** - Visual warnings for suspicious links with detailed tooltips
- **Clickable Status Icons** - Click shield or chain icons for full status details popup
- **HTTP Redirect Detection** - Detects when HTTP bookmarks redirect to HTTPS
- **Whitelist Support** - Mark trusted URLs to skip safety checks
- **Trusted Filter** - Filter to view only whitelisted bookmarks (white shield)
- **Safety History** - Track status changes over time
-️ **Smart Caching** - 7-day cache for scan results to minimize network requests
- **Batch Processing** - Scans bookmarks in batches with rate limiting

### Privacy & Security

- **Token Encryption** - AES-256-GCM encryption with device-specific browser fingerprint keys
- **Encrypted API Keys** - AES-256-GCM encryption for all stored credentials
- **No Tracking** - Zero analytics, no data collection, no external scripts
- **Offline Mode** - Works fully offline when external features disabled
- **Advanced URL Validation** - Blocks dangerous schemes, private IPs, and malformed URLs
- **Strong Content Security Policy** - Prevents XSS attacks and code injection
- **No eval() Policy** - Secure code execution without dynamic evaluation
- **Multiple Storage Layers** - Separate IndexedDB stores for bookmarks, metadata, cache, blocklists, and API keys
-️ **Auto-Clear Cache** - Configurable automatic cache cleanup with TTL management

### User Experience

- **8 Material Design 3 Themes** - Enhanced Blue, Blue Dark, Dark (Pure Black), Light, Enhanced Light, Enhanced Dark, Enhanced Gray, Tinted (dynamic hue/saturation)
- **Tinted Theme Mode** - Dynamic theme with hue slider (0-360°) and saturation control (0-100%)
- **Custom Accent Colors** - Full color picker for theme customization
- **Bookmark Background Opacity** - Adjust bookmark background transparency (0-100%)
- **Custom Text Colors** - Visual color picker for bookmark and folder text colors
- **Advanced Background Customization**:
  - Upload custom background images
  - Background opacity slider (0-100%)
  - Background blur effect (0-20px)
  - Background scale/zoom (10-1000%)
  - Drag to position background
  - Background size presets
- **Font Size Control** - Adjust bookmark text size (70-150%)
- **GUI Scale** - Scale header and toolbar elements (100-200%)
- **Container Opacity** - Adjust background container transparency (0-100%)
- **Mobile Touch Gestures**:
  - Press-and-hold (500ms) to enter move mode
  - Visual drag ghost with item title
  - Drop indicators (before/after/into)
  - Touch toast feedback messages
- **Haptic Feedback** - Vibration on move mode activation and drop completion
- **Full Keyboard Navigation** - Arrow keys, Enter, Escape, Ctrl+K (focus search), Tab trapping in modals
- **Comprehensive Accessibility** - ARIA labels, ARIA roles (menu/toolbar), ARIA states (expanded/pressed), keyboard traps, screen reader support
- **Flexible Zoom Control** - 7 zoom levels from 50% to 200% (50%, 75%, 100%, 125%, 150%, 175%, 200%)
- **Fully Responsive Design** - Auto-wrapping filters, hamburger menus, viewport-aware sizing

### Advanced Features

-️ **Website Previews** - Screenshot thumbnails with lazy loading and low-priority fetch
- **URL Tooltips** - Hover over bookmark title/URL to see full URL
- **Import/Export** - HTML (Netscape format with ADD_DATE) and JSON bookmark files
- **Undo System** - Toast notifications with 10-second countdown timer to restore deletions
- **Changelog with Full Restore** - View complete operation history with restore buttons:
  - Tracks all bookmark operations (add, edit, delete, move, recheck)
  - Restore deleted bookmarks and folders (stores complete data)
  - Restore move operations back to original folder
  - Restore update operations (revert changes)
  - Click URL to copy, "Clear Changelog" to reset history
  - Note: For folders with children, only the folder itself is restored (children tracked separately)
- **Pre-Sync Snapshot Protection** - Automatic snapshots before sync operations with one-click restore to undo mistaken syncs
- **Favicon Display** - Batch-loaded website icons with error handling
- **QR Code Generation** - Generate QR codes from header button or context menu
-️ **Context Menus** - Right-click bookmarks/folders for quick actions
- **Local Mode** - Use app offline without GitLab (local IndexedDB storage only)
- **Display Options Dropdown** - Toggle visibility of titles, URLs, favicons, status indicators, previews

## Installation

### Web Access (Easiest)

Simply visit the live website:

**[https://bmzweb.absolutezero.fyi/](https://bmzweb.absolutezero.fyi/)**

No installation required! The website works entirely in your browser.

### Host Your Own Copy

Feel free to host your own instance. It's easy since it's 100% static

I suggest using GitLab Pages

Or deploy to any static hosting provider (Netlify, Vercel, Cloudflare Pages, etc.):

```bash
git clone https://gitlab.com/AbsoluteXYZero/BMZ-Web.git
cd BMZ
# Deploy the entire directory to your static host
```

## Usage

### Getting Started

Bookmark Manager Zero offers two ways to get started - visit [https://bmzweb.absolutezero.fyi/](https://bmzweb.absolutezero.fyi/) and choose:

#### Option 1: Local Mode (No Account Required)
1. Click **"Use Local Mode"** to work entirely offline
2. Choose to:

   - **Import from File** - Upload HTML/JSON bookmarks
   - **Start Fresh** - Create empty bookmark list
   - **Continue with Existing** - Load previously saved local bookmarks
3. All bookmarks stay on your device with no cloud sync
4. Perfect for privacy-focused users or testing the app

**Want sync later?** Click "Connect GitLab" anytime to add cloud sync without losing bookmarks.

#### Option 2: GitLab Sync Mode (Cross-Device Sync)
1. Create a free [GitLab account](https://gitlab.com) and generate a Personal Access Token (PAT):

   - Scope required: `api`
   - **Important**: PATs display only **once** - copy immediately and save to a password manager
   - Tokens expire based on your chosen expiration date - track this to avoid sync interruptions
2. Paste your token in BMZ (must start with `glpat-` prefix)

   - Token is encrypted with AES-256-GCM before storage
3. Choose existing GitLab Snippet or create new one
4. Start from scratch or import existing bookmarks (HTML/JSON)
5. Your bookmarks sync automatically across all devices via private GitLab Snippets

**Adding Sync to Existing Local Bookmarks**

If you're already using Local Mode and want to add GitLab sync:
1. Click "Connect GitLab" button
2. Enter your GitLab Personal Access Token
3. Choose how to merge your bookmarks:

   - **Create New Snippet** - Upload local bookmarks to new snippet
   - **Merge with Existing Snippet** - Combine local and remote bookmarks
   - **Replace Local with Snippet** - Discard local, use remote bookmarks
     - Safety feature: Option to download backup before replacing
     - Choose "Download Backup & Replace" (recommended) or "Skip Backup & Replace"

**Token Tips**

- Any PAT with `api` scope works as long as your GitLab account is in good standing
- BMZ includes helpful error prompts to guide you if authentication issues occur

### Sync Management

- **Auto-Sync:** Enabled by default, checks Snippet every 5 minutes
  - New bookmarks from other devices auto-sync with notification
  - Deletions require user confirmation (shows "View Changes" button)
  - 5-minute interval helps avoid rate limiting and account flagging
- **Manual Sync:**
  - Click "Push to Snippet" to upload local changes
  - Click "Pull from Snippet" to download remote changes
  - **Shift+Click Sync Button** - Force push local to remote (overwrite)
- **Change Preview:** Click "View Changes" to see detailed line-by-line diff before syncing
- **Edit Lock System:**
  - Prevents concurrent edits across devices
  - Shows notification when another device is editing
  - Auto-releases locks after timeout
- **GitLab Error Handling:**
  - 401 Unauthorized - Token expired/invalid
  - 403 Forbidden - Permission errors with user-friendly messages
  - 429 Rate Limited - Automatic retry with exponential backoff
  - 500+ Server Errors - Retry logic with user notifications

### Search & Filter

- **Search:** Type in the search bar to filter by title/URL
- **Filter by Status:** Click the filter icon to show filters:
  - **Link Status:** Live, Parked, Dead
  - **Safety Status:** Safe, Suspicious, Unsafe, Trusted (whitelisted)
- **Multiple Filters:** Select multiple filters simultaneously
  - Filters in the same category use OR logic (e.g., Live + Dead shows both)
  - Filters across categories use AND logic (e.g., Live + Safe shows only live AND safe bookmarks)

### Import/Export

- **Import Bookmarks:**
  - Settings → Import Bookmarks
  - Supports HTML (Netscape format) and JSON
  - Works with exports from Chrome, Firefox, Edge, Safari
- **Export Bookmarks:**
  - Settings → Export Bookmarks
  - Choose HTML (cross-browser) or JSON (GitLab Snippet format)

### Mobile Support

- **Touch Gestures:** Press and hold (500ms) on bookmarks to enter move mode
- **Hamburger Menus:** Always accessible on mobile
- **Responsive Design:** Adapts to screen size with 44x44px touch targets
- **Haptic Feedback:** On supported devices

Click the **theme icon** to access:

- **Theme Selector:** Choose from 8 themes
  - Enhanced Blue (default)
  - Blue Dark
  - Dark (Pure Black OLED)
  - Light
  - Enhanced Light
  - Enhanced Dark
  - Enhanced Gray
  - Tinted (dynamic with hue/saturation sliders)
- **Tinted Theme Controls:**
  - Hue slider (0-360°)
  - Saturation slider (0-100%)
- **Accent Color:** Full color picker for custom accent
- **Text Color:** Customize bookmark and folder text colors
- **Background Customization:**
  - Upload custom background image
  - Background opacity (0-100%)
  - Background blur (0-20px)
  - Background scale/zoom (10-1000%)
  - Drag to position
  - Size presets
- **Bookmark Opacity:** Bookmark background transparency (0-100%)
- **Container Opacity:** Background container transparency (0-100%)
- **Font Size:** Bookmark text size (70-150%)
- **GUI Scale:** Header/toolbar scale (100-200%)
- **Zoom:** Bookmark content zoom (50%, 75%, 100%, 125%, 150%, 175%, 200%)

### Keyboard Navigation (when bookmark/folder selected)

- `↑` / `↓` - Navigate up/down through bookmarks and folders
- `←` - Collapse folder
- `→` - Expand folder
- `Enter` - Open selected bookmark or toggle folder expansion
- `Escape` - Clear selection

## Privacy

Bookmark Manager Zero respects your privacy:

- **All data stored in YOUR GitLab Snippet** - Bookmarks stored in your own private GitLab Snippet (website owner cannot access your data)
- **Tokens encrypted in browser** - AES-256-GCM encryption with browser fingerprint-derived key
- **No tracking or analytics**
- **No advertisements**
- **Open source** - audit the code yourself

See [PRIVACY.md](PRIVACY.md) for complete privacy policy.

## External Services (Optional)

The website can optionally use external services for enhanced features. **All can be disabled in settings:**

### Default Services (can be disabled)

- **WordPress mshots** - Website screenshot previews via `https://s0.wp.com/mshots/v1/`
- **Google Favicons** - Website icons via `https://www.google.com/s2/favicons`
- **URLVoid Scanning** - Multi-engine reputation check via `https://www.urlvoid.com/` (uses CORS proxy, no API key required)
- **10 Free Blocklist Sources** - Community-maintained threat databases (~1.36M domains):
  - URLhaus Active (abuse.ch) - ~107K actively distributing malware
  - URLhaus Historical (CDN mirror) - ~37K historical threats
  - BlockList Project Malware - ~300K malware domains
  - BlockList Project Phishing - ~214K phishing sites
  - BlockList Project Scam - ~112K scam websites
  - HaGeZi TIF - ~608K comprehensive threat intel
  - Phishing-Filter - ~21K aggregated phishing database
  - OISD Big - ~215K multi-source blocklist aggregator
  - FMHY Filterlist - ~282 curated unsafe sites (fake activators, malware distributors)
  - Dandelion Sprout Anti-Malware - ~5K curated malware, scam, and phishing domains

### User-Configured Services (require API keys)

- **Google Safe Browsing API** - Additional malware/phishing protection
  - Rate Limit: 10,000 requests/day (free tier)
  - Coverage: Malware, Social Engineering, Unwanted Software
- **Yandex Safe Browsing API** - Geographic threat diversity
  - Rate Limit: 100,000 requests/day (free tier)
  - Coverage: Russian and Eastern European threats
- **VirusTotal API** - Multi-engine comprehensive scanning
  - Rate Limit: 500 requests/day (free tier)
  - Coverage: 70+ antivirus engines (2+ flags → Unsafe)

### Git Provider Services (GitLab Sync)

**GitLab:**

- **GitLab Snippets API** - Stores your bookmarks in a private Snippet
- **GitLab Personal Access Token** - Simple token-based authentication
- Required scope: `api` (full API access for snippet operations)
- Tokens encrypted with AES-256-GCM before storage
- Auto-detected from `glpat-` prefix

All external service usage is disclosed in [PRIVACY.md](PRIVACY.md).

## Important Notice: GitLab API Usage

**User Responsibility:**

- You are responsible for your own GitLab API usage when using this application
- The application makes API calls only when you perform sync operations (manual sync or when you add/edit/delete bookmarks)
- Monitor your API usage through your GitLab account settings if needed

**How GitLab Snippets Are Used:**

- This application uses GitLab Snippets as intended by GitLab: for storing structured data
- Your bookmarks are stored in a private Snippet in your own GitLab account
- Snippets are a legitimate GitLab feature designed for storing code, configuration, and structured data
- The application uses standard GitLab Snippets API endpoints documented in the official GitLab API

**API Usage Considerations:**

- **Event-driven sync**: API calls are made when you add/edit/delete bookmarks
- **Auto-sync polling**: When enabled, checks for remote changes every 5 minutes
- **Manual sync**: Use the "Pull from Snippet" and "Push to Snippet" buttons for manual control
- **Rate limiting protection**: Built-in exponential backoff with jitter respects GitLab API limits
- **Rate limits**: GitLab has API rate limits; typical bookmark usage stays well within limits

**Best Practices:**

- Use manual "Pull from Snippet" to check for changes from other devices when needed
- The application automatically syncs when you make changes (add/edit/delete bookmarks)
- For very large collections (>5000 bookmarks), edits will naturally sync less frequently

## How Link & Safety Checking Works

This section provides technical details on how the website determines link status and safety for anyone interested in the methodology.

### Link Status Checking

The website checks if bookmark URLs are still accessible and categorizes them as **Live**, **Dead**, or **Parked**.

#### Detection Method

1. **Initial Domain Check**: The URL's domain is first checked against a list of 22+ known domain parking services:

   - **Registrars**: HugeDomains, GoDaddy, Namecheap, NameSilo, Porkbun, Dynadot, Epik
   - **Marketplaces**: Sedo, Dan.com, Afternic, DomainMarket, Squadhelp, BrandBucket, Undeveloped, Atom
   - **Parking Services**: Bodis, ParkingCrew, Above.com, SedoParking

2. **HTTP HEAD Request**: A lightweight HEAD request is sent (10-second timeout)

   - No page content is downloaded
   - Credentials are omitted for privacy

3. **Response Interpretation**:

   - **Successful response** → Live
   - **Domain matches parking list** → Parked
   - **Timeout/Network Error** → Dead

#### Performance & Rate Limiting

**Optimized Batch Processing:**

- Bookmarks are scanned in batches of 10 with a 100ms delay between batches
- Web Worker isolates scanning from UI thread for non-blocking performance
- Parallel link and safety checks for faster scanning per bookmark

**Smart Timeout Strategy:**

- Link checks: 5s timeout (HEAD request), 5s timeout (GET fallback)
- URLVoid checks: 5s timeout (down from 15s)
- VirusTotal checks: 8s timeout (down from 15s)
- Timeout handling: Sites that timeout are marked as 'live' (slow server) instead of 'dead'
- No redundant GET fallback on timeout - saves up to 5s per slow site

**Network Protection:**

- 100ms delay between batches prevents DNS overload and router disruption
- Web Worker prevents UI blocking during intensive scanning operations
- Background thread handles all network requests independently

**Expected Performance:**

- Approximately 30-50 bookmarks per second throughput
- 1,000 bookmarks: ~30-60 seconds
- 5,000 bookmarks: ~2-5 minutes
- Performance varies based on network speed and server response times

**Why These Settings:**

- Batch size of 10: Sweet spot between speed and network stability
- 100ms batch delay: Minimal pause that prevents request spikes
- 5s timeouts: Aggressive but appropriate since timeouts are marked as 'live' not 'dead'
- Web Worker: Offloads all scanning to background thread for smooth UI experience

#### Caching
Results are cached locally in IndexedDB for 7 days to minimize network requests.

---

### Safety Checking

The website checks URLs against multiple threat databases to identify malicious, phishing, or scam websites.

#### Phase 1: Blocklist Lookup (Free, No API Key Required)

URLs are checked against ten community-maintained blocklists with dual URLhaus coverage:

| Source | Type | Description | Entries |
|--------|------|-------------|---------|
| **[URLhaus (Active)](https://urlhaus.abuse.ch/)** | Malware URLs | Official abuse.ch list - actively distributing malware | ~107K |
| **[URLhaus (Historical)](https://urlhaus.abuse.ch/)** | Malware Domains | Historical threats via CDN mirror | ~37K |
| **[BlockList Project - Malware](https://github.com/blocklistproject/Lists)** | Malware Domains | Community-maintained malware domain list | ~300K |
| **[BlockList Project - Phishing](https://github.com/blocklistproject/Lists)** | Phishing Domains | Known phishing sites | ~214K |
| **[BlockList Project - Scam](https://github.com/blocklistproject/Lists)** | Scam Domains | Known scam websites | ~112K |
| **[HaGeZi TIF](https://github.com/hagezi/dns-blocklists)** | Threat Intel Feeds | Comprehensive malware, phishing, and scam domains | 608K |
| **[Phishing-Filter](https://gitlab.com/malware-filter/phishing-filter)** | Phishing URLs | Aggregated phishing database | ~21K |
| **[OISD Big](https://oisd.nl/)** | Multi-source | Comprehensive blocklist aggregator | ~215K |
| **[FMHY Filterlist](https://github.com/fmhy/FMHYFilterlist)** | Unsafe Sites | Fake activators, malware distributors, unsafe download sites | ~282 |
| **[Dandelion Sprout Anti-Malware](https://github.com/DandelionSprout/adfilt)** | Anti-Malware | Curated malware, scam, and phishing domains | ~5K |

**Total Coverage**: **~1.36M unique malicious domains** after deduplication

**Implementation Details:**

- Blocklists are downloaded and cached locally in IndexedDB
- Updated every 24 hours automatically
- Both full URLs and domain combinations are checked
- **Any match → Unsafe** (tooltip shows all sources that flagged it)

#### Phase 2: Google Safe Browsing (Optional, Requires API Key)

If configured, URLs are checked against Google's threat database:

- **Threat Types**: Malware, Social Engineering, Unwanted Software
- **Rate Limit**: 10,000 requests/day (free tier)

#### Phase 3: Yandex Safe Browsing (Optional, Requires API Key)

If configured, provides geographic threat diversity:

- **Coverage**: Russian and Eastern European threats
- **Rate Limit**: 100,000 requests/day (free tier)

#### Phase 4: URLVoid Scanning (Integrated, No API Key Required)

All URLs are checked against URLVoid's reputation database:

- **Multi-Engine Check**: Aggregates results from multiple security engines
- **Detection Threshold**:
  - 2+ engines flag as malicious → Unsafe
  - 1 engine flags → Warning
  - No flags → Safe
- **No Rate Limits**

#### Phase 5: VirusTotal (Optional, Requires API Key)

If configured, URLs are submitted to VirusTotal's multi-engine scanner:

- 70+ antivirus engines analyze the URL
- **2+ engines flag as malicious → Unsafe**
- **Rate Limit**: 500 requests/day (free tier)

#### Phase 6: Suspicious Pattern Detection

The URL is analyzed for suspicious patterns:

| Pattern | Detection | Result |
|---------|-----------|--------|
| **HTTP Only (Unencrypted)** | URL uses `http://` without HTTPS | Warning |
| **URL Shortener** | Domain is bit.ly, tinyurl.com, etc. (18+ services) | Warning |
| **Suspicious TLD** | Domain ends in .xyz, .top, .tk, etc. (30+ TLDs) | Warning |
| **IP Address** | URL uses IP address instead of domain name | Warning |

#### Final Status Determination

| Check Result | Final Status | Priority |
|--------------|--------------|----------|
| Blocklist match | **Unsafe** (red shield) | Highest |
| Google/Yandex/URLVoid/VirusTotal match | **Unsafe** (red shield) | Highest |
| Suspicious patterns found | **Warning** (yellow shield) | Medium |
| All checks pass | **Safe** (green shield) | Normal |

#### Caching & Privacy

- All results are cached locally for 7 days
- Only URLs are sent to external services (no personal data)
- API keys are encrypted with AES-256-GCM before storage
- All features can be disabled in settings

---

### Whitelisting

Users can whitelist specific URLs to:

- Skip safety checks for trusted sites
- Override false positives
- Whitelisted bookmarks display a white shield indicator
- Add/remove from whitelist via bookmark context menu (right-click)
- Use the "Trusted" filter to view all whitelisted bookmarks

## Technology Stack

### Core Technologies

- **Language**: Vanilla JavaScript (ES6 modules) - Zero framework dependencies
- **Architecture**: Single-page application with modular ES6 imports
- **Module System**: 24+ ES6 modules organized by feature (core, auth, storage, import-export, utils)
- **Storage**: Dual-layer storage with GitLab Snippets API + IndexedDB
- **Authentication**: Personal Access Token (PAT) with `glpat-` auto-detection
- **Hosting**: 100% static - GitLab Pages, Cloudflare Pages, or any static host
- **Security**: AES-256-GCM encryption with Web Crypto API
- **UI Framework**: Material Design 3 color system
- **Layout**: CSS Grid & Flexbox with CSS custom properties
- **Web Workers**: Background thread for non-blocking link/safety scanning

### IndexedDB Architecture

Multiple object stores for organized data:

- **bookmarks** - Hierarchical bookmark tree structure
- **metadata** - Sync status, snippet IDs, edit locks, version tracking
- **cache** - Link/safety status with 7-day TTL
- **blocklists** - 10 malware/phishing domain lists (~1.36M domains)
- **apiKeys** - Encrypted API credentials for external services

### Security Implementation

- **Web Crypto API** - AES-256-GCM encryption
- **SHA-256 Hashing** - Browser fingerprint-based key derivation
- **Browser Fingerprinting** - Device-specific encryption keys
- **Content Security Policy** - Strong CSP headers prevent XSS
- **Input Sanitization** - URL validation, private IP blocking, scheme filtering
- **No eval()** - No dynamic code execution
- **HTTPS-only** - All external requests use HTTPS

### Project Architecture

```
Bookmark-Manager-Zero-Website/
├── index.html                    # Main entry point (138KB with embedded styles)
├── css/
│   └── themes.css               # Material Design 3 theme definitions
├── js/
│   ├── core/                    # Core application logic
│   │   ├── app.js              # Main initialization & lifecycle
│   │   ├── bookmarks.js        # Bookmark tree operations
│   │   ├── ui.js               # UI rendering & interactions
│   │   ├── scanner.js          # Link/safety scan coordinator
│   │   ├── blocklist-service.js # Malware database management
│   │   └── sync-timer.js       # Auto-sync polling manager
│   ├── auth/                    # Authentication
│   │   ├── auth-manager.js     # Token encryption/decryption
│   │   └── oauth-pat.js        # GitLab PAT authentication
│   ├── storage/                 # Data persistence
│   │   ├── indexeddb.js        # IndexedDB wrapper
│   │   ├── sync-manager.js     # Bidirectional GitLab sync
│   │   ├── snippet-adapter.js  # GitLab Snippets API client
│   │   └── storage-adapter.js  # Storage interface
│   ├── import-export/           # Bookmark import/export
│   │   ├── html-exporter.js    # Netscape HTML export
│   │   ├── html-parser.js      # Netscape HTML import
│   │   ├── json-exporter.js    # JSON backup export
│   │   └── json-parser.js      # JSON import
│   ├── utils/                   # Utilities
│   │   ├── encryption.js       # AES-256-GCM crypto
│   │   ├── theme-settings-manager.js # Theme preferences
│   │   ├── error-notification-manager.js # Error toasts
│   │   ├── gitlab-error-handler.js # API error handling
│   │   └── storage-utils.js    # Storage helpers
│   ├── mobile/
│   │   └── touch-handler.js    # Touch gestures & mobile support
│   └── lib/
│       └── qrcode-lib.js       # QR code generation
├── workers/
│   └── scanner-worker.js        # Background scanning (26KB)
└── icons/                       # Favicon assets
```

**Total**: 24 JavaScript modules, 100% vanilla ES6

## Security

### Security Features

- **Strong Content Security Policy (CSP)** - Prevents XSS attacks and code injection
- **AES-256-GCM Encryption** - Military-grade encryption for GitLab tokens and API keys
- **Browser Fingerprint-Derived Keys** - Device-specific encryption keys using SHA-256
- **Web Crypto API** - Native browser cryptography (no external crypto libraries)
- **No eval() Policy** - Zero dynamic code execution
- **No Inline Scripts** - All JavaScript in external modules
- **HTTPS-Only Requests** - All external API calls use encrypted connections
- **Input Validation** - Comprehensive URL and data validation
- **XSS Protection** - Input sanitization prevents script injection
- **Dangerous Scheme Blocking** - Blocks javascript:, data:, file:, and other dangerous URL schemes
- **Private IP Blocking** - Prevents access to local network resources (localhost, 192.168.x.x, 10.x.x.x, etc.)
- **Rate Limiting Protection** - Exponential backoff with jitter for GitLab API calls
- **Secure Storage** - Multiple IndexedDB stores with encrypted sensitive data
- **No External Dependencies** - Zero npm packages means zero supply chain vulnerabilities

### Reporting Security Issues
Please report security vulnerabilities via GitLab Issues (mark as security issue).

## Browser Compatibility

- **Chrome:** ✅ Fully supported
- **Firefox:** ✅ Fully supported
- **Edge:** ✅ Should work (untested but Chromium-based)
- **Safari:** ✅ Should work (untested)
- **Mobile Browsers:** ✅ Full touch support

## Performance & Technical Details

### Performance Optimizations

- **Web Worker Scanning** - Link and safety checks run in background thread without blocking UI
- **Batch Processing** - Scans bookmarks in batches with configurable delays to prevent network overload
- **Smart Caching** - 7-day TTL on scan results reduces redundant network requests
- **Incremental Rendering** - UI renders progressively for large bookmark collections
- **Rate Limiting** - Exponential backoff with jitter prevents API throttling
- **IndexedDB Indexing** - Fast lookups for bookmarks, cache, and blocklists
- **Lazy Loading** - External resources loaded only when needed
- **Minimal Reflows** - Efficient DOM manipulation minimizes layout thrashing

### Scalability

- **Large Collections** - Tested with 2,000+ bookmarks
- **Efficient Storage** - IndexedDB handles millions of cached entries
- **Blocklist Performance** - 1.35M domain lookups via indexed hash tables
- **Memory Management** - Automatic garbage collection of expired cache entries

## Developer Information

### For Developers & Contributors

**No Build Process** - This is intentional! The project uses vanilla JavaScript to:

- Eliminate build tool dependencies and complexity
- Enable instant local development (just open in browser)
- Reduce security surface area (no npm supply chain attacks)
- Ensure long-term maintainability (no framework churn)

### Key Implementation Details

**Encryption Key Derivation:**
```javascript
// Browser fingerprint components: userAgent, language, hardwareConcurrency,
// screen dimensions, timezone, and more
const fingerprint = await generateBrowserFingerprint();
const key = await crypto.subtle.importKey(/* SHA-256 hash of fingerprint */);
```

**Bookmark Tree Structure:**
```javascript
{
  id: "unique-id",
  title: "Bookmark Title",
  url: "https://example.com",
  type: "bookmark" | "folder",
  children: [], // For folders
  dateAdded: 1234567890000,
  linkStatus: "live" | "dead" | "parked",
  safetyStatus: "safe" | "warning" | "unsafe" | "trusted"
}
```

**IndexedDB Schema Version:** 1 (with migration support for future versions)

## Related Projects

- [Bookmark Manager Zero - Firefox](https://gitlab.com/AbsoluteXYZero/BMZ-Firefox)
- [Bookmark Manager Zero - Chrome](https://gitlab.com/AbsoluteXYZero/BMZ-Chrome)
- [Bookmark Manager Zero - Main](https://gitlab.com/AbsoluteXYZero/BMZ)

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues:** [GitLab Issues](https://gitlab.com/AbsoluteXYZero/BMZ-Web/-/issues)
- **Source Code:** [GitLab Repository](https://gitlab.com/AbsoluteXYZero/BMZ-Web/)
- **Firefox Extension:** [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/bookmark-manager-zero/)
- **Chrome Extension:** [Chrome Web Store](https://chromewebstore.google.com/detail/bookmark-manager-zero/jbpiddimkkdfhoellbiegdopfpilnclc)
- **Buy Me a Coffee:** [Support Development](https://buymeacoffee.com/absolutexyzero)

## Acknowledgments

### Design & Platform

- **Material Design 3** - Color system by Google
- **GitLab Pages** - Free static hosting
- **Cloudflare Pages** - Free static hosting
- **GitLab Snippets** - Simple, private data storage

### Security & Malware Detection

- **[URLhaus](https://urlhaus.abuse.ch/)** - Dual coverage: Active + Historical malware URLs
- **[BlockList Project](https://github.com/blocklistproject/Lists)** - Community-maintained blocklists (626K+ entries)
- **[HaGeZi TIF](https://github.com/hagezi/dns-blocklists)** - Threat Intelligence Feeds (608K entries)
- **[Phishing-Filter](https://gitlab.com/malware-filter/phishing-filter)** - Phishing database (~21K entries)
- **[OISD Big](https://oisd.nl/)** - Comprehensive blocklist aggregator (~215K entries)
- **[FMHY Filterlist](https://github.com/fmhy/FMHYFilterlist)** - Curated unsafe sites list (~282 entries)
- **[Dandelion Sprout Anti-Malware](https://github.com/DandelionSprout/adfilt)** - Curated anti-malware list (~5K entries)
- **[URLVoid](https://www.urlvoid.com/)** - Multi-engine reputation checking service
- **[Google Safe Browsing API](https://developers.google.com/safe-browsing)** - Optional threat intelligence
- **[Yandex Safe Browsing](https://yandex.com/dev/safebrowsing/)** - Optional geographic threat diversity
- **[VirusTotal](https://www.virustotal.com/)** - Optional multi-engine scanning (70+ AV engines)

### Services

- **WordPress mShots** - Website screenshot preview service
- **Google Favicons** - Website icon servicer

Special thanks to the security research community for maintaining free, public malware databases that help keep users safe.

---

**Made with ❤️ for anyone who loves organized bookmarks**
