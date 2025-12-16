<div align="center">

<img src="icons/bookmark-96.png" alt="Bookmark Manager Zero Logo" width="128" height="128">

# Bookmark Manager Zero

**A fully static web application for managing bookmarks with GitHub Gist or GitLab Snippet synchronization.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Website](https://img.shields.io/badge/live-website-orange)](https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/)

<br>

**[Launch Website →](https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/)**

</div>

## Overview

Bookmark Manager Zero is a fully static web application for managing bookmarks with GitHub Gist or GitLab Snippet synchronization. Built from the Bookmark Manager Zero browser extensions, this website provides all the same powerful features without requiring a browser extension installation.

Unlike the browser extensions that work with native browser bookmarks, the website stores your bookmarks in a **private GitHub Gist or GitLab Snippet** in your own account. This means your data stays under your control, syncs across devices, and can be accessed from any device with a web browser—with your choice of Git provider.

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
- ✅ **Dual Storage Options** - Choose GitHub Gist or GitLab Snippet storage (your data, your provider)
- ✅ **GitHub Gist Support** - Store bookmarks in YOUR private GitHub Gist
- ✅ **GitLab Snippet Support** - Alternative storage via YOUR private GitLab Snippet
- ✅ **Auto-Sync** - Automatic polling every 60 seconds checks for remote changes
- ✅ **Smart Notifications** - Additions auto-sync with toast; deletions require confirmation
- ✅ **Change Preview** - "View Changes" button shows detailed diff before syncing
- ✅ **PAT Authentication** - Secure Personal Access Token authentication for both GitHub and GitLab
- ✅ **Modern Material Design UI** - Clean, intuitive interface with multiple themes
- ✅ **100% Static** - No backend, hosted entirely on GitHub Pages
- ✅ **Offline Support** - Works offline with IndexedDB caching

### Organization & Search
- 🔍 **Advanced Search** - Real-time search across titles and URLs
- 📁 **Folder Management** - Create, edit, move, and organize folders
- 🏷️ **Smart Filters** - Filter by link status and safety with multi-select support
- 📊 **List & Grid Views** - Choose your preferred layout
- 🔄 **Drag & Drop** - Reorder bookmarks and folders

### Link & Safety Checking
- 🔗 **Link Status Checking** - Automatically detects broken/dead links
- 🛡️ **Security Scanning** - Checks URLs against malware databases
- ⚠️ **Safety Indicators** - Visual warnings for suspicious links with detailed tooltips
- 👆 **Clickable Status Icons** - Click shield or chain icons for full status details popup
- 🔄 **HTTP Redirect Detection** - Detects when HTTP bookmarks redirect to HTTPS
- ✅ **Whitelist Support** - Mark trusted URLs to skip safety checks
- ⚪ **Trusted Filter** - Filter to view only whitelisted bookmarks (white shield)
- 📜 **Safety History** - Track status changes over time

### Privacy & Security
- 🔐 **Token Encryption** - AES-256-GCM encryption with browser fingerprint-derived key
- 🔒 **Encrypted API Keys** - AES-256-GCM encryption for stored credentials
- 🚫 **No Tracking** - Zero analytics, no data collection
- 🌐 **Offline Mode** - Works fully offline when external features disabled
- 🔒 **URL Validation** - Block dangerous schemes and private IPs
- 🗑️ **Auto-Clear Cache** - Configurable automatic cache cleanup

### User Experience
- 🎨 **8 Themes** - Material Design 3 themes with custom accent colors
- 🎨 **Custom Accent Colors** - Pick any color for theme customization
- 🎨 **Bookmark Background Opacity** - Adjust bookmark background transparency (0-100%)
- ✍️ **Custom Text Colors** - Visual color picker for bookmark and folder text
- 🖼️ **Custom Backgrounds** - Upload and position your own background images
- 📱 **Mobile-Friendly** - Full touch support with press-and-hold gestures (500ms)
- ⌨️ **Keyboard Navigation** - Full keyboard support with arrow keys
- ♿ **Accessibility** - Comprehensive ARIA labels and keyboard traps
- 🔍 **Zoom Control** - 50% - 200% zoom levels for bookmark content
- 📱 **Responsive Design** - Adapts to viewport width with auto-wrapping filters

### Advanced Features
- 🖼️ **Website Previews** - Screenshot thumbnails of bookmarks
- 💬 **URL Tooltips** - Hover over bookmark title/URL to see full URL
- 📤 **Import/Export** - HTML (Netscape format) and JSON bookmark files
- 🔄 **Bulk Operations** - Multi-select mode for batch editing/deletion
- ⏮️ **Undo System** - Restore recently deleted bookmarks
- 🌍 **Favicon Display** - Show website icons

## Installation

### Web Access (Easiest)

Simply visit the live website:

**[https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/](https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/)**

No installation required! The website works entirely in your browser.

### Host Your Own Copy

Want to host your own instance? It's easy since it's 100% static:

1. Fork this repository
2. Enable GitHub Pages in Settings → Pages → Source: main branch
3. Visit `https://[your-username].github.io/Bookmark-Manager-Zero-Website/`

Or deploy to any static hosting provider (Netlify, Vercel, Cloudflare Pages, etc.):

```bash
git clone https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website.git
cd Bookmark-Manager-Zero-Website
# Deploy the entire directory to your static host
```

### Local Development

Run locally with Python or any HTTP server:

```bash
git clone https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website.git
cd Bookmark-Manager-Zero-Website
python -m http.server 8000
# Visit http://localhost:8000
```

## Usage

### First-Time Setup

1. **Visit the website** at [https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/](https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/)
2. **Choose your storage provider** (GitHub or GitLab):

   **Option A: GitHub Gist**
   - Click the gear icon (Settings)
   - Go to "GitHub Gist Sync" section
   - Generate a Personal Access Token at GitHub (scope: `gist`)
   - Paste your token to authenticate
   - Token is automatically detected as GitHub based on `ghp_` or `github_pat_` prefix
   - Token is encrypted with AES-256-GCM before storage
   - Create a new Gist or select an existing Gist from the dropdown

   **Option B: GitLab Snippet**
   - Click the gear icon (Settings)
   - Go to "GitLab Snippet Sync" section
   - Generate a Personal Access Token at GitLab (scope: `api`)
   - Paste your token to authenticate
   - Token is automatically detected as GitLab based on `glpat-` prefix
   - Token is encrypted with AES-256-GCM before storage
   - Create a new Snippet or select an existing Snippet from the dropdown

3. **Start managing bookmarks!**

### Basic Usage

- **Add Bookmark:** Click the "+" button in the header
- **Edit Bookmark:** Right-click → Edit
- **Delete Bookmark:** Right-click → Delete (with undo support)
- **Move Bookmark:** Drag and drop to a different folder
- **Create Folder:** Click the folder icon in the header
- **Search:** Type in the search bar to filter by title/URL

### Sync Management

- **Auto-Sync:** Enabled by default, checks Gist/Snippet every 60 seconds
  - New bookmarks from other devices auto-sync with notification
  - Deletions require user confirmation (shows "View Changes" button)
  - Works with both GitHub Gists and GitLab Snippets
- **Manual Sync:**
  - Click "Push to Gist/Snippet" to upload local changes
  - Click "Pull from Gist/Snippet" to download remote changes
- **Change Preview:** Click "View Changes" to see detailed diff before syncing
- **Edit Lock Notifications:** See when another device is editing
- **Switch Providers:** Can switch between GitHub and GitLab at any time in settings

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
  - Choose HTML (cross-browser) or JSON (GitHub Gist format)

### Mobile Support

- **Touch Gestures:** Press and hold (500ms) on bookmarks to enter move mode
- **Hamburger Menus:** Always accessible on mobile
- **Responsive Design:** Adapts to screen size with 44x44px touch targets
- **Haptic Feedback:** On supported devices

### Settings

Click the gear icon to access:
- **Storage Provider Selection:** Choose GitHub Gist or GitLab Snippet (auto-detected from token)
- **GitHub Gist Sync:** Authenticate with Personal Access Token, create/select Gist, auto-sync settings
- **GitLab Snippet Sync:** Authenticate with Personal Access Token, create/select Snippet, auto-sync settings
- **Display Options:** Toggle title, URL, status indicators, previews
- **View Mode:** Switch between list and grid layouts
- **Cache Management:** Configure auto-clear settings
- **API Keys:** Set up optional security API keys (Google Safe Browsing, Yandex, VirusTotal)
- **Import/Export:** Import HTML/JSON bookmarks, export to HTML/JSON

Click the theme icon to access:
- **Theme:** Choose from 8 themes
- **Accent Color:** Customize theme accent color
- **Bookmark Opacity:** Adjust bookmark background transparency (0-100%)
- **Text Color:** Customize bookmark text color with visual color picker
- **Custom Background:** Upload and position your own background image
- **Zoom:** Adjust bookmark content size (50% - 200%)

### Keyboard Shortcuts

#### Navigation (when item selected)
- `↑/↓` - Navigate bookmarks
- `←/→` - Collapse/expand folders
- `Enter` - Open bookmark or toggle folder
- `Escape` - Clear selection

## Privacy

Bookmark Manager Zero respects your privacy:

- **All data stored in YOUR Git provider** - Bookmarks stored in your own GitHub Gist or GitLab Snippet (website owner cannot access your data)
- **Tokens encrypted in browser** - AES-256-GCM encryption with browser fingerprint-derived key
- **No tracking or analytics**
- **No advertisements**
- **Open source** - audit the code yourself
- **Provider choice** - Choose the Git platform you trust

See [PRIVACY.md](PRIVACY.md) for complete privacy policy.

## External Services (Optional)

The website can optionally use external services for enhanced features. **All can be disabled in settings:**

### Default Services (can be disabled)
- **WordPress mshots** - Website screenshot previews
- **8 Blocklist Sources** - Dual URLhaus coverage (Active + Historical), BlockList Project (Malware/Phishing/Scam), HaGeZi TIF, Phishing-Filter, OISD Big
- **Google Favicons** - Website icons

### User-Configured Services (require API keys)
- **Google Safe Browsing** - Additional malware protection (10K requests/day free)
- **Yandex Safe Browsing** - Geographic threat diversity (100K requests/day free)
- **VirusTotal** - Comprehensive threat scanning from 70+ AV engines (500 requests/day free)

### Git Provider Services (choose one for sync)

**GitHub (Option A):**
- **GitHub Gists API** - Stores your bookmarks in a private Gist
- **GitHub Personal Access Token** - Simple token-based authentication
- Required scope: `gist` (full control of gists)
- Tokens encrypted with AES-256-GCM before storage
- Auto-detected from `ghp_` or `github_pat_` prefix

**GitLab (Option B):**
- **GitLab Snippets API** - Stores your bookmarks in a private Snippet
- **GitLab Personal Access Token** - Simple token-based authentication
- Required scope: `api` (full API access for snippet operations)
- Tokens encrypted with AES-256-GCM before storage
- Auto-detected from `glpat-` prefix

All external service usage is disclosed in [PRIVACY.md](PRIVACY.md).

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

#### Rate Limiting
Bookmarks are scanned in batches with delays to prevent overwhelming your network.

#### Caching
Results are cached locally for 7 days to minimize network requests.

---

### Safety Checking

The website checks URLs against multiple threat databases to identify malicious, phishing, or scam websites.

#### Phase 1: Blocklist Lookup (Free, No API Key Required)

URLs are checked against eight community-maintained blocklists with dual URLhaus coverage:

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

**Total Coverage**: **~1.35M unique malicious domains** after deduplication

**Implementation Details:**
- Blocklists are downloaded and cached locally in IndexedDB
- Updated every 24 hours automatically
- Both full URLs and domain combinations are checked
- **Any match → Unsafe** (tooltip shows all sources that flagged it)

#### Phase 2: Google Safe Browsing (Optional, Requires Free API Key)

If configured, URLs are checked against Google's threat database:
- **Threat Types**: Malware, Social Engineering, Unwanted Software
- **Rate Limit**: 10,000 requests/day (free tier)

#### Phase 3: Yandex Safe Browsing (Optional, Requires Free API Key)

If configured, provides geographic threat diversity:
- **Coverage**: Russian and Eastern European threats
- **Rate Limit**: 100,000 requests/day (free tier)

#### Phase 4: VirusTotal (Optional, Requires Free API Key)

If configured, URLs are submitted to VirusTotal's multi-engine scanner:
- 70+ antivirus engines analyze the URL
- **2+ engines flag as malicious → Unsafe**
- **Rate Limit**: 500 requests/day (free tier)

#### Phase 5: Suspicious Pattern Detection

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
| Google/Yandex/VirusTotal match | **Unsafe** (red shield) | Highest |
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

- **Frontend**: Vanilla JavaScript (no frameworks)
- **Storage**: GitHub Gists API / GitLab Snippets API + IndexedDB
- **Authentication**: Personal Access Token (PAT) with auto-detection (GitHub/GitLab)
- **Hosting**: GitHub Pages
- **Security**: AES-256-GCM encryption for tokens and API keys
- **UI**: Material Design 3 color system, CSS Grid & Flexbox

## Development

### Project Structure
```
├── index.html                    # Main UI
├── js/
│   ├── core/
│   │   ├── app.js               # Application initialization
│   │   ├── bookmarks.js         # Bookmark management logic
│   │   ├── scanner.js           # Link and safety scanning
│   │   └── ui.js                # UI components and interactions
│   ├── storage/
│   │   ├── indexeddb.js         # Local IndexedDB storage
│   │   ├── gist-adapter.js      # GitHub Gist sync adapter
│   │   ├── snippet-adapter.js   # GitLab Snippet sync adapter
│   │   └── sync-manager.js      # Multi-device sync management
│   ├── import-export/
│   │   ├── html-parser.js       # HTML bookmark import
│   │   ├── json-parser.js       # JSON bookmark import
│   │   ├── html-exporter.js     # HTML bookmark export
│   │   └── json-exporter.js     # JSON bookmark export
│   ├── auth/
│   │   └── auth-manager.js      # GitHub OAuth Device Code Flow
│   └── mobile/
│       └── touch-handler.js     # Touch gesture support
├── workers/
│   └── scanner-worker.js        # Background scanning worker
├── css/
│   └── themes.css               # Material Design 3 themes
├── config/
│   └── github-oauth.js          # GitHub OAuth configuration
└── icons/                       # Application icons
```

### Key Technologies
- Vanilla JavaScript (no frameworks)
- Material Design 3 color system
- GitHub Gists API / GitLab Snippets API
- Personal Access Token (PAT) authentication with auto-detection
- AES-256-GCM encryption
- CSS Grid & Flexbox
- IndexedDB for local storage
- Web Workers for background scanning

### Building

No build process required - pure vanilla JavaScript!

Simply serve the files with any HTTP server:

```bash
python -m http.server 8000
# or
npx serve
# or
php -S localhost:8000
```

## Security

### Security Features
- ✅ Strong Content Security Policy (CSP)
- ✅ AES-256-GCM encryption for GitHub tokens
- ✅ Browser fingerprint-derived encryption keys
- ✅ No eval() or inline scripts
- ✅ HTTPS-only external requests
- ✅ Input validation and sanitization
- ✅ XSS protection
- ✅ URL validation blocks dangerous schemes

### Reporting Security Issues
Please report security vulnerabilities via GitHub Issues (mark as security issue).

## Browser Compatibility

- **Chrome:** ✅ Fully supported
- **Firefox:** ✅ Fully supported
- **Edge:** ✅ Fully supported (Chromium-based)
- **Safari:** ✅ Should work (untested)
- **Mobile Browsers:** ✅ Full touch support

## Roadmap

Planned future features:
- [ ] **Browser extension integration** - Import from browser extensions
- [ ] **PWA support** - Install as Progressive Web App
- [ ] **Collaborative folders** - Share folders with other users
- [ ] **Local usage metrics** - Track bookmark access frequency (all local)

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Related Projects

- [Bookmark Manager Zero - Firefox](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Firefox)
- [Bookmark Manager Zero - Chrome](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Chrome)
- [Bookmark Manager Zero - Main](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero)

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues:** [GitHub Issues](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website/issues)
- **Source Code:** [GitHub Repository](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website)
- **Firefox Extension:** [Mozilla Add-ons](https://addons.mozilla.org/firefox/addon/bookmark-manager-zero/)
- **Chrome Extension:** [Chrome Web Store](https://chromewebstore.google.com/detail/bookmark-manager-zero/jbpiddimkkdfhoellbiegdopfpilnclc)
- **Buy Me a Coffee:** [Support Development](https://buymeacoffee.com/absolutexyzero)

## Acknowledgments

### Design & Platform
- **Material Design 3** - Color system by Google
- **GitHub Pages** - Free static hosting
- **GitHub Gists** - Simple, private data storage option
- **GitLab Snippets** - Alternative private data storage option

### Security & Malware Detection
- **[URLhaus](https://urlhaus.abuse.ch/)** - Dual coverage: Active + Historical malware URLs
- **[BlockList Project](https://github.com/blocklistproject/Lists)** - Community-maintained blocklists (626K+ entries)
- **[HaGeZi TIF](https://github.com/hagezi/dns-blocklists)** - Threat Intelligence Feeds (608K entries)
- **[Phishing-Filter](https://gitlab.com/malware-filter/phishing-filter)** - Phishing database (~21K entries)
- **[OISD Big](https://oisd.nl/)** - Comprehensive blocklist aggregator (~215K entries)
- **[Google Safe Browsing API](https://developers.google.com/safe-browsing)** - Optional threat intelligence
- **[Yandex Safe Browsing](https://yandex.com/dev/safebrowsing/)** - Optional geographic threat diversity
- **[VirusTotal](https://www.virustotal.com/)** - Optional multi-engine scanning (70+ AV engines)

### Services
- **WordPress mShots** - Website screenshot preview service
- **Google Favicons** - Website icon service

Special thanks to the security research community for maintaining free, public malware databases that help keep users safe.

---

**Made with ❤️ for anyone who loves organized bookmarks**
