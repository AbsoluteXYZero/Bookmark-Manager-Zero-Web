# Bookmark Manager Zero - Website

A fully static web application for managing bookmarks with GitHub Gist synchronization. Built from the Bookmark Manager Zero browser extensions, this website provides all the same powerful features without requiring a browser extension.

**Live Website**: https://absolutexyzero.github.io/Bookmark-Manager-Zero-Website/

## Features

- **GitHub Gist Storage**: Your bookmarks are stored in a private Gist in your GitHub account
- **Auto-Sync**: Automatic polling every 60 seconds checks for remote changes
- **Smart Notifications**: Additions auto-sync with toast notification; deletions require user confirmation
- **Change Preview**: "View Changes" button shows detailed diff before syncing
- **Multi-Device Sync**: Bookmarks sync automatically between devices with edit lock notifications
- **Offline Support**: Work offline with IndexedDB caching
- **Device Code OAuth**: Secure authentication without exposing secrets
- **Import/Export**: Support for HTML (Netscape format) and JSON bookmark files
- **Link Scanning**: Detect dead links and parked domains
- **Safety Checking**: Multi-layer security scanning with local blocklists
- **8 Themes**: Material Design 3 themes with custom accent colors
- **Mobile-Friendly**: Full touch support with press-and-hold gestures
- **No Backend**: 100% static website hosted on GitHub Pages

## Technology Stack

- **Frontend**: Vanilla JavaScript (no frameworks)
- **Storage**: GitHub Gists API + IndexedDB
- **Authentication**: GitHub OAuth Device Code Flow (100% static-friendly)
- **Hosting**: GitHub Pages
- **Security**: AES-256-GCM encryption for tokens and API keys

**Note**: Your bookmarks are stored in YOUR private Gist. The website owner cannot access your data.

### Security

- **Token Encryption**: AES-256-GCM with browser fingerprint-derived key
- **API Keys**: User-provided, encrypted storage
- **URL Validation**: Block dangerous schemes and private IPs

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

## Support

- Issues: https://github.com/AbsoluteXYZero/Bookmark-Manager-Zero-Website/issues
- Firefox Extension: https://addons.mozilla.org/firefox/addon/bookmark-manager-zero/
- Chrome Extension: https://chrome.google.com/webstore/detail/bookmark-manager-zero/

## Acknowledgments

Built with love by AbsoluteXYZero. Powered by GitHub Gists and vanilla JavaScript.
# Trigger workflow
