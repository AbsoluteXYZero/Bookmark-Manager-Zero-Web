/**
 * Theme and Settings Manager
 * Handles theme, view, zoom, font size, GUI scale, and start folder preferences
 * Expects the following globals to be available:
 * - window.theme, window.viewMode, window.zoomLevel, window.fontSize, window.guiScale, window.startFolderId
 * - window.isPreviewMode
 * - window.safeStorage
 * - window.currentCustomAccentColor
 * - window.expandedFolders, window.bookmarkTree
 */

function loadTheme() {
  if (window.isPreviewMode) {
    window.theme = 'enhanced-blue';
    applyTheme();
    return;
  }

  window.safeStorage.get('theme').then(result => {
    window.theme = result.theme || 'enhanced-blue';
    applyTheme();

    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      themeSelect.value = window.theme;
    }
  });
}

function applyTheme() {
  const theme = window.theme || 'enhanced-blue';

  document.body.classList.remove('dark', 'light', 'blue-dark',
    'enhanced-blue', 'enhanced-light', 'enhanced-dark', 'enhanced-gray',
    'tinted');

  if (theme !== 'tinted') {
    document.body.style.removeProperty('--md-sys-color-surface');
    document.documentElement.style.removeProperty('--tint-hue');
    document.documentElement.style.removeProperty('--tint-saturation');
    document.documentElement.style.removeProperty('--header-background');
    document.documentElement.style.removeProperty('--footer-background');
  }

  document.body.classList.add(theme);

  updateTintControlsVisibility();

  if (theme === 'tinted') {
    loadTintSettings();
  }

  const savedColor = localStorage.getItem('customAccentColor');
  if (savedColor) {
    applyCustomAccentColor(savedColor);
  }
}

function applyCustomAccentColor(color) {
  window.currentCustomAccentColor = color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  const containerR = Math.min(255, r + 80);
  const containerG = Math.min(255, g + 80);
  const containerB = Math.min(255, b + 80);
  const containerColor = `#${containerR.toString(16).padStart(2, '0')}${containerG.toString(16).padStart(2, '0')}${containerB.toString(16).padStart(2, '0')}`;

  let styleTag = document.getElementById('custom-accent-style');
  if (styleTag) {
    styleTag.remove();
  }

  styleTag = document.createElement('style');
  styleTag.id = 'custom-accent-style';
  styleTag.textContent = `
    @layer custom-accent {
      html:root {
        --md-sys-color-primary: ${color} !important;
        --md-sys-color-primary-container: ${containerColor} !important;
        --md-sys-color-secondary: ${color} !important;
      }
      html body.light,
      html body.blue-dark,
      html body.dark,
      html body.enhanced-blue,
      html body.enhanced-light,
      html body.enhanced-dark,
      html body.enhanced-gray,
      html body.tinted {
        --md-sys-color-primary: ${color} !important;
        --md-sys-color-primary-container: ${containerColor} !important;
        --md-sys-color-secondary: ${color} !important;
      }
      .folder-children {
        border-left: 2px solid ${color} !important;
      }
    }
  `;
  if (document.body) {
    document.body.appendChild(styleTag);
  } else {
    document.head.appendChild(styleTag);
  }

  document.querySelectorAll('.folder-children').forEach(element => {
    element.style.setProperty('border-left-color', color, 'important');
  });
}

function setupFolderChildrenObserver() {
  if (typeof window.folderChildrenObserver === 'undefined' && document.body) {
    window.folderChildrenObserver = new MutationObserver((mutations) => {
      if (!window.currentCustomAccentColor) return;

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.classList && node.classList.contains('folder-children')) {
              node.style.setProperty('border-left-color', window.currentCustomAccentColor, 'important');
            }
            if (node.querySelectorAll) {
              node.querySelectorAll('.folder-children').forEach(element => {
                element.style.setProperty('border-left-color', window.currentCustomAccentColor, 'important');
              });
            }
          }
        });

        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const target = mutation.target;
          if (target.classList && target.classList.contains('folder-children')) {
            target.style.setProperty('border-left-color', window.currentCustomAccentColor, 'important');
          }
        }
      });
    });

    window.folderChildrenObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }
}

function updateTintControlsVisibility() {
  const theme = window.theme || 'enhanced-blue';
  const tintControls = document.getElementById('tintControls');
  if (tintControls) {
    if (theme === 'tinted') {
      tintControls.style.display = 'block';
    } else {
      tintControls.style.display = 'none';
    }
  }
}

function applyTintSettings(hue, saturation) {
  const theme = window.theme || 'enhanced-blue';
  if (theme !== 'tinted') return;

  document.documentElement.style.setProperty('--tint-hue', hue);
  document.documentElement.style.setProperty('--tint-saturation', `${saturation}%`);

  const lightness = saturation > 50 ? 65 : 70;
  const bgColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.72)`;
  document.body.style.setProperty('--md-sys-color-surface', bgColor);

  const headerFooterLightness = saturation > 50 ? 70 : 75;
  const headerFooterColor = `hsla(${hue}, ${saturation}%, ${headerFooterLightness}%, 0.85)`;
  document.documentElement.style.setProperty('--header-background', headerFooterColor);
  document.documentElement.style.setProperty('--footer-background', headerFooterColor);

  if (!window.isPreviewMode) {
    window.safeStorage.set({
      tintHue: hue,
      tintSaturation: saturation
    });
  }
}

function loadTintSettings() {
  window.safeStorage.get(['tintHue', 'tintSaturation']).then(result => {
    const hue = result.tintHue || 220;
    const saturation = result.tintSaturation || 30;

    const hueInput = document.getElementById('tintHue');
    const saturationInput = document.getElementById('tintSaturation');
    const hueValue = document.getElementById('hueValue');
    const saturationValue = document.getElementById('saturationValue');

    if (hueInput) hueInput.value = hue;
    if (saturationInput) saturationInput.value = saturation;
    if (hueValue) hueValue.textContent = `${hue}°`;
    if (saturationValue) saturationValue.textContent = `${saturation}%`;

    applyTintSettings(hue, saturation);
  });
}

function setTheme(newTheme) {
  window.theme = newTheme;
  applyTheme();
  if (!window.isPreviewMode) {
    window.safeStorage.set({ theme: newTheme });
  }
}

function loadView() {
  if (window.isPreviewMode) {
    window.viewMode = 'list';
    applyView();
    return;
  }

  window.safeStorage.get('viewMode').then(result => {
    window.viewMode = result.viewMode || 'list';
    applyView();
  });
}

function applyView() {
  const bookmarkList = document.getElementById('bookmarkList');
  if (!bookmarkList) return;

  bookmarkList.classList.remove('grid-view', 'grid-2', 'grid-3', 'grid-4', 'grid-5', 'grid-6');

  if (window.viewMode !== 'list') {
    bookmarkList.classList.add('grid-view', window.viewMode);
  }
}

function setView(newView) {
  window.viewMode = newView;
  applyView();
  if (!window.isPreviewMode) {
    window.safeStorage.set({ viewMode: newView });
  }
}

function loadZoom() {
  if (window.isPreviewMode) {
    window.zoomLevel = 80;
    applyZoom();
    return;
  }

  window.safeStorage.get('zoomLevel').then(result => {
    window.zoomLevel = result.zoomLevel || 80;
    applyZoom();
    updateZoomDisplay();
  });
}

function applyZoom() {
  const bookmarkList = document.getElementById('bookmarkList');
  if (!bookmarkList) return;

  const zoomFactor = (window.zoomLevel || 80) / 100;
  bookmarkList.style.zoom = zoomFactor;
  bookmarkList.style.transform = '';
  bookmarkList.style.width = '';
}

function setZoom(newZoom) {
  window.zoomLevel = newZoom;
  applyZoom();
  updateZoomDisplay();
  if (!window.isPreviewMode) {
    window.safeStorage.set({ zoomLevel: newZoom });
  }
}

function updateZoomDisplay() {
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomValue = document.getElementById('zoomValue');
  
  if (zoomSlider) zoomSlider.value = window.zoomLevel || 80;
  if (zoomValue) zoomValue.textContent = `${window.zoomLevel || 80}%`;
}

function loadFontSize() {
  if (window.isPreviewMode) {
    window.fontSize = 100;
    applyFontSize();
    return;
  }

  window.safeStorage.get('fontSize').then(result => {
    window.fontSize = result.fontSize || 100;
    applyFontSize();
    updateFontSizeDisplay();
  });
}

function applyFontSize() {
  const fontSizeFactor = (window.fontSize || 100) / 100;
  document.documentElement.style.setProperty('--font-size-scale', fontSizeFactor);
}

function setFontSize(newSize) {
  window.fontSize = newSize;
  applyFontSize();
  updateFontSizeDisplay();
  if (!window.isPreviewMode) {
    window.safeStorage.set({ fontSize: newSize });
  }
}

function updateFontSizeDisplay() {
  const fontSizeSlider = document.getElementById('fontSizeSlider');
  const fontSizeValue = document.getElementById('fontSizeValue');
  
  if (fontSizeSlider) fontSizeSlider.value = window.fontSize || 100;
  if (fontSizeValue) fontSizeValue.textContent = `${window.fontSize || 100}%`;
}

function loadGuiScale() {
  const savedScale = localStorage.getItem('guiScale');
  window.guiScale = savedScale ? parseInt(savedScale) : 100;
  applyGuiScale();
  
  const guiScaleSelect = document.getElementById('guiScaleSelect');
  if (guiScaleSelect) {
    guiScaleSelect.value = window.guiScale;
  }
}

function applyGuiScale() {
  const scaleFactor = (window.guiScale || 100) / 100;
  const elements = [
    document.querySelector('.header'),
    document.getElementById('collapsibleHeader'),
    document.getElementById('filterBar'),
    document.getElementById('displayBar'),
    document.getElementById('scanStatusBar')
  ];

  elements.forEach(element => {
    if (element) {
      element.style.zoom = scaleFactor;
    }
  });
}

async function loadStartFolder() {
  if (window.isPreviewMode) {
    window.startFolderId = null;
    return;
  }

  try {
    const result = await window.safeStorage.get('startFolderId');
    window.startFolderId = result.startFolderId || null;
    console.log(`Loaded start folder: ${window.startFolderId || 'Root'}`);
  } catch (error) {
    console.error('Error loading start folder preference:', error);
    window.startFolderId = null;
  }
}

function populateStartFolderDropdown(getAllFolders) {
  const startFolderSelect = document.getElementById('startFolderSelect');
  if (!startFolderSelect) return;

  const bookmarkTree = window.bookmarkTree || [];
  const folders = getAllFolders(bookmarkTree);

  startFolderSelect.innerHTML = '<option value="">All Bookmarks (Root)</option>';

  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.title;
    startFolderSelect.appendChild(option);
  });

  if (window.startFolderId) {
    startFolderSelect.value = window.startFolderId;
  }
}

async function expandToStartFolder() {
  const startFolderId = window.startFolderId;
  if (!startFolderId) return;

  const bookmarkTree = window.bookmarkTree || [];

  function findPath(nodes, targetId, path = []) {
    for (const node of nodes) {
      if (node.id === targetId) {
        return [...path, node.id];
      }
      if (node.children) {
        const found = findPath(node.children, targetId, [...path, node.id]);
        if (found) return found;
      }
    }
    return null;
  }

  const path = findPath(bookmarkTree, startFolderId);
  if (path) {
    path.forEach(folderId => {
      window.expandedFolders.add(folderId);
    });
  }
}

export {
  loadTheme,
  applyTheme,
  applyCustomAccentColor,
  setupFolderChildrenObserver,
  updateTintControlsVisibility,
  applyTintSettings,
  loadTintSettings,
  setTheme,
  loadView,
  applyView,
  setView,
  loadZoom,
  applyZoom,
  setZoom,
  updateZoomDisplay,
  loadFontSize,
  applyFontSize,
  setFontSize,
  updateFontSizeDisplay,
  loadGuiScale,
  applyGuiScale,
  loadStartFolder,
  populateStartFolderDropdown,
  expandToStartFolder
};
