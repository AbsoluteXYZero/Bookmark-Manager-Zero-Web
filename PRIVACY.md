# Privacy Policy – BMZ (Bookmark Manager Zero)

**Effective Date:** [12/21/2025]  
**Last Updated:** [11/18/2026] - added Section 6, which covers the BMZ website and the outside services it uses  
**Contact:** [bookmarkmanagerzero@mail.absolutezero.fyi]

## 1. Introduction
BMZ (Bookmark Manager Zero) (“the App”) is a utility app that provides a kiosk-style WebView experience to access a developer-owned website. Protecting your privacy is important to us. This Privacy Policy explains how the App collects, uses, and shares information.

By using the App, you agree to the terms of this Privacy Policy.

---

## 2. Information Collection
BMZ **does not collect, store, or process any personal or sensitive information**. This includes, but is not limited to:

- Name, email, phone number, or contact information  
- Location data  
- Device identifiers  
- Analytics or usage data  

Any data entered or generated on the website loaded inside the App (e.g., bookmarks, QR codes) **remains on your device or is handled by the website**, not by the App itself.

---

## 3. User Content and Sharing
The App does **not** provide native functionality for:

- Messaging or voice communication  
- Text, image, or audio sharing between users  
- User-generated content storage or moderation  

Any sharing or interaction is performed entirely on the website loaded inside the App and is outside the App’s control.

---

## 4. Ads and Third-Party Services
The App **does not display ads** and **does not use third-party SDKs** for advertising, analytics, or tracking.

---

## 5. External Links and Web Content
The App loads a single, developer-controlled website. Any links or content you access through the website:

- Are not collected by the App  
- Are governed by the website’s privacy terms in Section 6 below  

The App does not modify, filter, or curate external content.

---

## 6. The BMZ Website and Its External Services
This section applies to the BMZ website (https://bmzweb.absolutezero.fyi/), which the App loads and which you can also open in any browser.

**Where your bookmarks are stored.** The website has no account system and no database of its own. Your bookmarks stay in your browser's local storage (IndexedDB). If you turn on GitLab Sync, they are also stored in a private repository in **your own** GitLab account. The developer cannot read that repository. Your GitLab token is encrypted (AES-256-GCM) before the website stores it in your browser.

**No tracking.** The website has no analytics, no advertising, and no tracking scripts.

**Outside services.** Some features send data to outside services. The list below names every service, what it receives, and why. You can turn off link checking and safety checking in Settings (the gear menu), with **Enable Link Checking** and **Enable Safety Checking**. You can turn off favicons and previews in Display Options (the eye icon).

| Service | What it receives | Why |
|---|---|---|
| **GitLab** (gitlab.com) | Your bookmark data and your GitLab token | GitLab Sync only. Stores your bookmarks in your own private repository. |
| **Cloudflare DNS-over-HTTPS** (cloudflare-dns.com) | The hostname of each bookmark | Link checking. Finds out whether a domain still exists. |
| **BMZ link checker** (a Supabase Edge Function at zkwmxywegwgqcgssgfqv.supabase.co) | Your bookmark URLs, and bookmark domains for URLVoid checks | Link checking. A web page cannot read another site's status code, so this function requests each URL from the server side and returns only the status code. It keeps results in memory for up to one hour and writes nothing to a database or to disk. Checked sites see Supabase's servers, not your IP address. The developer runs it on Supabase, and Supabase can keep request logs under its own privacy policy (https://supabase.com/privacy). |
| **URLVoid** (urlvoid.com) | Bookmark domains, sent by the BMZ link checker | Safety checking. Reputation lookup. URLVoid sees the BMZ link checker's request, not your IP address. |
| **Blocklist sources** (URLhaus, BlockList Project, HaGeZi, Phishing-Filter, OISD, FMHY, Dandelion Sprout) | Nothing about your bookmarks | Safety checking. The website downloads the full lists and checks your bookmarks against them inside your browser. |
| **WordPress mShots** (s0.wp.com) | The URL of each bookmark that shows a preview | Screenshot previews. You can turn previews off in Display Options. |
| **Google Favicons** (google.com) | The domain of each bookmark | Website icons. You can turn favicons off in Display Options. |
| **Google Safe Browsing, Yandex Safe Browsing, VirusTotal** | The URLs being checked | Optional safety checks. Used only if you enter your own API key for that service. |

The source code of the website and of the BMZ link checker is public, so you can confirm all of the above. Until November 2026 the link checker ran on Val.town. It moved to Supabase because Val.town is shutting down.

---

## 7. Children’s Privacy
The App is **not directed at children** and does **not knowingly collect data from children**. There are no features that would require compliance with child-specific data regulations beyond this policy.

---

## 8. Data Security
While the App does not collect any personal information, it follows general best practices for security and does **not transmit any data off the device** except when the website loaded by the App itself initiates a network connection.

---

## 9. Changes to This Privacy Policy
We may update this Privacy Policy from time to time. The latest version will always be available at the URL where it is hosted. Your continued use of the App constitutes acceptance of any updates.

---

## 10. Contact
If you have questions or concerns about this Privacy Policy, please contact us at:  

**Email:** [bookmarkmanagerzero@mail.absolutezero.fyi]
