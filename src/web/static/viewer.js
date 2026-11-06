// The full-size viewer (round 2 section 12): a picture opens on a plain screen to drag around, with thumb-sized
// − Fit ＋ and Done. The app runs standalone on the iPhone, so opening the raw file would strand the owner on a bare
// image with no way back. app.js imports this module the first time a picture is tapped; without script the
// picture's link opens its file. Batch I3 opens diagrams here too.

const STEP = 1.25;
const MAX_SCALE = 4;

/**
 * The scale to show a picture at: Fit (the largest that fits the box, never above 1) times 1.25 per step, kept
 * between Fit and 4. A picture without a known size shows at 1.
 */
export function viewerScale(natural, box, step) {
  if (!natural.w || !natural.h) return 1;
  const fit = Math.min(1, box.w / natural.w, box.h / natural.h);
  const scale = fit * STEP ** Math.max(0, step);
  return Math.min(Math.max(scale, fit), Math.max(MAX_SCALE, fit));
}

let dialog = null;
let box = null;
let shown = null;
let natural = { w: 0, h: 0 };
let step = 0;
let from = null;
/** What the viewer shows and scales: the picture, or a diagram's SVG. */
let target = null;

function button(label, text, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function apply() {
  const scale = viewerScale(natural, { w: box.clientWidth, h: box.clientHeight }, step);
  target.style.width = `${Math.round(natural.w * scale)}px`;
}

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'viewer';
  dialog.setAttribute('aria-label', 'Full size');
  box = document.createElement('div');
  box.className = 'viewer-box';
  shown = document.createElement('img');
  shown.alt = '';
  box.append(shown);
  const bar = document.createElement('div');
  bar.className = 'viewer-bar';
  bar.append(
    button('Smaller', '−', () => { step = Math.max(0, step - 1); apply(); }),
    button('Fit to the screen', 'Fit', () => { step = 0; apply(); }),
    button('Larger', '＋', () => { step = Math.min(step + 1, 12); apply(); }),
    button('Done', 'Done', () => dialog.close(), 'viewer-done'),
  );
  dialog.append(box, bar);
  // Esc closes the viewer only: kept from desk.js, whose Esc would also close the page beside the list.
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  dialog.addEventListener('close', () => {
    shown.removeAttribute('src');
    shown.hidden = false;
    box.querySelector('.viewer-diagram')?.remove();
    if (from && from.isConnected) from.focus();
    from = null;
  });
  document.body.append(dialog);
}

/**
 * Opens a drawn diagram full size: `node` is a copy of its SVG, `sheet` its styles (adopted by a shadow root, as in
 * the page), `width` and `height` its drawn size.
 */
export function openViewerNode({ node, width, height, sheet }) {
  if (!dialog || !dialog.isConnected) build();
  natural = { w: width || 0, h: height || 0 };
  step = 0;
  from = document.activeElement;
  shown.hidden = true;
  const host = document.createElement('div');
  host.className = 'viewer-diagram';
  const root = host.attachShadow({ mode: 'open' });
  if (sheet) root.adoptedStyleSheets = [sheet];
  node.style.display = 'block';
  root.append(node);
  box.querySelector('.viewer-diagram')?.remove();
  box.append(host);
  target = node;
  dialog.showModal();
  apply();
  box.scrollTop = 0;
  box.scrollLeft = 0;
  dialog.querySelector('.viewer-done').focus();
}

/** Opens a picture link (a.pic) full size; its <img> carries the picture's real width and height. */
export function openViewer(link) {
  if (!dialog || !dialog.isConnected) build();
  const thumb = link.querySelector('img');
  natural = { w: Number(thumb?.getAttribute('width')) || 0, h: Number(thumb?.getAttribute('height')) || 0 };
  step = 0;
  from = link;
  shown.alt = thumb?.getAttribute('alt') ?? '';
  shown.src = link.href;
  target = shown;
  dialog.showModal();
  apply();
  box.scrollTop = 0;
  box.scrollLeft = 0;
  dialog.querySelector('.viewer-done').focus();
}
