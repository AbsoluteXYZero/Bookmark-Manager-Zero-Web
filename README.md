# Bookmark Manager Zero - Website

A fully static web application for managing bookmarks with GitHub Gist synchronization. Built from the Bookmark Manager Zero browser extensions, this website provides all the same powerful features without requiring a browser extension.

## Features

- **GitHub Gist Storage**: Your bookmarks are stored in a private Gist in your GitHub account
- **Bidirectional Sync**: Changes sync automatically between devices
- **Offline Support**: Work offline with IndexedDB caching
- **Dual OAuth**: Choose between standard OAuth or device code flow
- **Import/Export**: Support for HTML (Netscape format) and JSON bookmark files
- **Link Scanning**: Detect dead links and parked domains
- **Safety Checking**: Multi-layer security scanning with local blocklists
- **8 Themes**: Material Design 3 themes with custom accent colors
- **Mobile-Friendly**: Full touch support with press-and-hold gestures
- **No Backend**: 100% static website hosted on GitHub Pages

## Live Demo

- **Primary**: https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/
- **Custom Domain**: https://bmzweb.absolutezero.fyi/

## Technology Stack

- **Frontend**: Vanilla JavaScript (no frameworks)
- **Storage**: GitHub Gists API + IndexedDB
- **Authentication**: GitHub OAuth (Web Flow + Device Flow)
- **Hosting**: GitHub Pages
- **Security**: AES-256-GCM encryption for tokens and API keys

## Getting Started

### For Users

1. Visit the website
2. Choose your preferred login method:
   - **Standard Login**: Redirects to GitHub for authorization
   - **Device Code Login**: Enter a code on GitHub (works on any device)
3. Grant `gist` permission
4. Start managing your bookmarks!

### For Developers

```bash
# Clone the repository
git clone https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website.git
cd Bookmark-Manager-Zero-Website

# Serve locally (requires a local web server)
python -m http.server 8000
# or
npx serve .

# Open in browser
open http://localhost:8000
```

## Project Structure

```
Bookmark-Manager-Zero-Website/
├── index.html                    # Main application
├── css/
│   └── themes.css               # Material Design 3 themes
├── js/
│   ├── core/
│   │   ├── app.js              # Main application logic
│   │   ├── bookmarks.js        # Bookmark tree operations
│   │   ├── ui.js               # UI rendering
│   │   └── scanner.js          # Scanning coordinator
│   ├── storage/
│   │   ├── gist-adapter.js     # GitHub Gist integration
│   │   ├── indexeddb.js        # Offline storage
│   │   ├── sync-manager.js     # Sync + edit locking
│   │   └── storage-adapter.js  # Unified storage interface
│   ├── auth/
│   │   ├── oauth-web.js        # Standard OAuth flow
│   │   ├── oauth-device.js     # Device flow
│   │   └── auth-manager.js     # Token management
│   ├── import-export/
│   │   ├── html-parser.js      # HTML bookmark parser
│   │   ├── json-parser.js      # JSON parser
│   │   └── converter.js        # Format conversion
│   ├── mobile/
│   │   └── touch-handler.js    # Touch gestures
│   └── lib/
│       └── qrcode-lib.js       # QR code generation
├── workers/
│   └── scanner-worker.js       # Background scanning
└── config/
    └── github-oauth.js         # OAuth configuration
```

## Architecture

### Storage Layers

1. **GitHub Gist** (remote, source of truth)
2. **IndexedDB** (local cache, offline support)
3. **Memory** (active session data)

### Data Flow

```
User Action → In-Memory Tree → Sync Manager → IndexedDB → GitHub Gist
```

### Security

- **Token Encryption**: AES-256-GCM with browser fingerprint-derived key
- **API Keys**: User-provided, encrypted storage
- **URL Validation**: Block dangerous schemes and private IPs
- **CORS**: Native GitHub API support, proxied blocklists

## Browser Support

### Desktop
- Chrome 90+
- Firefox 88+
- Edge 90+
- Safari 14+

### Mobile
- Chrome Android 90+
- Safari iOS 14+
- Firefox Android 88+

## Development

### Setting Up OAuth Apps

1. Go to https://github.com/settings/developers
2. Register two OAuth apps:
   - **Development**: `http://localhost:8000/auth/callback`
   - **Production**: `https://bmzweb.absolutezero.fyi/auth/callback`
3. Request scope: `gist`
4. Copy Client IDs to `config/github-oauth.js`

### Local Development

```javascript
// config/github-oauth.js
export const GITHUB_OAUTH = {
  clientId: 'your_development_client_id',
  redirectUri: 'http://localhost:8000/auth/callback',
  scope: 'gist'
};
```

## Deployment

Automatically deployed to GitHub Pages via GitHub Actions when pushing to `main` branch.

### Custom Domain Setup

1. Add `CNAME` file with domain: `bmzweb.absolutezero.fyi`
2. Configure DNS:
   ```
   Type: CNAME
   Name: bmzweb
   Value: absolutexyzero.github.io
   ```
3. Enable HTTPS in GitHub Pages settings

## Features in Detail

### Link Scanning
- Detects dead links (404, 410, 451)
- Identifies parked domains (22+ parking services)
- 7-day cache with configurable bypass

### Safety Scanning
- **Local Blocklists**: ~1.35M malicious domains from 8 sources
- **Optional APIs**: Google Safe Browsing, Yandex, VirusTotal
- **Pattern Detection**: URL shorteners, suspicious TLDs, IP addresses

### Import/Export
- **HTML**: Netscape Bookmark format (compatible with all browsers)
- **JSON**: Chrome and Firefox bookmark formats

### Mobile Support
- Press-and-hold (500ms) to enter move mode
- Hamburger menus always accessible
- Responsive design with 44x44px touch targets
- Haptic feedback on supported devices

## Related Projects

- [Bookmark Manager Zero - Firefox](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Firefox)
- [Bookmark Manager Zero - Chrome](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Chrome)
- [Bookmark Manager Zero - Main](https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero)

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

- Issues: https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website/issues
- Firefox Extension: https://addons.mozilla.org/firefox/addon/bookmark-manager-zero/
- Chrome Extension: https://chrome.google.com/webstore/detail/bookmark-manager-zero/

## Acknowledgments

Built with love by AbsoluteXYZero. Powered by GitHub Gists and vanilla JavaScript.
