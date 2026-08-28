/**
 * Sync Manager
 * Handles bidirectional sync between IndexedDB and remote storage (GitLab Snippet)
 * Implements version-based conflict detection to prevent data loss
 */

import dbManager from './indexeddb.js';
import snippetAdapter from './snippet-adapter.js';
import storageAdapter from './storage-adapter.js';
import authManager from '../auth/auth-manager.js';
import supabaseManager from '../auth/supabase-manager.js';
import { safeLocalStorage, addChangelogEntry, clearChangelog } from '../utils/storage-utils.js';

class SyncManager {
  constructor() {
    this.snippetId = null;
    this.provider = 'gitlab'; // Always GitLab
    this.deviceId = authManager.getDeviceId();
    this.syncInterval = null;
    this.isSyncing = false;
    this.hasUnsyncedChanges = false;
    this.lastSyncTime = null;
    this.autoSyncEnabled = true;
    this.minSyncInterval = 60000; // Minimum 60 seconds between syncs to avoid abuse detection
    /* [ZeroLabs] 2026-08-27 - added: last announced deferral state */
    // Seeded false so the first clean sync of a session does not announce a
    // change that has not happened.
    this._needsReconcile = false;
  }

  /**
   * Get the GitLab snippet adapter
   */
  getAdapter() {
    return snippetAdapter;
  }

  /**
   * Get the current remote ID (snippet)
   */
  getRemoteId() {
    return this.snippetId;
  }

  /**
   * Set the current provider (always gitlab)
   */
  async setProvider(provider) {
    this.provider = 'gitlab';
    await dbManager.put('metadata', { key: 'syncProvider', value: 'gitlab' });
    console.log('Sync provider set to: gitlab');
  }

  /**
   * Initialize the sync manager
   */
  async init() {
    // Prevent duplicate initialization
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this.provider = await authManager.getPreference('syncProvider') || 'gitlab';

    // Initialize adapter
    this.adapter = snippetAdapter;
    // Note: snippetAdapter doesn't have setProvider method, it's always GitLab

    // Load snippet ID from storage
    const savedId = this.adapter.loadSavedSnippetId();
    if (savedId) {
      this.snippetId = savedId;
      console.log('Loaded Snippet ID from storage:', savedId);
    }

    /* [ZeroLabs] 2026-08-27 - added: start recording what this device does */
    this.watchLocalBookmarkEvents();
  }

  // ==========================================================================
  // THE SYNC MODEL
  // ==========================================================================
  /* [ZeroLabs] 2026-08-27 - added: the four-outcome reconcile (see also: Bookmark-Manager-Zero-Chrome/background.js) */
  // Every sync starts as a merge check and lands on one of four outcomes:
  //
  //   1. The snippet has bookmarks this device lacks, nothing deleted
  //        -> create them here. Silent.
  //   2. This device has bookmarks the snippet lacks, nothing deleted
  //        -> push. Silent.
  //   3. Both -> create here, then push. Silent.
  //   4. Anything that would REMOVE or OVERWRITE on either side
  //        -> do not sync. Amber sync button, and a consent dialog.
  //
  // Adding is never destructive, so it never asks. Deferring IS the answer to
  // "I cannot tell which side is right" - BMZ never guesses at intent.
  //
  // What makes 2 and 4 tell each other apart is attribution: the lists below
  // record what THIS device watched the user do, so a local-only bookmark it saw
  // created is an addition to push, while one it never saw created came from
  // somewhere else and its absence from the snippet means a deletion.

  /* [ZeroLabs] 2026-08-27 - added: record this device's own changes */
  // Keyed by URL, because that is the one thing that survives the round trip
  // through the snippet. Cleared on every clean sync: once both sides agree,
  // there is nothing left for these to explain.
  watchLocalBookmarkEvents() {
    if (this._bookmarkEventsWatched || typeof window === 'undefined') return;
    this._bookmarkEventsWatched = true;

    window.addEventListener('bmz:bookmarks:created', (e) => {
      const [, node] = e.detail || [];
      this.recordLocalBookmarkEvent('created', node);
    });

    window.addEventListener('bmz:bookmarks:removed', (e) => {
      const [, info] = e.detail || [];
      this.recordLocalBookmarkEvent('deleted', info && info.node);
    });

    /* [ZeroLabs] 2026-08-27 - added: an edit is attributable too */
    // A rename or move keeps the URL, so it is invisible to the created and
    // deleted lists, and comparing titles alone cannot say WHOSE rename it is.
    // Without this, two devices holding different titles for one URL each see a
    // difference, each push their own, and they revert each other forever.
    window.addEventListener('bmz:bookmarks:changed', (e) => {
      const [id, changes] = e.detail || [];
      this.recordLocalBookmarkEdit(id, changes && changes.url);
    });

    window.addEventListener('bmz:bookmarks:moved', (e) => {
      const [id] = e.detail || [];
      this.recordLocalBookmarkEdit(id);
    });

    // A wholesale replacement (an import, a clear) is a pile of single changes
    // that never fired individually, so it is attributed by comparing the two
    // trees. Taking the snippet's copy passes attribute: false, because none of
    // the result is this device's change and pushing it back is the last thing
    // that should happen.
    window.addEventListener('bmz:bookmarks:replaced', async (e) => {
      const [info] = e.detail || [];
      if (!info) return;
      if (!info.attribute) {
        await this.clearLocalBookmarkEvents();
        return;
      }

      const before = this.collectSnippetEntries(info.oldTree);
      const after = this.collectSnippetEntries(info.newTree);
      const created = [];
      const deleted = [];
      after.forEach((entry, url) => { if (!before.has(url)) created.push(url); });
      before.forEach((entry, url) => { if (!after.has(url)) deleted.push(url); });

      if (created.length) await this.recordLocalBookmarkUrls('created', created);
      if (deleted.length) await this.recordLocalBookmarkUrls('deleted', deleted);
    });
  }

  async recordLocalBookmarkEvent(kind, node) {
    if (!node) return;

    // Deleting a folder is one event for the whole subtree, never one per
    // bookmark inside it, so the subtree has to be walked or those URLs go
    // unrecorded and their deletion looks like it happened somewhere else.
    const urls = [];
    const walk = (n) => {
      if (!n) return;
      if (n.url) urls.push(n.url);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(node);

    await this.recordLocalBookmarkUrls(kind, urls);
  }

  async recordLocalBookmarkUrls(kind, urls) {
    if (!urls || urls.length === 0) return;

    const key = kind === 'created' ? 'snippet_local_created' : 'snippet_local_deleted';
    const opposite = kind === 'created' ? 'snippet_local_deleted' : 'snippet_local_created';

    try {
      const stored = await storageAdapter.get([key, opposite]);
      const list = new Set(stored[key] || []);
      const otherList = new Set(stored[opposite] || []);

      urls.forEach(url => {
        list.add(url);
        // Re-adding something you deleted cancels the deletion, and vice versa,
        // so the two lists can never disagree about the same URL.
        otherList.delete(url);
      });

      await storageAdapter.set({
        [key]: Array.from(list).slice(-2000),
        [opposite]: Array.from(otherList)
      });
    } catch (error) {
      console.error('[Reconcile] Could not record local bookmark event:', error);
    }
  }

  async recordLocalBookmarkEdit(id, explicitUrl) {
    try {
      let url = explicitUrl;
      if (!url) {
        // A move carries only parent ids, so the URL has to be looked up.
        const tree = await this.loadLocalBookmarks();
        const found = this.findNodeInTree(tree, id);
        url = found && found.url;
      }
      if (!url) return; // Folders are represented by the bookmarks inside them

      const stored = await storageAdapter.get('snippet_local_edited');
      const list = new Set(stored.snippet_local_edited || []);
      list.add(url);
      await storageAdapter.set({ snippet_local_edited: Array.from(list).slice(-2000) });
    } catch (error) {
      console.error('[Reconcile] Could not record local edit:', error);
    }
  }

  async clearLocalBookmarkEvents() {
    await storageAdapter.set({
      snippet_local_created: [],
      snippet_local_deleted: [],
      snippet_local_edited: []
    });
  }

  findNodeInTree(tree, id) {
    if (!tree || !tree.roots) return null;
    const walk = (node) => {
      if (!node) return null;
      if (node.id === id) return node;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    for (const root of Object.values(tree.roots)) {
      const found = walk(root);
      if (found) return found;
    }
    return null;
  }

  /* [ZeroLabs] 2026-08-27 - added: bookmarks with the folders they live in */
  // Roots are handled by KEY, never by title. The snippet names its toolbar root
  // differently depending on which browser last wrote it, and the key is the one
  // thing that survives that. Comparing anything title-derived across clients
  // would report a difference forever and the two would push at each other.
  collectSnippetEntries(snippetData) {
    const entries = new Map();
    if (!snippetData || !snippetData.roots) return entries;

    const walk = (node, rootKey, segments) => {
      if (!node) return;
      if (node.url) {
        entries.set(node.url, { url: node.url, title: node.title || node.url, rootKey, segments });
        return;
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(child => walk(
          child,
          rootKey,
          child.url ? segments : segments.concat(child.title || child.name || 'Unnamed Folder')
        ));
      }
    };

    Object.keys(snippetData.roots).forEach(rootKey => {
      const root = snippetData.roots[rootKey];
      if (!root) return;
      if (Array.isArray(root.children)) {
        root.children.forEach(child => walk(
          child,
          rootKey,
          child.url ? [] : [child.title || child.name || 'Unnamed Folder']
        ));
      }
    });

    return entries;
  }

  generateLocalId() {
    return `bmz_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /* [ZeroLabs] 2026-08-27 - added: place snippet bookmarks in the local tree */
  // The tree is mutated directly rather than through bookmarkManager.create, on
  // purpose: these came from the snippet and firing created events for them would
  // record them as this device's additions and push them straight back out.
  //
  // Unlike the extensions, nothing here can fail to be placed. The local tree
  // holds all four roots natively and folders are created freely, so the
  // extensions' unplaceable-items dialog has no situation to describe here.
  async createSnippetItemsLocally(entries) {
    const tree = await this.loadLocalBookmarks();
    if (!tree || !tree.roots) return 0;

    let created = 0;
    // Shallower folders first, so a parent exists before anything inside it
    const ordered = [...entries].sort((a, b) => a.segments.length - b.segments.length);

    for (const entry of ordered) {
      const root = tree.roots[entry.rootKey] || tree.roots.other;
      if (!root) continue;
      if (!Array.isArray(root.children)) root.children = [];

      let parent = root;
      for (const segment of entry.segments) {
        let next = parent.children.find(child =>
          child.type === 'folder' && (child.title || child.name) === segment);
        if (!next) {
          next = {
            id: this.generateLocalId(),
            title: segment,
            name: segment,
            type: 'folder',
            dateAdded: Date.now(),
            children: []
          };
          parent.children.push(next);
        }
        if (!Array.isArray(next.children)) next.children = [];
        parent = next;
      }

      parent.children.push({
        id: this.generateLocalId(),
        title: entry.title,
        url: entry.url,
        type: 'bookmark',
        dateAdded: Date.now()
      });
      created++;
    }

    tree.lastModified = Date.now();
    await this.saveLocalBookmarks(tree);
    return created;
  }

  /* [ZeroLabs] 2026-08-27 - added: the amber "something is waiting" state */
  // The website has no background worker and no toolbar badge, so the header
  // sync button carries the whole signal. The flag is stored as well as shown,
  // because a deferral raised on one page load has to still be there on the next.
  async setSnippetNeedsReconcile(needs) {
    const value = !!needs;

    try {
      await storageAdapter.set({ snippet_needs_reconcile: value });
    } catch (error) {
      console.error('[Reconcile] Failed to store reconcile flag:', error);
    }

    if (typeof document !== 'undefined') {
      const btn = document.getElementById('manualSyncBtn');
      if (btn) btn.classList.toggle('sync-attention', value);
    }

    /* [ZeroLabs] 2026-08-27 - added: drive the notice card, on change only */
    // A clean sync calls this with false constantly and the poll re-reaches the
    // same deferral every five minutes. Announcing every call would re-show a
    // card the user had dismissed, so only a transition is reported.
    if (this._needsReconcile !== value) {
      this._needsReconcile = value;
      this.emitEvent('needsReconcile', { needs: value });
    }
  }

  /* [ZeroLabs] 2026-08-27 - added: the user can switch automatic syncing off */
  // Default on, and only absent-means-on: an explicit false is the only way off,
  // so a storage read that comes back empty never silently disables syncing.
  async isAutoSyncEnabled() {
    const stored = await storageAdapter.get('bmz_auto_sync_enabled');
    return stored.bmz_auto_sync_enabled !== false;
  }

  /**
   * The merge check. Resolves to one of the four outcomes above.
   * @returns {Object} { changed, deferred, consent, addedLocally, pushed }
   */
  /* [ZeroLabs] 2026-08-27 - edited: callers that push for themselves can opt out */
  // The share window reconciles purely to make the local tree current before it
  // saves a bookmark and pushes. Publishing here as well meant every share wrote
  // to GitLab twice and bumped the version twice for one action.
  async reconcileWithSnippet({ push = true } = {}) {
    /* [ZeroLabs] 2026-08-27 - edited: log every exit path */
    // These returned silently, so a poll that ran and bailed was indistinguishable
    // from one that never fired at all - which is exactly the ambiguity that made
    // a missing poll hard to spot. Nobody is watching an automatic run, so every
    // way out of it has to leave a trace.
    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('[Reconcile] No snippet connected on this device');
      return { changed: false, deferred: false, skipped: 'no-snippet' };
    }
    if (!navigator.onLine) {
      console.log('[Reconcile] Offline, skipping');
      return { changed: false, deferred: false, skipped: 'offline' };
    }
    if (this.isSyncing) {
      console.log('[Reconcile] A sync is already running, skipping');
      return { changed: false, deferred: false, skipped: 'busy' };
    }

    console.log('[Reconcile] Running');
    this.isSyncing = true;

    try {
      const adapter = this.getAdapter();

      const rateLimitStatus = adapter.getRateLimitStatus();
      if (rateLimitStatus.remaining !== null && rateLimitStatus.remaining < 10) {
        const resetDate = new Date(rateLimitStatus.reset * 1000);
        throw new Error(`API rate limit nearly exhausted (${rateLimitStatus.remaining} remaining). Sync will retry after ${resetDate.toLocaleTimeString()}`);
      }

      /* [ZeroLabs] 2026-08-27 - added: converge pins on every reconcile */
      // Ahead of everything else, because pins can differ even when the
      // bookmarks themselves are identical.
      if (typeof window !== 'undefined' && window.bmzQuickAccessMeta) {
        await window.bmzQuickAccessMeta.loadForSnippet(remoteId).catch(err => {
          console.error('[QuickAccess] Pin sync failed:', err);
        });
      }

      const remote = await adapter.readBookmarks(remoteId);
      const remoteVersion = Number(remote?.version) || 0;
      let local = await this.loadLocalBookmarks();

      const remoteEntries = this.collectSnippetEntries(remote);
      const localEntries = this.collectSnippetEntries(local);

      const events = await storageAdapter.get([
        'snippet_local_created',
        'snippet_local_deleted',
        'snippet_local_edited'
      ]);
      const createdHere = new Set(events.snippet_local_created || []);
      const deletedHere = new Set(events.snippet_local_deleted || []);
      const editedHere = new Set(events.snippet_local_edited || []);

      const toAddLocally = [];        // in the snippet, not here, not deleted here
      const removesFromSnippet = [];  // in the snippet, not here, because you deleted it here
      /* [ZeroLabs] 2026-08-27 - edited: carry the folder path with each held item */
      // The dialogs list these, and a bare title is ambiguous the moment two
      // bookmarks share a name. The path is already known here.
      const pathOf = (entry) => [entry.rootKey].concat(entry.segments).join('/');

      remoteEntries.forEach((entry, url) => {
        if (localEntries.has(url)) return;
        if (deletedHere.has(url)) {
          removesFromSnippet.push({ url, title: entry.title, path: pathOf(entry) });
        } else {
          toAddLocally.push(entry);
        }
      });

      const removesFromDevice = [];   // here, not in the snippet, not added here
      let hasLocalAdditions = false;
      localEntries.forEach((entry, url) => {
        if (remoteEntries.has(url)) return;
        if (createdHere.has(url)) {
          hasLocalAdditions = true;
        } else {
          removesFromDevice.push({ url, title: entry.title, path: pathOf(entry) });
        }
      });

      /* [ZeroLabs] 2026-08-27 - added: renames and moves, deliberately asymmetric */
      //   edited HERE      -> you made the change and want it to travel. Push it.
      //   edited ELSEWHERE -> the snippet wants to overwrite a name or location on
      //                       this device. That is a change to data you may have
      //                       chosen, and nothing here can tell which is wanted,
      //                       so it waits for you exactly as a deletion does.
      //
      // The asymmetry is what removes the need for a baseline: your own unpushed
      // rename is always in the edit record, so it never prompts you about your
      // own change.
      let hasLocalEdits = false;
      const overwritesOnDevice = [];

      localEntries.forEach((localEntry, url) => {
        const remoteEntry = remoteEntries.get(url);
        if (!remoteEntry) return; // Additions are handled by the loops above

        const movedOrRenamed =
          localEntry.title !== remoteEntry.title ||
          localEntry.rootKey !== remoteEntry.rootKey ||
          localEntry.segments.join('/') !== remoteEntry.segments.join('/');
        if (!movedOrRenamed) return;

        if (editedHere.has(url)) {
          hasLocalEdits = true;
        } else {
          // rootKey and segments travel with it so the bookmark can be placed on
          // approval without re-deriving a path from a title.
          overwritesOnDevice.push({
            url,
            title: localEntry.title,
            remoteTitle: remoteEntry.title,
            localPath: [localEntry.rootKey].concat(localEntry.segments).join('/'),
            remotePath: [remoteEntry.rootKey].concat(remoteEntry.segments).join('/'),
            remoteRootKey: remoteEntry.rootKey,
            remoteSegments: remoteEntry.segments
          });
        }
      });

      /* [ZeroLabs] 2026-08-27 - edited: additions land BEFORE any deferral */
      // This used to sit after the deferral check, which meant a pending deletion
      // suppressed a perfectly safe addition - and worse, approving that deletion
      // then pushed a local tree that had never received it, deleting it from the
      // snippet. Local ABCDF against snippet ABCDE, approving the removal of F,
      // pushed ABCD and destroyed E.
      //
      // Adding is never destructive, so it is never a reason to wait. The rule is
      // that additions sync silently in both directions; that holds whether or not
      // something else in the same comparison needs consent.
      let addedLocally = 0;
      if (toAddLocally.length > 0) {
        addedLocally = await this.createSnippetItemsLocally(toAddLocally);
        console.log(`[Reconcile] Added ${addedLocally} item(s) from the snippet to this device`);
        local = await this.loadLocalBookmarks();
        this.emitEvent('localTreeChanged');
      }

      /* [ZeroLabs] 2026-08-27 - added: the safe additions, for the dialog to list */
      // Additions never need consent and are already applied by this point, but a
      // dialog appearing while bookmarks quietly arrive should account for them.
      // Approve also pushes, so this device's own additions travel with it.
      const addedHereItems = toAddLocally.slice(0, 200).map(e => ({
        url: e.url, title: e.title, path: pathOf(e)
      }));
      const pendingPushItems = [];
      localEntries.forEach((entry, url) => {
        if (!remoteEntries.has(url) && createdHere.has(url)) {
          pendingPushItems.push({ url, title: entry.title, path: pathOf(entry) });
        }
      });

      // Outcome 4: anything that removes or overwrites on either side waits.
      if (removesFromSnippet.length > 0 || removesFromDevice.length > 0 || overwritesOnDevice.length > 0) {
        await storageAdapter.set({
          snippet_push_held: true,
          snippet_push_held_items: removesFromSnippet.slice(0, 200),
          snippet_pull_held_items: removesFromDevice.slice(0, 200),
          snippet_overwrite_held_items: overwritesOnDevice.slice(0, 200),
          snippet_added_here_items: addedHereItems,
          snippet_pending_push_items: pendingPushItems.slice(0, 200),
        });
        await this.setSnippetNeedsReconcile(true);
        console.warn('[Reconcile] Deferred for consent', {
          wouldRemoveFromSnippet: removesFromSnippet.length,
          wouldRemoveFromDevice: removesFromDevice.length,
          wouldOverwriteOnDevice: overwritesOnDevice.length
        });
        return {
          changed: true,
          deferred: true,
          consent: true,
          removesFromSnippet,
          removesFromDevice,
          overwritesOnDevice,
          /* [ZeroLabs] 2026-08-27 - added: callers that render their own UI need these */
          // The consent dialogs read them back out of storage, but the share
          // window presents the deferral from this return value.
          addedHere: addedHereItems,
          pendingPush: pendingPushItems
        };
      }

      // Outcomes 2 and 3: push when this device has something the snippet lacks.
      if (!hasLocalAdditions && addedLocally === 0 && !hasLocalEdits) {
        await this.setLocalVersion(remoteVersion);
        await this.markPendingChanges(false);
        this.hasUnsyncedChanges = false;
        this.lastSyncTime = Date.now();
        await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });
        await this.clearHeldState();
        await this.clearLocalBookmarkEvents();
        await this.setSnippetNeedsReconcile(false);
        console.log('[Reconcile] Already in sync, version recorded as', remoteVersion);
        return { changed: false, deferred: false, addedLocally: 0, pushed: false };
      }

      /* [ZeroLabs] 2026-08-27 - added: leave publishing to the caller when asked */
      // The attribution records are deliberately NOT cleared here. They are what
      // marks this device's own additions as its own, and if the caller never
      // gets as far as pushing - the share window closed without saving - the
      // next reconcile still has to know they were yours rather than something
      // another device deleted.
      if (!push) {
        await this.clearHeldState();
        await this.setSnippetNeedsReconcile(false);
        console.log('[Reconcile] Local is current; publishing left to the caller');
        return { changed: true, deferred: false, addedLocally, pushed: false };
      }

      await adapter.updateBookmarks(remoteId, local, remoteVersion + 1);

      await this.setLocalVersion(remoteVersion + 1);
      await this.markPendingChanges(false);
      this.hasUnsyncedChanges = false;
      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });
      /* [ZeroLabs] 2026-08-27 - added: both sides agree, the records are spent */
      await this.clearHeldState();
      await this.clearLocalBookmarkEvents();
      await this.setSnippetNeedsReconcile(false);

      console.log('[Reconcile] Pushed bookmarks.json at version', remoteVersion + 1);
      return { changed: true, deferred: false, addedLocally, pushed: true };
    } catch (error) {
      console.error('[Reconcile] Failed:', error);

      if (error.message && error.message.includes('not found')) {
        safeLocalStorage.removeItem('bmz_snippet_id');
        await dbManager.delete('metadata', 'snippetId');
        this.snippetId = null;
        snippetAdapter.snippetId = null;
        this.emitEvent('syncError', {
          error: 'Remote storage not found. Please set up sync again.',
          requiresSetup: true
        });
      }

      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  async clearHeldState() {
    await storageAdapter.set({
      snippet_push_held: false,
      snippet_push_held_items: [],
      snippet_pull_held_items: [],
      snippet_overwrite_held_items: []
    });
  }

  async getHeldState() {
    const stored = await storageAdapter.get([
      'snippet_push_held',
      'snippet_push_held_items',
      'snippet_pull_held_items',
      'snippet_overwrite_held_items',
      'snippet_added_here_items',
      'snippet_pending_push_items'
    ]);
    return {
      held: !!stored.snippet_push_held,
      fromSnippet: stored.snippet_push_held_items || [],
      fromDevice: stored.snippet_pull_held_items || [],
      overwrites: stored.snippet_overwrite_held_items || [],
      /* [ZeroLabs] 2026-08-27 - added: the safe additions, for the dialogs to report */
      addedHere: stored.snippet_added_here_items || [],
      pendingPush: stored.snippet_pending_push_items || []
    };
  }

  /* [ZeroLabs] 2026-08-27 - added: carry out what the user approved */
  // Removals from this device and renames made elsewhere both change local data,
  // which is exactly why they waited. Applied here, then pushed, so the snippet
  // ends up carrying the other device's deletion as well.
  async applyHeldResolution({ fromDevice = [], overwrites = [] }) {
    const tree = await this.loadLocalBookmarks();
    if (!tree || !tree.roots) return { removed: 0, applied: 0 };

    const byUrl = new Map();
    const index = (node, parent, rootKey, segments) => {
      if (!node) return;
      if (node.url) {
        byUrl.set(node.url, { node, parent, rootKey, segments });
        return;
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(child => index(
          child,
          node,
          rootKey,
          child.url ? segments : segments.concat(child.title || child.name || 'Unnamed Folder')
        ));
      }
    };
    Object.keys(tree.roots).forEach(rootKey => {
      const root = tree.roots[rootKey];
      if (!root || !Array.isArray(root.children)) return;
      root.children.forEach(child => index(
        child,
        root,
        rootKey,
        child.url ? [] : [child.title || child.name || 'Unnamed Folder']
      ));
    });

    let removed = 0;
    for (const item of fromDevice) {
      const hit = byUrl.get(item.url);
      if (!hit) continue;
      const at = hit.parent.children.indexOf(hit.node);
      if (at !== -1) {
        hit.parent.children.splice(at, 1);
        removed++;
        // Logged so an approved deletion stays as undoable as any other
        await addChangelogEntry('delete', 'bookmark', hit.node.title || 'Untitled',
          hit.node.url || null, { fullData: hit.node });
      }
    }

    let applied = 0;
    for (const item of overwrites) {
      const hit = byUrl.get(item.url);
      if (!hit) continue;

      /* [ZeroLabs] 2026-08-27 - added: log approved renames and moves */
      // A rename made in BMZ's own edit dialog writes an 'update' entry and is
      // undoable from the changelog. One arriving through sync changed the
      // bookmark just as much and left no trace at all. Same vocabulary as the
      // edit dialog uses, so the changelog reads and undoes it identically.
      const oldTitle = hit.node.title;
      if (item.remoteTitle && hit.node.title !== item.remoteTitle) {
        hit.node.title = item.remoteTitle;
        await addChangelogEntry('update', 'bookmark', item.remoteTitle, item.url || null, {
          oldTitle,
          newTitle: item.remoteTitle
        });
      }

      if (item.localPath !== item.remotePath && Array.isArray(item.remoteSegments)) {
        const destRoot = tree.roots[item.remoteRootKey] || tree.roots.other;
        if (destRoot) {
          if (!Array.isArray(destRoot.children)) destRoot.children = [];
          let parent = destRoot;
          for (const segment of item.remoteSegments) {
            let next = parent.children.find(child =>
              child.type === 'folder' && (child.title || child.name) === segment);
            if (!next) {
              next = {
                id: this.generateLocalId(),
                title: segment,
                name: segment,
                type: 'folder',
                dateAdded: Date.now(),
                children: []
              };
              parent.children.push(next);
            }
            if (!Array.isArray(next.children)) next.children = [];
            parent = next;
          }
          const at = hit.parent.children.indexOf(hit.node);
          if (at !== -1) hit.parent.children.splice(at, 1);
          parent.children.push(hit.node);
          await addChangelogEntry('move', 'bookmark', item.remoteTitle || oldTitle, item.url || null, {
            fromFolder: item.localPath,
            toFolder: item.remotePath
          });
        }
      }

      applied++;
    }

    tree.lastModified = Date.now();
    await this.saveLocalBookmarks(tree);
    this.emitEvent('localTreeChanged');

    // The approved changes came FROM the snippet, so they must not be recorded
    // as this device's own or the next reconcile would try to push them back.
    await this.clearLocalBookmarkEvents();

    return { removed, applied };
  }

  /* [ZeroLabs] 2026-08-27 - added: write this device's tree to the snippet */
  // Purely "write what is here". Deciding whether that is safe belongs to the
  // reconcile, and every caller reaches here having already made that decision:
  // the reconcile after it clears, the consent dialog after you approve, the
  // overwrite button after you confirm.
  async pushLocalToSnippet() {
    const remoteId = this.getRemoteId();
    if (!remoteId) throw new Error('No Snippet connected');

    const adapter = this.getAdapter();
    const local = await this.loadLocalBookmarks();
    const remote = await adapter.readBookmarks(remoteId);
    const remoteVersion = Number(remote?.version) || 0;

    await adapter.updateBookmarks(remoteId, local, remoteVersion + 1);

    await this.setLocalVersion(remoteVersion + 1);
    await this.markPendingChanges(false);
    this.hasUnsyncedChanges = false;
    this.lastSyncTime = Date.now();
    await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });
    await this.clearHeldState();
    await this.clearLocalBookmarkEvents();
    await this.setSnippetNeedsReconcile(false);

    return this.countBookmarksInTree(local);
  }

  /* [ZeroLabs] 2026-08-27 - added: the website's stand-in for the worker's poll */
  // The extensions poll on a chrome.alarms schedule that survives the panel being
  // closed. The website has no such thing - the page is either open or it is not -
  // so this is simply an interval, on the same five minutes, that stops mattering
  // the moment the tab goes away.
  startReconcilePoll() {
    if (this._reconcilePollId) return;

    const PERIOD_MS = 5 * 60 * 1000;
    console.log('[Reconcile] Polling every 5 minutes');
    this._reconcilePollId = setInterval(async () => {
      if (!navigator.onLine || this.isSyncing || !this.getRemoteId()) {
        console.log('[Reconcile] Poll tick skipped', {
          offline: !navigator.onLine, busy: this.isSyncing, noSnippet: !this.getRemoteId()
        });
        return;
      }
      // Checked every tick rather than once, so flipping the toggle takes effect
      // without needing the page reloaded.
      if (!(await this.isAutoSyncEnabled())) {
        console.log('[Reconcile] Poll tick skipped: automatic syncing is switched off');
        return;
      }

      try {
        const token = await authManager.getToken('gitlab');
        if (token) {
          const result = await supabaseManager.checkAndRotateIfNeeded(token);
          if (result.needsRotation) {
            this.emitEvent('tokenExpiring', { daysLeft: result.daysLeft, token: result.currentToken });
          }
        }
      } catch (error) {
        console.error('[Reconcile] Token check failed:', error);
      }

      try {
        await this.reconcileWithSnippet();
      } catch (error) {
        console.error('[Reconcile] Scheduled reconcile failed:', error);
      }
    }, PERIOD_MS);
  }

  stopReconcilePoll() {
    if (this._reconcilePollId) {
      clearInterval(this._reconcilePollId);
      this._reconcilePollId = null;
    }
  }

  /**
   * Acquire edit lock before making changes
   * Prevents concurrent edits across devices
   */
  async acquireLock() {
    if (!navigator.onLine) {
      // Offline: allow edits but mark as pending
      await this.markPendingChanges(true);
      console.log('Offline mode: changes marked as pending');
      return { offline: true };
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.warn('No remote ID - cannot acquire lock');
      return { error: true };
    }

    try {
      // Read current remote data
      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);
      const currentLock = remoteData.editLock;

      // Check if locked by another device
      if (currentLock && currentLock.deviceId !== this.deviceId) {
        throw new Error(
          `Bookmarks are currently being edited on another device. ` +
          `Please wait a moment and try again.`
        );
      }

      // Acquire/refresh lock
      remoteData.editLock = {
        deviceId: this.deviceId,
        timestamp: Date.now()
      };

      await adapter.updateBookmarks(remoteId, remoteData, remoteData.version);
      console.log('Edit lock acquired for device:', this.deviceId);

      // Return the remote data so caller doesn't need to fetch again
      return { success: true, remoteData };
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      throw error;
    }
  }

  /**
   * Release edit lock
   */
  async releaseLock() {
    const remoteId = this.getRemoteId();
    if (!navigator.onLine || !remoteId) {
      return;
    }

    try {
      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);

      if (remoteData.editLock?.deviceId === this.deviceId) {
        delete remoteData.editLock;
        await adapter.updateBookmarks(remoteId, remoteData, remoteData.version);
        console.log('Edit lock released');
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
    }
  }

  /**
   * Mark that local changes need to be synced
   */
  async markChanged() {
    console.log('[MarkChanged] Setting hasUnsyncedChanges = true');
    this.hasUnsyncedChanges = true;
    await this.markPendingChanges(true);

    // Trigger sync if online
    if (navigator.onLine) {
      // Debounce sync to avoid too many requests
      if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
      }
      this.syncDebounceTimer = setTimeout(async () => {
        // Check if we still have a valid remote ID before syncing
        if (!this.getRemoteId()) {
          console.log('[MarkChanged] No remote ID, skipping sync');
          return;
        }

        /* [ZeroLabs] 2026-08-27 - edited: reconcile instead of blindly pushing */
        // This used to call syncToRemote, which writes this device's whole tree
        // over the snippet. Anything another device had added and this one had
        // not yet seen went with it. The reconcile reads first, adds what is
        // missing here, and defers rather than removing anything.
        if (!(await this.isAutoSyncEnabled())) {
          console.log('[MarkChanged] Automatic syncing is switched off');
          return;
        }

        try {
          await this.reconcileWithSnippet();
        } catch (error) {
          console.error('Sync failed:', error);
          this.emitEvent('syncError', error.message || 'Failed to sync changes');
          // Retry after 5 seconds
          setTimeout(() => {
            if (this.hasUnsyncedChanges && navigator.onLine && this.getRemoteId()) {
              this.reconcileWithSnippet().catch(err => {
                console.error('Retry sync failed:', err);
                this.emitEvent('syncError', 'Sync retry failed. Changes will sync when connection improves.');
              });
            }
          }, 5000);
        }
      }, 30000); // Wait 30 seconds after last change to batch multiple edits and avoid abuse detection
    }
  }

  /**
   * Sync local changes to remote (push)
   * @param {boolean} force - Explicit user-triggered push: bypass rate-limit wait and version conflict (browser wins)
   */
  /* [ZeroLabs] 2026-06-09 11:03 AM - edited: force param for manual push */
  async syncToRemote(force = false) {
    console.log('[SyncToRemote] Called, checking conditions...');

    if (this.isSyncing) {
      console.log('[SyncToRemote] Sync already in progress, skipping...');
      return;
    }

    if (!navigator.onLine) {
      console.log('[SyncToRemote] Offline, cannot sync to remote');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('[SyncToRemote] No remote ID, cannot sync');
      return;
    }

    // Rate limiting: prevent syncing more frequently than minSyncInterval (skipped on explicit force)
    /* [ZeroLabs] 2026-06-09 11:03 AM - edited: skip rate-limit wait on force */
    const timeSinceLastSync = Date.now() - (this.lastSyncTime || 0);
    if (!force && this.lastSyncTime && timeSinceLastSync < this.minSyncInterval) {
      const waitTime = Math.ceil((this.minSyncInterval - timeSinceLastSync) / 1000);
      console.log(`[SyncToRemote] Rate limit: Last sync was ${Math.ceil(timeSinceLastSync / 1000)}s ago. Please wait ${waitTime}s before syncing again.`);
      this.emitEvent('syncError', `Please wait ${waitTime} seconds before syncing again to avoid rate limits`);
      return;
    }

    console.log(`[SyncToRemote] All conditions passed. Provider: ${this.provider}, Remote ID: ${remoteId}`);
    this.isSyncing = true;

    // Cancel any pending debounced sync since we're doing an explicit sync now
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
      console.log('[SyncToRemote] Cancelled pending debounced sync');
    }

    try {
      console.log(`[SyncToRemote] Starting sync of local changes to ${this.provider}...`);

      // Check rate limits before syncing
      const adapter = this.getAdapter();
      const rateLimitStatus = adapter.getRateLimitStatus();
      if (rateLimitStatus.remaining !== null && rateLimitStatus.remaining < 10) {
        const resetDate = new Date(rateLimitStatus.reset * 1000);
        throw new Error(`API rate limit nearly exhausted (${rateLimitStatus.remaining} remaining). Sync will retry after ${resetDate.toLocaleTimeString()}`);
      }

      // Load local bookmark tree
      const localBookmarks = await this.loadLocalBookmarks();
      const bookmarkCount = this.countBookmarksInTree(localBookmarks);
      console.log(`[SyncToRemote] Loaded local bookmarks: ${bookmarkCount} total bookmarks`);

      // Get remote version (single read, no locking to reduce API calls)
      const remoteData = await adapter.readBookmarks(remoteId);
      const localVersion = await this.getLocalVersion();

      console.log(`[SyncToRemote] Version check - Local: ${localVersion}, Remote: ${remoteData.version}`);

      // Check for conflicts (explicit force push overrides: browser wins)
      /* [ZeroLabs] 2026-06-09 11:03 AM - edited: allow force to override conflict */
      if (remoteData.version > localVersion && !force) {
        console.warn('[SyncToRemote] Remote has newer changes! Conflict detected.');
        throw new Error('Sync conflict: Remote has newer changes. Please reload and try again.');
      }

      // Push local changes
      const newVersion = remoteData.version + 1;
      console.log(`[SyncToRemote] Pushing ${bookmarkCount} bookmarks to remote with version ${newVersion}...`);
      await adapter.updateBookmarks(remoteId, localBookmarks, newVersion);

      // Update local metadata
      await this.setLocalVersion(newVersion);
      await this.markPendingChanges(false);
      console.log('[SyncToRemote] Setting hasUnsyncedChanges = false');
      this.hasUnsyncedChanges = false;
      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

      console.log(`[SyncToRemote] Sync complete! Version ${newVersion} with ${bookmarkCount} bookmarks pushed to remote`);

      // Explicit force push has no outer wrapper to report success - emit here
      /* [ZeroLabs] 2026-06-09 11:03 AM - added: success feedback on force push */
      if (force) {
        this.emitEvent('syncSuccess', `Pushed ${bookmarkCount} bookmarks to cloud`);
      }
    } catch (error) {
      console.error('Sync to remote failed:', error);

      // If the error is a 404 (Snippet not found), stop syncing
      if (error.message && error.message.includes('not found')) {
        console.warn('[SyncToRemote] Remote not found (404), aborting sync and clearing stored ID');
        this.hasUnsyncedChanges = false; // Clear the flag to prevent retry loops

        // Clear the stored snippet ID
        safeLocalStorage.removeItem('bmz_snippet_id');
        await dbManager.delete('metadata', 'snippetId');
        this.snippetId = null;
        snippetAdapter.snippetId = null;

        // Emit event to notify UI that setup is needed
        this.emitEvent('syncError', {
          error: 'Remote storage not found. Please set up sync again.',
          requiresSetup: true
        });
      }

      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Calculate diff between local and remote bookmark trees
   * Returns: { added: [], removed: [], moved: [], modified: [] }
   */
  calculateBookmarkDiff(localTree, remoteTree) {
    const diff = {
      added: [],
      removed: [],
      moved: [],
      modified: []
    };

    // Create ID maps for quick lookup
    const localMap = new Map();
    const remoteMap = new Map();

    const rootFolderIds = ['toolbar_____', 'menu________', 'unfiled_____', 'mobile______', 'root________', '0', '1', '2', '3'];

    // Normalize folder titles to handle Chrome vs Firefox naming differences
    // IMPORTANT: Must use same normalization as Chrome/Firefox for cross-browser sync
    const normalizeTitle = (title) => {
      // Treat empty string and "Untitled" as equivalent (empty)
      if (!title || title === 'Untitled' || title === 'Untitled Folder') {
        return '';
      }

      const normalized = {
        'Bookmarks Toolbar': 'Bookmarks bar',   // Firefox → Chrome standard
        'Bookmarks bar': 'Bookmarks bar',        // Chrome → Chrome standard
        'Other Bookmarks': 'Other bookmarks',    // Normalize to Chrome's lowercase
        'Other bookmarks': 'Other bookmarks',    // Chrome → Chrome standard
        'Mobile Bookmarks': 'Mobile Bookmarks',
        'Bookmarks Menu': 'Bookmarks Menu'
      };
      return normalized[title] || title;
    };

    /* [ZeroLabs] 2026-08-18 12:32 AM - added: match browser-rewritten internal URLs (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
    // BMZ stores and transmits every URL verbatim, but chrome.bookmarks.create
    // canonicalizes browser-internal URLs before writing them, so a bookmark
    // pushed as about:debugging#/runtime/this-firefox comes back from Chrome as
    // chrome://debugging/#/runtime/this-firefox. Nothing in BMZ changed it and
    // neither did the user, so the diff must not report it as an edit.
    //
    // Comparison only. Nothing is rewritten, stored, or applied.
    const normalizeUrlForDiff = (url) => {
      if (!url) return url;
      const scheme = /^(about:|chrome:\/\/)/i.exec(url);
      if (!scheme) return url; // Ordinary URLs are compared exactly as before

      let rest = url.slice(scheme[0].length);
      // chrome:// parses the first segment as a host and gives it a trailing
      // slash that the opaque about: form does not have
      rest = rest.replace(/\/(?=#)/, '').replace(/\/$/, '');
      return `internal:${rest.toLowerCase()}`;
    };

    // Recursively map all items by content-based key (not ID, since different browsers use different IDs)
    const mapItems = (node, map, parentPath = '') => {
      if (!node) return;

      // Normalize title for consistent paths, then build path
      const normalizedTitle = normalizeTitle(node.title || '');
      const path = parentPath ? `${parentPath}/${normalizedTitle}` : normalizedTitle;

      // Don't include root folders themselves in the comparison, only their contents
      if (!rootFolderIds.includes(node.id)) {
        // Use content-based key instead of ID
        const isBookmark = node.url || node.type === 'bookmark';
        const key = isBookmark
          ? `bookmark:${normalizeUrlForDiff(node.url)}:${path}`
          : `folder:${path}`;

        map.set(key, { node, path, parentId: node.parentId, originalId: node.id });
      }

      if (node.children) {
        node.children.forEach(child => mapItems(child, map, path));
      }
    };

    // Map local tree
    if (localTree?.roots) {
      Object.values(localTree.roots).forEach(root => mapItems(root, localMap));
    }

    // Map remote tree
    if (remoteTree?.roots) {
      Object.values(remoteTree.roots).forEach(root => mapItems(root, remoteMap));
    }

    // Find added items (in remote, not in local)
    remoteMap.forEach((value, key) => {
      if (!localMap.has(key)) {
        diff.added.push({
          id: value.originalId,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find removed items (in local, not in remote)
    localMap.forEach((value, key) => {
      if (!remoteMap.has(key)) {
        diff.removed.push({
          id: value.originalId,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find moved/modified items
    localMap.forEach((localValue, key) => {
      const remoteValue = remoteMap.get(key);
      if (remoteValue) {
        // Check if the path changed (item moved to different folder)
        if (localValue.path !== remoteValue.path) {
          diff.moved.push({
            id: localValue.originalId,
            title: remoteValue.node.title || 'Untitled',
            url: remoteValue.node.url || null,
            oldPath: localValue.path,
            newPath: remoteValue.path,
            type: remoteValue.node.url ? 'bookmark' : 'folder'
          });
        }
        // Check if modified (different title or URL)
        // Normalize titles to ignore differences like empty string vs "Untitled"
        const normalizedLocalTitle = normalizeTitle(localValue.node.title || '');
        const normalizedRemoteTitle = normalizeTitle(remoteValue.node.title || '');
        const titleDiffers = normalizedLocalTitle !== normalizedRemoteTitle;
        /* [ZeroLabs] 2026-08-18 12:32 AM - edited: ignore browser-rewritten internal URLs */
        // Same normalization as the content key above. Without it the pair
        // matches as the same bookmark and then immediately reports as an edit.
        const urlDiffers = normalizeUrlForDiff(localValue.node.url) !== normalizeUrlForDiff(remoteValue.node.url);
        if (titleDiffers || urlDiffers) {
          diff.modified.push({
            id: localValue.originalId,
            oldTitle: localValue.node.title || 'Untitled',
            newTitle: remoteValue.node.title || 'Untitled',
            oldUrl: localValue.node.url || null,
            newUrl: remoteValue.node.url || null,
            path: remoteValue.path,
            type: remoteValue.node.url ? 'bookmark' : 'folder'
          });
        }
      }
    });

    return diff;
  }

  /**
   * Sync remote changes to local (pull)
   * @param {boolean} force - Force pull even if versions match (explicit user-triggered pull, cloud wins)
   */
  /* [ZeroLabs] 2026-08-09 1:31 PM - edited: throwOnError param for share flow */
  async syncFromRemote(force = false, throwOnError = false) {
    if (this.isSyncing) {
      console.log('[SyncFromRemote] Already syncing, skipping...');
      return;
    }

    if (!navigator.onLine) {
      console.log('[SyncFromRemote] Offline, skipping...');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('[SyncFromRemote] No remote ID, skipping...');
      return;
    }

    this.isSyncing = true;

    try {
      console.log(`[SyncFromRemote] Starting sync for ${this.provider}:`, remoteId);

      // Check rate limits before syncing
      const adapter = this.getAdapter();
      const rateLimitStatus = adapter.getRateLimitStatus();
      if (rateLimitStatus.remaining !== null && rateLimitStatus.remaining < 10) {
        const resetDate = new Date(rateLimitStatus.reset * 1000);
        throw new Error(`API rate limit nearly exhausted (${rateLimitStatus.remaining} remaining). Sync will retry after ${resetDate.toLocaleTimeString()}`);
      }

      /* [ZeroLabs] 2026-08-18 12:32 AM - added: converge pins on every pull (see also: Bookmark-Manager-Zero-Firefox/sidebar.js) */
      // Pins can differ even when the bookmarks themselves are identical, so
      // this runs regardless of whether the tree turns out to have changed.
      if (typeof window !== 'undefined' && window.bmzQuickAccessMeta) {
        await window.bmzQuickAccessMeta.loadForSnippet(remoteId).catch(err => {
          console.error('[QuickAccess] Pin sync failed:', err);
        });
      }

      const remoteData = await adapter.readBookmarks(remoteId);
      const remoteBookmarkCount = this.countBookmarksInTree(remoteData);
      console.log('[SyncFromRemote] Remote data fetched:', {
        hasRoots: !!remoteData?.roots,
        rootKeys: remoteData?.roots ? Object.keys(remoteData.roots) : [],
        version: remoteData?.version,
        bookmarkCount: remoteBookmarkCount
      });

      const localData = await this.loadLocalBookmarks();
      const localBookmarkCount = this.countBookmarksInTree(localData);
      const localVersion = await this.getLocalVersion();
      console.log('[SyncFromRemote] Local version:', localVersion, 'Local bookmarks:', localBookmarkCount);

      // Sync if remote is newer, local is empty (version 0), OR a manual force pull was requested
      /* [ZeroLabs] 2026-06-09 11:03 AM - edited: honor force on equal-version pull */
      if (remoteData.version > localVersion || localVersion === 0 || force) {
        console.log(`[SyncFromRemote] Pulling changes (remote: ${remoteData.version}, local: ${localVersion}, force: ${force})...`);

        // Get current local data for diff
        const localData = await this.getLocalBookmarks();

        // Calculate diff
        const diff = this.calculateBookmarkDiff(localData, remoteData);
        console.log('[SyncFromRemote] Changes detected:', {
          added: diff.added.length,
          removed: diff.removed.length,
          moved: diff.moved.length,
          modified: diff.modified.length,
          localVersion: localVersion,
          localBookmarkCount: localBookmarkCount
        });

        // If local version is 0 (first sync/reset), skip conflict detection - just pull everything
        const isFirstSync = localVersion === 0;

        if (isFirstSync) {
          console.log('[SyncFromRemote] First sync detected (version 0) - skipping conflict check, auto-pulling all data');
        }

        // Check if there are deletions AND this is not the first sync - require user confirmation
        if (diff.removed.length > 0 && !isFirstSync) {
          console.log('[SyncFromRemote] Deletions detected on subsequent sync - requiring user confirmation');
          // Emit event with diff data for UI to handle
          /* [ZeroLabs] 2026-08-19 7:12 PM - edited: pass the totals through */
          // Both counts are already computed above. The share window shows them
          // so the choice can be made against how big each side actually is,
          // not just the shape of the difference.
          this.emitEvent('syncConflict', {
            diff,
            remoteData,
            requiresConfirmation: true,
            localCount: localBookmarkCount,
            remoteCount: remoteBookmarkCount,
            message: `Remote has ${diff.removed.length} deletion(s). Review changes before syncing.`
          });

          this.isSyncing = false;
          return false; // Don't auto-sync, wait for user confirmation
        }

        // Save remote data to local BEFORE emitting event
        await this.saveLocalBookmarks(remoteData);
        console.log('[SyncFromRemote] Saved remote data to IndexedDB');

        await this.setLocalVersion(remoteData.version);
        console.log('[SyncFromRemote] Updated local version to:', remoteData.version);

        this.lastSyncTime = Date.now();
        await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

        // No deletions - notify UI after data is saved
        if (diff.added.length > 0 || diff.moved.length > 0 || diff.modified.length > 0) {
          // Emit event with diff data (after save so UI can reload)
          this.emitEvent('syncChanges', {
            diff,
            remoteData,
            requiresConfirmation: false,
            message: `Remote has ${diff.added.length} addition(s), ${diff.moved.length} move(s), ${diff.modified.length} modification(s).`
          });
        } else if (force) {
          // Forced pull with identical data - still give the user explicit feedback
          /* [ZeroLabs] 2026-06-09 11:03 AM - added: feedback on no-change force pull */
          this.emitEvent('syncSuccess', 'Already in sync with cloud');
        }

        console.log('[SyncFromRemote] Sync complete, version:', remoteData.version);
        return true; // Indicate that data was updated
      } else {
        // Versions match - but the version counter is unreliable across clients
        // (extensions rewrite the snippet without always bumping it). Do a cheap
        // content check so we don't falsely report "up to date" when data differs.
        /* [ZeroLabs] 2026-06-20 10:47 AM - added: content-diff nudge on equal version */
        const diff = this.calculateBookmarkDiff(localData, remoteData);
        const changeCount = diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length;

        if (changeCount > 0) {
          console.log('[SyncFromRemote] Versions match but content differs:', {
            added: diff.added.length, removed: diff.removed.length,
            moved: diff.moved.length, modified: diff.modified.length
          });

          // Non-destructive nudge. Dedupe by remote signature so 5-min polling
          // doesn't repeat the toast every cycle (resets on reload).
          const signature = `${remoteData.version}:${changeCount}:${remoteBookmarkCount}`;
          if (this._lastDivergeNudge !== signature) {
            this._lastDivergeNudge = signature;
            /* [ZeroLabs] 2026-08-19 7:12 PM - edited: structured payload with totals */
            // Was a bare string. Now an object so the share window can build its
            // own wording and show the totals; the toast still uses .message.
            this.emitEvent('syncNudge', {
              message: `Cloud differs from this device (${diff.added.length} to pull, ${diff.removed.length} only here). Open GitLab sync to reconcile.`,
              diff,
              localCount: localBookmarkCount,
              remoteCount: remoteBookmarkCount
            });
          }
          return false;
        }

        console.log('[SyncFromRemote] Local is up to date (local:', localVersion, ', remote:', remoteData.version, ')');
        this._lastDivergeNudge = null;
        return false;
      }
    } catch (error) {
      console.error('[SyncFromRemote] Sync failed:', error);

      // If the error is a 404 (Snippet not found), clear the stored ID
      if (error.message && error.message.includes('not found')) {
        console.warn('[SyncFromRemote] Remote not found (404), clearing stored ID');

        safeLocalStorage.removeItem('bmz_snippet_id');
        await dbManager.delete('metadata', 'snippetId');
        this.snippetId = null;
        snippetAdapter.snippetId = null;

        // Emit event to notify UI that setup is needed
        this.emitEvent('syncError', {
          error: 'Remote storage not found. Please set up sync again.',
          requiresSetup: true
        });
      }

      /* [ZeroLabs] 2026-08-09 1:31 PM - added: surface real reason to share flow */
      if (throwOnError) throw error;

      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Apply remote sync manually (after user confirmation)
   */
  async applyRemoteSync(remoteData) {
    try {
      /* [ZeroLabs] 2026-08-27 - added: snapshot before a destructive overwrite (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
      // This replaces every bookmark on the device, and it was the only such
      // action in BMZ with no way back. The extensions have taken a snapshot
      // here for a long time; the website never did - while ALREADY carrying the
      // full restore path for it, rendering 'pre-sync-snapshot' entries and
      // rebuilding the tree from details.snapshot. The safety net was built and
      // unreachable because nothing ever created the entry.
      //
      // The changelog is cleared first because every entry in it points at
      // bookmarks that are about to stop existing, which is what the extensions
      // do and what the restore handler does on the way back.
      try {
        const preSyncSnapshot = await this.loadLocalBookmarks();
        await clearChangelog();
        await addChangelogEntry('pre-sync-snapshot', 'sync', 'Pull Remote to Local', null, {
          snapshot: preSyncSnapshot,
          timestamp: Date.now(),
          operation: 'Pull Remote to Local'
        });
      } catch (snapshotError) {
        // A snapshot that cannot be taken must not block the sync the user asked
        // for, but they should know the way back is missing.
        console.error('[ApplyRemoteSync] Could not take a pre-sync snapshot:', snapshotError);
        this.emitEvent('syncError', 'Could not save a restore point before overwriting.');
      }

      // Save remote data to local
      await this.saveLocalBookmarks(remoteData);
      console.log('[ApplyRemoteSync] Saved remote data to IndexedDB');

      await this.setLocalVersion(remoteData.version);
      console.log('[ApplyRemoteSync] Updated local version to:', remoteData.version);

      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

      /* [ZeroLabs] 2026-08-27 - added: taking the snippet wholesale settles everything */
      // Nothing in the result is this device's change any more, so the records of
      // what it did are spent. Left in place they would be compared against a tree
      // that no longer contains them and every one would read as a deletion.
      await this.clearLocalBookmarkEvents();
      await this.clearHeldState();
      await this.setSnippetNeedsReconcile(false);
      this.hasUnsyncedChanges = false;
      await this.markPendingChanges(false);

      console.log('[ApplyRemoteSync] Manual sync applied successfully');
      this.emitEvent('syncSuccess', 'Bookmarks updated from remote');

      return true;
    } catch (error) {
      console.error('[ApplyRemoteSync] Failed to apply sync:', error);
      this.emitEvent('syncError', error.message);
      return false;
    }
  }

  /**
   * Get local bookmarks (alias for loadLocalBookmarks for diff calculation)
   */
  async getLocalBookmarks() {
    return await this.loadLocalBookmarks();
  }

  /**
   * Load bookmarks from IndexedDB
   */
  async loadLocalBookmarks() {
    const bookmarksRecord = await dbManager.get('metadata', 'bookmarkTree');
    const result = bookmarksRecord ? bookmarksRecord.value : this.getEmptyBookmarkTree();
    return result;
  }

  /**
   * Save bookmarks to IndexedDB
   */
  async saveLocalBookmarks(bookmarkTree) {
    console.log('[SyncManager.saveLocalBookmarks] Saving bookmarks to IndexedDB:', bookmarkTree);
    try {
      await dbManager.put('metadata', { key: 'bookmarkTree', value: bookmarkTree });
      console.log('[SyncManager.saveLocalBookmarks] Successfully saved');
    } catch (error) {
      console.error('[SyncManager.saveLocalBookmarks] Failed to save:', error);
      throw error;
    }
  }

  /**
   * Get local version number
   */
  async getLocalVersion() {
    const versionRecord = await dbManager.get('metadata', 'localVersion');
    return versionRecord ? versionRecord.value : 0;
  }

  /**
   * Set local version number
   */
  async setLocalVersion(version) {
    await dbManager.put('metadata', { key: 'localVersion', value: version });
  }

  /**
   * Merge bookmarks from one tree into another tree
   * Preserves folder structure and merges into existing folders with same names
   */
  mergeBookmarksIntoTree(sourceTree, targetTree) {
    try {
      console.log('[mergeBookmarksIntoTree] Merging bookmarks with folder structure preservation...');

      // Create a deep copy of the target tree
      const mergedTree = JSON.parse(JSON.stringify(targetTree));

      // Ensure target tree has roots
      if (!mergedTree.roots) {
        mergedTree.roots = {
          bookmark_bar: { id: '1', title: 'Bookmarks Toolbar', type: 'folder', children: [] },
          menu: { id: '2', title: 'Bookmarks Menu', type: 'folder', children: [] },
          other: { id: '3', title: 'Other Bookmarks', type: 'folder', children: [] },
          mobile: { id: '4', title: 'Mobile Bookmarks', type: 'folder', children: [] }
        };
      }

      // Helper function to find folder by title in a root folder
      const findFolderByTitle = (children, title) => {
        if (!children) return null;
        return children.find(child => child.type === 'folder' && child.title === title);
      };

      // Helper function to recursively regenerate IDs for all nodes in a subtree
      const regenerateIds = (node) => {
        node.id = `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        node.dateAdded = Date.now();
        if (node.children) {
          node.children.forEach(regenerateIds);
        }
        return node;
      };

      // Helper function to merge source folder into target folder
      const mergeFolder = (sourceFolder, targetParentChildren) => {
        const existingFolder = findFolderByTitle(targetParentChildren, sourceFolder.title);

        if (existingFolder) {
          // Folder exists, merge contents
          console.log(`[mergeBookmarksIntoTree] Merging into existing folder: ${sourceFolder.title}`);
          if (sourceFolder.children) {
            // Recursively merge each child
            sourceFolder.children.forEach(child => {
              if (child.type === 'folder') {
                mergeFolder(child, existingFolder.children);
              } else if (child.url) {
                // Add bookmark if it doesn't already exist (by URL)
                const bookmarkExists = existingFolder.children?.some(existingChild =>
                  existingChild.url === child.url
                );
                if (!bookmarkExists) {
                  if (!existingFolder.children) existingFolder.children = [];
                  existingFolder.children.push({
                    ...child,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // New ID
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added bookmark: ${child.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark: ${child.title}`);
                }
              }
            });
          }
        } else {
          // Folder doesn't exist, add entire folder structure with regenerated IDs
          console.log(`[mergeBookmarksIntoTree] Adding new folder: ${sourceFolder.title}`);
          const newFolder = regenerateIds(JSON.parse(JSON.stringify(sourceFolder)));
          targetParentChildren.push(newFolder);
        }
      };

      // Handle both tree structures (with roots) and flat arrays (legacy)
      if (sourceTree && sourceTree.roots) {
        // Source is a tree structure - merge each root
        console.log('[mergeBookmarksIntoTree] Merging tree structure...');

        ['bookmark_bar', 'menu', 'other', 'mobile'].forEach(rootKey => {
          const sourceRoot = sourceTree.roots[rootKey];
          const targetRoot = mergedTree.roots[rootKey];

          if (sourceRoot && sourceRoot.children && targetRoot) {
            if (!targetRoot.children) {
              targetRoot.children = [];
            }

            sourceRoot.children.forEach(child => {
              if (child.type === 'folder') {
                mergeFolder(child, targetRoot.children);
              } else if (child.url) {
                // Add bookmark if it doesn't already exist (by URL)
                const bookmarkExists = targetRoot.children.some(existingChild =>
                  existingChild.url === child.url
                );
                if (!bookmarkExists) {
                  targetRoot.children.push({
                    ...child,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added bookmark to ${rootKey}: ${child.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark in ${rootKey}: ${child.title}`);
                }
              }
            });
          }
        });
      } else if (sourceTree && Array.isArray(sourceTree)) {
        // Legacy: Source is a flat array - categorize into roots
        console.log('[mergeBookmarksIntoTree] Merging flat array...');

        const sourceRoots = {
          bookmark_bar: [],
          menu: [],
          other: [],
          mobile: []
        };

        sourceTree.forEach(bookmark => {
          if (bookmark.type === 'folder') {
            let targetRoot = 'other';
            const title = bookmark.title?.toLowerCase() || '';
            if (title.includes('toolbar') || title.includes('bar')) {
              targetRoot = 'bookmark_bar';
            } else if (title.includes('menu')) {
              targetRoot = 'menu';
            }
            sourceRoots[targetRoot].push(bookmark);
          } else if (bookmark.url) {
            sourceRoots.other.push(bookmark);
          }
        });

        Object.keys(sourceRoots).forEach(rootKey => {
          const sourceItems = sourceRoots[rootKey];
          const targetRoot = mergedTree.roots[rootKey];

          if (sourceItems.length > 0 && targetRoot && targetRoot.children) {
            sourceItems.forEach(item => {
              if (item.type === 'folder') {
                mergeFolder(item, targetRoot.children);
              } else if (item.url) {
                const bookmarkExists = targetRoot.children.some(existingChild =>
                  existingChild.url === item.url
                );
                if (!bookmarkExists) {
                  targetRoot.children.push({
                    ...item,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added individual bookmark to ${rootKey}: ${item.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark in ${rootKey}: ${item.title}`);
                }
              }
            });
          }
        });
      }

      console.log('[mergeBookmarksIntoTree] Merge complete with folder structure preservation');
      return mergedTree;
    } catch (error) {
      console.error('[mergeBookmarksIntoTree] Error:', error);
      throw error;
    }
  }

  /**
   * Mark pending changes flag
   */
  async markPendingChanges(hasPending) {
    await dbManager.put('metadata', { key: 'hasPendingChanges', value: hasPending });
  }

  /**
   * Check if there are pending changes
   */
  async hasPendingChanges() {
    const record = await dbManager.get('metadata', 'hasPendingChanges');
    return record ? record.value : false;
  }

  /**
   * Set Snippet ID (GitLab)
   */
  async setSnippetId(snippetId) {
    this.snippetId = snippetId;
    this.provider = 'gitlab';

    snippetAdapter.setSnippetId(snippetId);
    await dbManager.put('metadata', { key: 'snippetId', value: snippetId });
    await this.setProvider('gitlab');
    console.log('Snippet ID saved:', snippetId);

    /* [ZeroLabs] 2026-08-27 - added: start polling the moment a snippet exists */
    // showMainApp starts the poll, but it returns early when no snippet is
    // connected yet so it can show the setup dialog - which means connecting one
    // during that session never started polling, and nothing synced until the
    // next reload. Every connect path passes through here, and the call is
    // idempotent, so this is the one place that cannot be missed.
    if (typeof window === 'undefined' || !window.__bmzShareMode) {
      this.startReconcilePoll();
    }
  }

  /**
   * Count total bookmarks in a tree (for logging)
   */
  countBookmarksInTree(tree) {
    if (!tree || !tree.roots) return 0;

    let count = 0;
    const countInNode = (node) => {
      if (node.type === 'bookmark' || node.url) {
        count++;
      }
      if (node.children) {
        node.children.forEach(child => countInNode(child));
      }
    };

    Object.values(tree.roots).forEach(root => countInNode(root));
    return count;
  }

  /**
   * Get empty bookmark tree structure
   */
  getEmptyBookmarkTree() {
    return {
      version: 1,
      checksum: '',
      lastModified: Date.now(),
      roots: {
        bookmark_bar: {
          id: '1',
          title: 'Bookmarks Toolbar',
          name: 'Bookmarks Toolbar',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        menu: {
          id: '2',
          title: 'Bookmarks Menu',
          name: 'Bookmarks Menu',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        other: {
          id: '3',
          title: 'Other Bookmarks',
          name: 'Other Bookmarks',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        mobile: {
          id: '4',
          title: 'Mobile Bookmarks',
          name: 'Mobile Bookmarks',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        }
      }
    };
  }

  /**
   * Start auto-sync (poll every 5 minutes when online)
   */
  async startAutoSync() {
    if (this.syncInterval) {
      return; // Already running
    }

    // Use 5 minutes (300000ms) to avoid rate limiting and account flagging
    const syncIntervalMs = 300000; // 5 minutes
    console.log('Starting auto-sync (immediate + 5-minute interval)...');

    // Perform initial sync immediately
    if (navigator.onLine && !this.isSyncing) {
      const remoteId = this.getRemoteId();
      if (remoteId) {
        try {
          console.log('[AutoSync] Running initial sync...');
          // First, push any local changes if needed
          if (this.hasUnsyncedChanges) {
            console.log('[AutoSync] Initial - Unsynced changes detected, pushing to remote...');
            await this.syncToRemote();
          }
          // Then, pull remote changes
          await this.syncFromRemote();
        } catch (error) {
          console.error('[AutoSync] Initial sync failed:', error);
          this.emitEvent('syncError', 'Initial auto-sync failed: ' + error.message);
        }
      } else {
        console.log('[AutoSync] Skipping initial sync - no remote storage configured');
      }
    }

    // Then start the interval for subsequent syncs
    this.syncInterval = setInterval(async () => {
      if (navigator.onLine && !this.isSyncing) {
        // Check if we have a remote ID configured before trying to sync
        const remoteId = this.getRemoteId();
        if (!remoteId) {
          console.log('[AutoSync] Skipping scheduled sync - no remote storage configured');
          return;
        }

        try {
          // Check and rotate token if needed
          const token = await authManager.getToken('gitlab');
          if (token) {
            const result = await supabaseManager.checkAndRotateIfNeeded(token);
            if (result.needsRotation) {
              this.emitEvent('tokenExpiring', { daysLeft: result.daysLeft, token: result.currentToken });
            }
          }

          // First, push any local changes if needed
          console.log(`[AutoSync] Scheduled - hasUnsyncedChanges: ${this.hasUnsyncedChanges}`);
          if (this.hasUnsyncedChanges) {
            console.log('[AutoSync] Scheduled - Unsynced changes detected, pushing to remote...');
            await this.syncToRemote();
          }
          // Then, pull remote changes
          await this.syncFromRemote();
        } catch (error) {
          console.error('[AutoSync] Scheduled sync failed:', error);
          this.emitEvent('syncError', 'Auto-sync failed: ' + error.message);
        }
      }
    }, syncIntervalMs);
  }

  /**
   * Manual sync trigger - bidirectional
   * @param {boolean} forcePush - Force push local changes even if hasUnsyncedChanges is false
   */
  async manualSync(forcePush = false) {
    if (this.isSyncing) {
      console.log('[ManualSync] Sync already in progress');
      return;
    }

    if (!navigator.onLine) {
      this.emitEvent('syncError', 'Cannot sync while offline');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      this.emitEvent('syncError', 'No remote storage configured');
      return;
    }

    try {
      console.log(`[ManualSync] Starting (forcePush: ${forcePush}, hasUnsyncedChanges: ${this.hasUnsyncedChanges})`);

      // Push local changes first
      if (this.hasUnsyncedChanges || forcePush) {
        console.log('[ManualSync] Pushing local changes to remote...');
        await this.syncToRemote();
      }
      // Then pull remote changes
      const updated = await this.syncFromRemote();

      if (updated || this.hasUnsyncedChanges) {
        this.emitEvent('syncSuccess', 'Manual sync complete');
      } else {
        this.emitEvent('syncSuccess', 'Already up to date');
      }
    } catch (error) {
      console.error('Manual sync failed:', error);
      this.emitEvent('syncError', 'Manual sync failed: ' + error.message);
    }
  }

  /**
   * Stop auto-sync
   */
  stopAutoSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Auto-sync stopped');
    }
  }

  /**
   * Handle coming back online
   */
  async handleOnline() {
    console.log('Back online, syncing...');

    // Show toast notification
    this.emitEvent('online');

    // Check for pending changes
    const hasPending = await this.hasPendingChanges();

    if (hasPending) {
      try {
        await this.syncToRemote();
        this.emitEvent('syncSuccess', 'Bookmarks synced successfully!');
      } catch (error) {
        console.error('Failed to sync pending changes:', error);
        this.emitEvent('syncError', error.message);
      }
    } else {
      // Just pull remote changes
      const updated = await this.syncFromRemote();
      if (updated) {
        this.emitEvent('syncSuccess', 'Bookmarks updated from remote');
      }
    }

    // Restart auto-sync
    if (this.autoSyncEnabled) {
      this.startAutoSync();
    }
  }

  /**
   * Handle going offline
   */
  handleOffline() {
    console.log('Offline detected');
    this.stopAutoSync();
    this.emitEvent('offline');
  }

  /**
   * Emit custom events for UI updates
   */
  emitEvent(eventName, data = null) {
    const event = new CustomEvent(`sync:${eventName}`, { detail: data });
    window.dispatchEvent(event);
  }

  /**
   * Subscribe to sync events (wrapper around window.addEventListener)
   * @param {string} eventName - Event name without 'sync:' prefix
   * @param {function} handler - Event handler function
   */
  on(eventName, handler) {
    const wrappedHandler = (event) => handler(event.detail);
    window.addEventListener(`sync:${eventName}`, wrappedHandler);
    return wrappedHandler; // Return for potential cleanup
  }

  /**
   * Unsubscribe from sync events (wrapper around window.removeEventListener)
   * @param {string} eventName - Event name without 'sync:' prefix
   * @param {function} handler - The wrapped handler returned from on()
   */
  off(eventName, handler) {
    window.removeEventListener(`sync:${eventName}`, handler);
  }

  /**
   * Get sync status for UI
   */
  getSyncStatus() {
    return {
      isOnline: navigator.onLine,
      isSyncing: this.isSyncing,
      hasUnsyncedChanges: this.hasUnsyncedChanges,
      lastSyncTime: this.lastSyncTime,
      provider: this.provider,
      snippetId: this.snippetId,
      remoteId: this.getRemoteId(),
      deviceId: this.deviceId
    };
  }
}

// Export singleton instance
const syncManager = new SyncManager();
export default syncManager;

// Also export the class for testing
export { SyncManager };
