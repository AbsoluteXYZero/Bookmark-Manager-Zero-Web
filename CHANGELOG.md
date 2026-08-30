## Changelog

### v5.5 (Current)

**Changes:**
- **Opening the sync dialog no longer starts a sync** - It used to begin the moment the dialog appeared, on the assumption that opening it meant you wanted to sync. That made the dialog impossible to reach for anything else: turning background auto-sync off, or changing which snippet you use, meant triggering the very sync you were trying to avoid. Syncing now happens when you press the sync button and not before.

---

### v5.4

Version number only, raised to stay in step with the Chrome and Firefox extensions. No new features, changes or fixes in this release - everything described under v5.3 below is what you already have.

---

### v5.3 - Sync That Decides For Itself

**Version numbering:** This release jumps from 2.1 to 5.3 to match the Chrome and Firefox extensions. Nothing was skipped - the web version had simply been counted separately since it began as a smaller thing, and it has now caught up to the extensions feature for feature: the same sync model, the same review-before-anything-is-removed rule, the same undo everywhere, the same checks on what you type. Carrying two numbering schemes for one product made the same release look like different software depending on where you opened it. From here all three move together, so "v5.3" means the same set of behaviour whether you are in the browser extension or on the web.

**New Features:**
- **Sync now runs on its own** - BMZ checks the cloud every five minutes while it is open, and again about half a minute after you add, rename, move, or delete a bookmark. A bookmark added on your phone shows up here without you asking for it, and one added here travels the other way. Previously the web version only pulled from the cloud on the rare occasion it opened with no bookmarks stored, which in practice meant it almost never pulled at all.
- **One sync button instead of two** - The GitLab Sync Settings dialog now has a single large button that starts working the moment the dialog opens. A ring around it shows what is happening: white while it checks, green when both sides agree, amber when it needs you to decide, red when something failed. The old pair of directional buttons were not the safe options they looked like — "Sync from Device to Cloud" overwrote the cloud copy with no confirmation whatsoever.
- **Sync asks before it removes anything** - Adding is never destructive, so additions in either direction now happen silently and without a dialog. Anything that would delete a bookmark, or rename or move one you did not change yourself, stops and waits. The sync button turns amber, and a "Sync changes to review" dialog lists exactly what would be affected and from which side. You can approve it or leave it for later.
- **Renames and moves travel properly** - Renaming or moving a bookmark here now propagates to your other devices without being asked about, because you made the change and clearly meant it. A rename that arrives from another device asks first, because BMZ only sees that two names differ and cannot know which one you want.
- **Background auto-sync can be switched off** - A toggle under Snippet Sync Options stops all automatic syncing. Manual sync still works when it is off.
- **A card explains a paused sync** - When a sync stops and waits for you, a card appears at the top of your bookmark list, above Quick Access, showing the sync icon and a Review changes button. Nothing opens over what you were doing, and dismissing it with "Not now" leaves the amber sync arrows in place so the signal is never fully silenced. The card clears itself as soon as the difference is resolved, including when you resolve it on another device.
- **Both overwrite directions are always available** - "Overwrite Snippet with Local" and "Overwrite Local with Snippet" now live permanently in Snippet Sync Options, each naming how many bookmarks would be lost before it does anything. Automatic sync resolves everything it safely can, so without these a difference it will not resolve on its own would never surface a choice.
- **Quick Access pins now sync on their own** - Pinning a bookmark saved the pin to this device and nowhere else. It reached your snippet only if some unrelated bookmark change happened to trigger a sync, so pinning something and then changing nothing else never synced at all. Pins are now sent to the cloud a few seconds after you pin, unpin, or reorder them.
- **A rename that arrives through sync is now recorded** - Approving a rename or move made on another device changed the bookmark and left no trace in the changelog, so there was nothing to review afterwards and no way to undo it. It now writes the same kind of entry that renaming a bookmark in BMZ's own edit dialog does, carrying the old and new names, and can be undone from there like any other change.
- **Deleting now asks straight away** - A deletion needs your approval before it travels to your snippet, and that request used to wait for the background sync and then sit as a marker until you next opened BMZ - so a bookmark deleted before bed simply had not gone anywhere by morning. BMZ now checks immediately after you delete, just after the undo window closes, so the choice is in front of you while you are still looking at what you removed. Deleting several in a row asks once, listing all of them.
- **A warning when an address does not look like a link** - Typing something into the address field that cannot work as a bookmark - most often by putting the title and the address in the wrong boxes - used to save without comment and then sync, after which stricter clients rejected it and complained on every sync afterwards. BMZ now says so, and offers to swap the two fields for you. It never refuses to save: if you want to keep it exactly as typed, you can. The same check runs when you edit an existing bookmark.
- **A "What's New" card** - A short summary of the latest changes now appears at the top of your bookmark list, with a Got it button that dismisses it for good. It returns only when there is genuinely something new to say.

**Bug Fixes:**
- **Editing a bookmark no longer overwrites your other devices** - Any change here started a timer that pushed this device's entire collection over the cloud copy. Anything another device had added that this one had not yet seen was erased by it. Every automatic sync now reads the cloud first, adds what is missing on either side, and refuses to remove anything without asking.
- **"Merge Bookmarks" merged nothing** - Choosing Merge when connecting to a snippet read your bookmarks from an internal store that has never had anything written to it, so it always found zero bookmarks and pushed the snippet back unchanged. Your local bookmarks were then replaced by it on the pull that followed. This was never visible, because the same empty read also made BMZ believe you had no local bookmarks at all, so the dialog offering the choice never opened. The same fault made "Create New Snippet with Current Bookmarks" create an empty one.
- **Connecting to a snippet no longer silently discards your bookmarks** - Because of the fault above, connecting always took the "nothing here to worry about" path and pulled the snippet straight over whatever was on this device. You are now asked how to handle it, as was always intended.
- **Setup no longer had two conflicting versions of itself** - The code defining what happens when you create a new snippet existed twice, and the second copy quietly replaced the first. It treated every button in the merge dialog as a yes, so even "Keep Local Bookmarks" would have gone ahead and created a snippet.
- **A restore point is now saved before "Overwrite Local with Snippet"** - That button replaces every bookmark on this device and was the only action in BMZ with no way back. It now saves a full snapshot of your bookmarks to the changelog first. BMZ could already display such snapshots and restore from them - nothing had ever created one, so the safety net was there but unreachable.
- **Automatic syncing never started if you connected in the same session** - Setting up GitLab sync started everything except the five-minute check for changes made on other devices, because that check was only ever started by a page load that already had a snippet connected. It began working after the next reload and not before, which made the first session look as though background syncing simply did not work.
- **The setup screen no longer flashes before your bookmarks load** - Opening BMZ briefly showed the "set up sync or use local bookmarks" screen before your bookmarks appeared. It was deciding whether you were already set up by looking for a saved value that has never actually been written, so the answer was always "not set up" until the real check finished a moment later. BMZ now shows a loading indicator until it knows which screen belongs on screen, and waits until your bookmarks are drawn before clearing it.
- **Bulk deletion can be undone** - Deleting several items at once, or clearing duplicates, recorded nothing and offered no undo - so the two most destructive actions in BMZ were the only ones with no way back, and the warning saying so was accurate. Both now log every item and show an undo button, exactly like deleting a single bookmark. Folders are captured with their entire contents.
- **Restoring a folder from the changelog brings its contents back** - It recreated an empty folder and told you the contents were lost, even though BMZ had stored them all along. Restoring now rebuilds the folder and everything inside it. If the original location no longer exists, the item is restored to a top-level folder and BMZ says where it went, instead of failing.
- **Selecting a folder and something inside it no longer breaks the delete** - Ticking both meant BMZ tried to delete the same bookmark twice, which failed and reported the whole operation as unsuccessful even though the items had gone. The contained selection is now recognised and skipped.
- **Bookmarks restore to the folder they came from** - Bulk deletion recorded the bookmark but not where it lived, so restoring it put it in Other Bookmarks instead of its original folder. Both are now recorded. Items deleted before this change still restore, and BMZ tells you it could not tell where they belonged.
- **Safety checking no longer calls unknown sites "safe"** - One of the security sources returns a normal-looking page for any site it has never examined. BMZ counted the warnings on that page, found none, and recorded the site as safe - when what had actually happened was that nobody had ever looked at it. Those now read as no verdict from that source, and the result rests on the blocklist check alone rather than on a claim nothing supported.
- **Safety checks are around ten times faster** - They were routed through three public relay services, two of which had stopped working entirely and a third that regularly took twenty seconds to fail. A folder of ten bookmarks took nearly nineteen seconds to check and now takes about two. Those relays have been removed.
- **Clearing the cache now actually rescans** - "Clear Cache" reset every status indicator but kept a private record of when each folder was last scanned, so expanding a folder afterwards found that record, decided it was recent, and scanned nothing - for up to a week. That record is now cleared along with everything else.
- **Dead links are now detected properly** - The web version reported almost every link as live, including ones that were plainly gone, while the browser extensions correctly showed them as dead. A web page is not permitted to see the result of a request to another site, so the check had nothing to read and assumed the best - "live" really meant "something answered", not "the page is there". Link checking now happens in two steps that a web page is allowed to see: first whether the domain still exists at all, and then what the page itself returns. A missing domain marks every bookmark under it dead in one step.
- **A new "could not verify" state** - Some sites refuse automated checks entirely. Rather than guessing, those are now marked with a yellow question mark meaning the link could not be verified - it is most likely fine, and opening it is the way to be sure. They are not re-checked on every visit, since nothing about them will change. Links that failed to check for our own reasons, such as a dropped connection, stay grey and are retried normally.
- **Turning on safety checking no longer freezes the page** - Loading the security database locked the tab until all ten lists finished - around 97 MB and three million domains - and it happened again on the first scan of any later session, even with nothing to download, because the saved copy was rebuilt the same way. All of that work was being done on the same thread that draws the page, then copied a second time to hand it to the scanner. It now happens entirely in the background worker that actually uses it, so the page stays responsive throughout and the data is held once instead of twice.
- **Repeat scans start immediately** - Every folder you expanded rebuilt the scanner from scratch, which meant reloading three million domains before it could begin. The scanner is now created once and kept for the session, so only the first scan waits.
- **Scans no longer report the wrong count** - A scan could announce "2 of 3 bookmarks scanned" when all three had finished, because the last result was still being saved when the scan declared itself complete.
- **Blocklists no longer download when safety checking is off** - The security database was fetched before a scan without ever checking whether safety checking was actually switched on, so a device with the feature turned off still downloaded all ten lists and used the bandwidth to do it, for data nothing would ever read. BMZ now only fetches them when the feature is in use, and picks them back up as soon as you turn it on again.
- **A finishing blocklist download no longer interrupts a scan** - When the download completed it wrote "Blocklists loaded" over the status bar regardless of what was there, wiping the progress of a scan already running and leaving it with no visible indication it was still going. A scan now keeps the status bar to itself.
- **A folder is no longer marked as checked when nothing was checked** - Expanding a folder recorded it as scanned as soon as the attempt finished, without distinguishing a completed scan from one that never ran. If checking was switched off at the time, or the scan was stopped part-way, the folder was still stamped as done for seven days - so turning checking back on left it showing no statuses, with no way to prompt it short of waiting the week out. The timestamp is now written only when the bookmarks were genuinely checked, or were already up to date.

**Improvements:**
- **One notification per sync, not five** - Each step of a sync announced itself separately, so a single sync could produce a stack of toasts. Only the action you actually started reports now, and when the sync button itself shows the outcome there is no toast at all.
- **"Snippet Options" is now "Snippet Sync Options"** - and the GitLab Sync Settings heading is centred.
- **The review dialog says less and means more** - Each section now states plainly what syncing would do - "Remove 2 bookmarks from your snippet to match this device" - instead of a paragraph explaining that your consent is required, which the heading and the buttons already made obvious. Counts read as "1 bookmark" or "3 bookmarks" rather than "1 bookmark(s)", and renames show as "old name to new name" with an arrow.
- **Three buttons became two** - "Decline Sync - Keep Everything" and "Decide later" did almost the same thing, and once the notice card gained its own dismiss button the distinction stopped being worth making. There is now Approve and Cancel. Cancel changes nothing on either side and leaves the sync arrows amber, because the difference is genuinely still unresolved - nothing switches that warning off any more without actually settling it.
- **The Approve button is no longer red** - Red read as danger on a button whose entire job is to apply changes you have just reviewed and chosen. It now uses the same amber as the rest of the paused-sync flow, so the card, the sync arrows and the button are visibly one thing. The individual bookmarks listed above it keep their red and amber markers, which is where that warning belongs.
- **Sync dialogs match the rest of BMZ** - They were built in a way that never picked up the shadows every other panel in BMZ has, so they sat flat against the page while everything around them lifted off it. They now carry the same depth, and on the enhanced and tinted themes the same hairline border and lit top edge that the header and settings menu use. The plain themes stay flat, exactly as they do everywhere else.
- **The review dialog accounts for what synced silently** - Bookmarks that arrive from your snippet need no approval, so they are added without asking - but a dialog appearing while bookmarks quietly show up left that unexplained. It now says how many were added and how many of yours are about to go up, each expandable to name them.

---

### V2.0 - Sync Clarity & Share Reliability

**Bug Fixes:**
- **The share window no longer hangs forever after saving** - Sharing a link could leave the window stuck on "Syncing to GitLab..." with no error and no way forward, even though the bookmark had already been saved. None of BMZ's requests to GitLab had a time limit, so a stalled mobile connection left the sync waiting indefinitely rather than failing. Every request now gives up after 30 seconds and reports what went wrong, with the option to retry. Reporting a failure is safe to act on: the bookmark is written to your device before the sync begins, so nothing is lost either way.
- **Sharing a link no longer resurrects bookmarks you deleted elsewhere** - If another device had deleted bookmarks that this one had not caught up on yet, the share window did not notice, and saving pushed your out-of-date list back to the cloud, restoring every one of those deleted bookmarks. The share window now detects that situation before saving anything.

**New Features:**
- **Resolve sync differences without leaving the share window** - When your bookmarks differ from the cloud, the share window now shows what changed and names the specific bookmarks that a sync would delete, along with the folder each one sits in. You can then sync in either direction on the spot, or save to this device only. Previously this meant backing out of the share, opening the full app, and running a sync there just to see what the difference was.
- **A warning when a sync is taking too long** - If a save has not finished after ten seconds, the share window now says so, reminds you the bookmark is already saved on your device, and lets you close it rather than sit and wait. The sync keeps running in the background and still completes on its own.
- **Snippet Options are tucked away** - The GitLab Sync Settings dialog now opens to just the two sync buttons. The snippet ID, token storage, and the create, select, and disconnect actions live behind a "Snippet Options" section you expand when you need it, which are things you set once and rarely revisit.

**Improvements:**
- **Clearer sync button wording** - The two sync buttons now read "Sync from Cloud to Device" and "Sync from Device to Cloud", which say plainly which way your bookmarks are about to move. They previously referred to a "Snippet" or a "Browser" depending on which version of BMZ you were using, and "Browser" was misleading here, since the web app and Android app keep bookmarks in their own storage rather than in a browser's bookmarks.
- **Identical sync wording everywhere** - The Firefox, Chrome, and web versions had drifted apart, naming the same things differently in each. Every label in the GitLab sync dialogs is now the same across all three.
- **Token storage options explain themselves** - Local and Supabase each carry an information icon with a full explanation of what that choice means for your token when it renews.
- **Quick Access menu item no longer moves** - Add and Remove now occupy the same position in the right-click menu, just above Delete, so the item stays where you expect once a bookmark is pinned. Remove is shown in red and asks for confirmation first, with a reminder that it only unpins and never deletes the bookmark.

---

### V1.9.0 - Quick Access & Recently Opened

**New Features:**
- **Quick Access** - Pin the bookmarks you use most to a section at the top of the list. Right-click any bookmark and choose "Add to Quick Access", or drag one onto the section. Pinned entries are mirrors, not copies: the same bookmark, shown in a second place. Delete the bookmark from its real folder and the pin disappears with it. Removing a pin only unpins it and never touches the underlying bookmark, so there is no way to destroy a bookmark from the Quick Access section.
- **Drag to reorder Quick Access** - Arrange your pins in whatever order you like by dragging them within the section. Pins cannot be dragged out into your real folders, so reordering can never move or rearrange the actual bookmarks.
- **Recently Opened** - The last 5 bookmarks you opened from BMZ, so getting back to something takes one click. Opening the same bookmark twice in a row moves it to the top instead of adding a second row. This list stays on this device and is never synced.
- **Shared collapsible row** - Quick Access and Recently Opened share a single row split in two and behave as an accordion, so opening one closes the other and neither eats space when you are not using it. Your choice is remembered between sessions.
- **Display toggles** - Both sections can be shown or hidden independently from the Display Options button in the toolbar, and the setting is remembered. Hiding one gives the other the full width.
- **Quick Access syncs across devices** - Your pins travel with your GitLab snippet and arrive on every device using it, including the browser extensions. They are stored in a separate file inside the snippet, so versions of BMZ that do not yet support Quick Access cannot erase them, and pins made on two devices merge rather than overwrite. Unpinning on one device propagates instead of being resurrected by the other.

**Bug Fixes:**
- **HaGeZi TIF blocklist restored** - This source had stopped loading entirely, reporting HTTP 403. Two unrelated breakages happened at once: the jsDelivr CDN began refusing every file in the list's repository once the repository outgrew its 150 MB limit, and the project separately reorganised its folders so the old path no longer existed. Now loaded from GitHub directly using the current path. All ten blocklist sources were checked and the rest were unaffected.
- **Browser-internal bookmarks no longer show as phantom sync changes** - A bookmark such as `about:debugging` was reported as changed on every single pull, forever, even when nothing had changed. Chrome rewrites browser-internal addresses when it saves them, so the same bookmark ends up written slightly differently in each browser. BMZ was correctly noticing the difference and wrongly presenting the browser's own edit as yours. Sync now recognises these as the same bookmark, and nothing is rewritten or overwritten.
- **Merge dialog no longer appears when bookmarks already match** - Connecting to a snippet last written by a different browser always prompted you to choose a merge strategy, even with identical bookmarks. The check compared an exact fingerprint of the whole collection, and because Firefox names its toolbar folder "Bookmarks Toolbar" where Chrome names it "Bookmarks bar", that fingerprint could never match across browsers. BMZ now falls back to a real comparison and connects quietly when there is genuinely nothing to reconcile.
- **Scan results now update every copy of a bookmark** - With a bookmark visible in both the list and Quick Access, only the first copy on the page received link and safety results. The other stayed on a stale icon until the next redraw.

---

### V1.8.0 - Share to BMZ (Android)

**New Features:**
- **Share a link straight into BMZ (Android app)** - Sharing a page from any mobile browser now offers "Save to BMZ" in the Android share sheet. It opens a small floating window over the browser rather than launching the full app, so a link can be filed without leaving what you were reading. Saving no longer means waiting for a bookmark to travel through a browser account sync to a desktop before BMZ ever sees it.
- **Recently saved-to folders** - The Add Bookmark dialog now defaults to the folder you last saved a bookmark into, with up to five other recent folders offered as one-tap chips underneath. Only folders you actually saved or moved a bookmark into are counted; simply browsing a folder does not affect the list. Applies to the normal Add Bookmark dialog as well as the share window.
- **Duplicate warning without a popup** - The share window shows an inline note under the URL when the page is already bookmarked, with a button to reveal the full folder path of every existing copy. The old blocking confirm dialog still applies everywhere else.

**Sync:**
- **Share saves sync immediately** - When GitLab sync is configured, the share window pulls the latest bookmarks before writing and pushes the new bookmark straight afterwards, so it reaches your other devices without waiting for the next app launch. Pulling first matters: the phone usually holds the stalest copy, and pushing from a stale copy would overwrite changes made elsewhere.
- **Every stage reports its own failure** - If the pull, the save, or the push fails, the window says which stage failed and why (offline, GitLab unreachable, expired token, missing snippet, rate limit) and offers a retry. A failed pull additionally offers to save on this device only. A bookmark that saves but fails to push stays flagged as pending and syncs on the next launch.
- **Stale window protection** - After a share saves a bookmark, the main app window reloads its bookmark tree when reopened, so it cannot save its pre-share copy over the top of what was just added.

**Changes:**
- **No scanning during a share** - Link checking and safety checking are disabled entirely in the share window, including the usual scan of a newly added bookmark. Filing a link stays a quick write with no burst of network requests behind it.

---

### V1.6.0 - Sync Fixes & Cleanup

**New Features:**
- **Scan Intensity Slider** - New slider in Settings controls how many bookmarks are link/safety-checked at once (1-20, default 5). Each check is a live request that triggers a DNS lookup, so scanning a large library all at once could briefly overwhelm a local DNS resolver (AdGuard Home, Pi-hole) and knock out your internet. Lowering this keeps scans gentle on your network. Persists across sessions and applies live to an in-progress scan.
- **Request Jitter Slider** - New slider in Settings adds a small random delay (0-500ms) before each scan request, spreading DNS lookups across time instead of firing them as one burst. Raise it, alongside lowering Scan Intensity, if scans still disrupt your connection.

**Performance:**
- **DNS-Friendly Scanning** - Lowered the default cap on simultaneous scan requests so scanning a large library no longer risks overwhelming a local DNS resolver (AdGuard Home, Pi-hole) and dropping your connection.

**Bug Fixes:**
- **Stop Scan Reliability** - Hardened scan cancellation: the stop button reliably halts the scan, the worker-less fallback scan path now honors Stop, and overlapping scans triggered by expanding several folders no longer stomp each other's progress or flicker the stop button off.
- **Scan Status Returns to "Ready"** - After stopping a scan, the status bar settles back to "Ready" instead of sticking on "Scan stopped" (including the fallback scan path).
- **Settings Slider Handle** - Added proper slider-handle styling for Chromium browsers and the Android WebView so the handle renders centered on the track instead of missing or sitting too low.
- **Folder Count Position (Android app)** - The bookmark count inside a folder icon sat too high in the Android app because it was centered in the icon's square bounding box rather than the folder body (the folder shape's top-left tab pushes the body lower), an offset exaggerated by the WebView's font metrics. The number is now nudged into the folder body in the Android app only; desktop browsers and the extensions were already correct and are unchanged. Also added reliable Android-app detection (the app overrides its user agent, so the standard WebView check did not apply).
- **Manual sync now works when versions match** - "Sync from Cloud to Browser" and "Sync from Browser to Cloud" previously did nothing when the local and remote version numbers were equal but the bookmarks actually differed — the sync silently reported "up to date." Both buttons now force the operation: cloud-to-browser pulls and reconciles, browser-to-cloud pushes, regardless of version.
- **Header buttons no longer overlap the title** - On the Android app, with an enlarged device font the GitLab, sync, logout, and settings buttons could cover the right end of the title and subtitle. The buttons now occupy their own reserved space and the title and subtitle scale down to fit the remaining width on a single line, clear of the buttons at any width and after signing in. (Scaling uses a CSS transform because the WebView ignores small font sizes when the device font is enlarged.)

**Improvements:**
- **Divergence detection on auto-sync** - When versions match but the cloud and local bookmarks differ, auto-sync now surfaces a one-time notice ("Cloud differs from this device — open GitLab sync to reconcile") instead of falsely reporting everything is in sync.

**Changes:**
- **Removed per-sync "Merge" option** - The sync conflict dialog no longer offers a "Merge" button, and the unused bidirectional-merge code was removed. A union merge can't honor deletions — deleted bookmarks get re-added from the other side — so sync decisions are now explicit: Keep Local or Use Snippet. The one-time merge when first connecting a snippet is unchanged.

---

### V1.5 - Performance & URLhaus Fix

**Performance:**
- **Lazy-loaded Services** - Blocklist and Scanner services now initialize on first use, not at startup
- **Faster Startup** - Removed blocking init calls from showMainApp()

**URLhaus Fix:**
- **Direct GitHub Import** - URLhaus Active list now fetched from dedicated GitHub repo (AbsoluteXYZero/urlhaus-list) instead of CORS-proxied URLhaus API

---

### V1.4.1 - Mobile UX Improvements

**New Features:**
- **Pull-to-Refresh** - On mobile, drag down from above the search bar to reload the page. A pull indicator fades in showing progress and prompts to release when the threshold is reached.
- **Local Mode Default** - The first-time setup screen now defaults to Local Mode instead of GitLab Sync.

**Bug Fixes:**
- **Cache Busting** - Added `_headers` config for Cloudflare Pages to prevent browsers from serving stale JS files after updates.

---

### V1.4.0 - Multi-Select Bulk Open

**New Features:**
- **Long-Press to Multi-Select** - Click and hold any bookmark or folder for 750ms to enter multi-select mode. The held item is automatically added to the selection. Drag-and-drop is fully preserved — moving the mouse during the hold cancels the timer and initiates a drag as normal.
- **Open in New Tabs** - New bulk action button. Due to browser popup restrictions on web pages, shows a modal listing all selected bookmarks as individually clickable links. Use the Chrome or Firefox extension to open all at once automatically.
- **Open in New Windows** - New bulk action button. Shows an informational toast directing users to the Chrome or Firefox extension, where this feature is fully supported.

---

### V1.3.1 - Bug Fixes

**Bug Fixes:**
- **Android WebView Edge False Positive** - Fixed the "Browser Not Supported" Edge incompatibility warning incorrectly appearing inside the Android app. Devices with Microsoft Edge set as their system WebView provider caused the user agent to contain `EdgA`, triggering the block. The detection now correctly exempts Android WebViews.

---

### V1.3.0 - Context Menu Redesign

**New Features:**
- **Replace Remote Snippet with Local** - New option in the sync setup dialog when connecting a GitLab snippet. Overwrites the remote snippet with your current local bookmarks, in addition to the existing Keep Local, Merge, and Replace Local with Remote Snippet options.

**Improvements:**
- **Drag-and-Drop Reliability** - Overhauled drop zone logic. Each item now acts as a single unified drop target (top half = insert before, bottom half = insert after) replacing the previous three competing zones per gap. Folder headers additionally support drop-into on the bottom half. Fixed an index offset bug that caused items to land one position too far down when reordering within the same folder.
- **Context Menu Redesign** - Right-click and hamburger menus now open as a slide-in panel from the right edge of the sidebar instead of a fragile absolute-positioned popup. Eliminates clipping, size inconsistencies, and overlap issues. Click outside or press Escape to dismiss.

---

### V1.2.0 - Move To, Keyboard Shortcuts & Drag Improvements

**New Features:**
- **Move to... Context Menu** - Right-click any bookmark or folder and select "Move to..." to relocate it via a modal folder picker
  - Folder dropdown with optional alphabetical sorting
  - Prevents moving folders into themselves or their descendants
  - Protects built-in root folders
  - Full changelog integration with undo/restore support
- **Keyboard Shortcut: Ctrl+Click** - Open bookmarks in a new tab
- **Keyboard Shortcut: Shift+Click** - Open bookmarks in a new window
- **Multi-Select Click Anywhere** - In multi-select mode, clicking anywhere on a bookmark or folder toggles its selection (no longer requires clicking the small checkbox)

**Improvements:**
- **Drag-and-Drop Auto-Scroll** - Dragging a bookmark near the top or bottom edge of the list now auto-scrolls at a speed proportional to cursor proximity
- **Sync Success Visual Feedback** - Manual sync button now shows spinning arrows during sync and green arrows for 5 seconds on success, replacing success toasts. Error toasts are preserved.

**Bug Fixes**
- **Fixed "allBookmarks is not defined"** - Resolved error in bulk recheck and bulk move functions by properly fetching the bookmark tree before use

---

### V1.1.0

**Fixed**
- **Auto-Scan Timing Issue**: Fixed folder expansion auto-scan getting stuck at "Scanning 0/X" when folder is expanded before scanner worker is initialized. Now waits for worker initialization before starting scan.
- **Blocklist Download Status Bar**: Fixed status bar getting stuck on "Downloading blocklists..." if download fails. Now always dispatches completion event via `finally` block.
- **CORS Proxy Reliability**: URLVoid scraping now uses parallel proxy racing with Promise.any() - first successful response wins
- **CORS Proxy Timeout**: Increased timeout from 5s to 15s to allow slower proxies to respond
- **Clear Cache Button**: Fixed settings menu "Clear Cache" button not working - now properly clears IndexedDB cache store
- **Badge Updates**: Fixed status badge updates during folder expansion scans for both list and grid view modes
- **DOM Updates**: Fixed updateBookmarkStatusInDOM to correctly update both `.status-indicators` (list view) and `.bookmark-top-row` (grid view) containers

**Added**
- **Multiple CORS Proxy Fallbacks**: Added 3 parallel CORS proxies for URLVoid scraping:
  - corsproxy.io (primary)
  - api.allorigins.win (fallback)
  - api.codetabs.com (fallback)
- **Colored Detection Output**: URLVoid detection counts now display with color coding in console:
  - Blue (#4dabf7) for 0 detections (safe)
  - Red (#ff6b6b) for 1+ detections (warning/unsafe)

**Changed**
- **Console Logging Cleanup**: Removed extensive debug console.log statements throughout the codebase for cleaner production output. Retained only essential logs:
  - Error messages
  - URLVoid detection results (with colored output)
  - Blocklist matches for unsafe URLs
  - Cache load completion status

**Technical Details**
- URLVoid scraping uses AbortController for proper timeout handling
- Promise.any() ensures fastest proxy response is used while others are cancelled
- IndexedDB cache clearing now uses `dbManager.clear('cache')` directly instead of non-existent scanner service method

---

## V1.0.0 - Initial Release

**Features:**
- GitLab Snippet sync for cross-device bookmark synchronization
- Local mode for offline-only usage
- Link status checking (alive/dead detection)
- Safety checking via:
  - Local blocklist database (~1.35M domains)
  - URLVoid web scraping
  - Google Safe Browsing API (optional)
  - Yandex Safe Browsing API (optional)
  - VirusTotal API (optional)
- Grid and list view modes
- Dark/light theme support
- Folder-based organization
- Search and filter functionality
- Import/export capabilities
- QR code generation for bookmarks
- Keyboard navigation support
- Touch gesture support for mobile
