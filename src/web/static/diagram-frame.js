// The diagram renderer frame (round 2 section 12). Mermaid writes <style> elements and style="…" attributes, which
// the brain's page policy refuses, so it runs here, in /diagram-frame, whose own policy allows inline styles and
// nothing else (no images, no fetches, no outside fonts). The page posts { id, text, vars }; the frame draws, moves
// every inline style into data-mm-css, takes the <style> text out, and posts back { id, svg, css, width, height } or
// { id, error }. The page then sanitises the SVG and puts the styles back with CSSOM inside a shadow root.

const MERMAID = '/static/vendor/mermaid-12.3.0/mermaid.esm.min.mjs';

/** Every top-level setting a diagram's own front-matter or %%{init}%% may not change. */
export const SECURE = ['securityLevel', 'secure', 'startOnLoad', 'maxTextSize', 'maxEdges', 'dompurifyConfig', 'themeCSS', 'themeVariables',
  'theme', 'darkMode', 'look', 'layout', 'fontFamily', 'altFontFamily', 'htmlLabels', 'deterministicIds', 'deterministicIDSeed',
  'arrowMarkerAbsolute', 'logLevel', 'handDrawnSeed', 'wrap', 'markdownAutoWrap', 'legacyMathML', 'forceLegacyMathML'];

/** Mermaid's settings: strict, pure SVG labels, the dagre layout only, size limits, and the brain's colours. */
export function frameConfig(vars) {
  const p = vars.palette;
  const scale = {};
  for (let i = 0; i < 12; i++) scale[`cScale${i}`] = p[i % p.length];
  for (let i = 1; i <= 12; i++) scale[`pie${i}`] = p[(i - 1) % p.length];
  for (let i = 0; i < 8; i++) scale[`git${i}`] = p[i % p.length];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    layout: 'dagre',
    theme: 'base',
    maxTextSize: 20000,
    maxEdges: 300,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    secure: SECURE,
    themeVariables: {
      darkMode: !!vars.dark,
      background: vars.surface,
      mainBkg: vars.raised,
      primaryColor: vars.raised,
      secondaryColor: vars.surface,
      tertiaryColor: vars.surface,
      primaryBorderColor: vars.lineStrong,
      secondaryBorderColor: vars.line,
      tertiaryBorderColor: vars.line,
      lineColor: vars.lineStrong,
      primaryTextColor: vars.fg,
      secondaryTextColor: vars.ink2,
      tertiaryTextColor: vars.ink2,
      textColor: vars.fg,
      titleColor: vars.fg,
      edgeLabelBackground: vars.surface,
      clusterBkg: vars.surface,
      clusterBorder: vars.line,
      noteBkgColor: vars.surface,
      noteTextColor: vars.ink2,
      noteBorderColor: vars.line,
      actorBkg: vars.raised,
      actorBorder: vars.lineStrong,
      actorTextColor: vars.fg,
      signalColor: vars.fg,
      signalTextColor: vars.fg,
      labelTextColor: vars.fg,
      ...scale,
      xyChart: { plotColorPalette: p.join(', '), backgroundColor: vars.surface, titleColor: vars.fg },
    },
  };
}

const HTML_LABELS = "This diagram turns on HTML labels, which the brain doesn't draw. Remove the `htmlLabels` setting at its top.";

/** Front-matter `htmlLabels: true` gets past `secure` (found when section 12 was designed): report it, don't draw. */
export function checkHtmlLabels(config) {
  return config && (config.htmlLabels === true || (config.flowchart && config.flowchart.htmlLabels === true)) ? HTML_LABELS : null;
}

/** HTML inside a drawing (a foreignObject): the page's sanitiser would drop it, so it is reported instead. */
export function svgHasHtml(svgText) {
  return /<foreignObject[\s>]/i.test(svgText);
}

/** Moves every style="…" into data-mm-css and every <style> into the returned css, in the frame's own document. */
function moveStyles(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  const css = [];
  for (const s of [...root.querySelectorAll('style')]) {
    css.push(s.textContent || '');
    s.remove();
  }
  // A few kinds (journey's section titles) draw a label as HTML in a foreignObject whatever the settings say. The
  // page's sanitiser keeps SVG only, so each becomes a plain SVG text, centred in the same box.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  for (const fo of [...root.getElementsByTagName('foreignObject')]) {
    const x = Number(fo.getAttribute('x')) || 0, y = Number(fo.getAttribute('y')) || 0;
    const w = Number(fo.getAttribute('width')) || 0, h = Number(fo.getAttribute('height')) || 0;
    const t = doc.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x + w / 2));
    t.setAttribute('y', String(y + h / 2));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('class', 'fo-label');
    t.textContent = (fo.textContent || '').replace(/\s+/g, ' ').trim();
    fo.replaceWith(t);
  }
  for (const el of [root, ...root.querySelectorAll('[style]')]) {
    const v = el.getAttribute('style');
    if (v === null) continue;
    el.setAttribute('data-mm-css', v);
    el.removeAttribute('style');
  }
  const box = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  css.push('.fo-label { fill: currentColor; font-size: 14px; }');
  return { svg: new XMLSerializer().serializeToString(root), css: css.join('\n'), width: box[2] || 0, height: box[3] || 0 };
}

async function start() {
  let mermaid;
  try {
    mermaid = (await import(MERMAID)).default;
  } catch {
    // The drawer itself didn't arrive (a bad connection): say so, so the page shows the text, not a "mistake".
    window.parent.postMessage({ ready: false }, location.origin);
    return;
  }
  let queue = Promise.resolve();
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const { id, text, vars } = e.data || {};
    if (typeof id !== 'string' || typeof text !== 'string' || !vars) return;
    // One at a time: Mermaid keeps global state while it draws.
    queue = queue.then(async () => {
      let reply;
      try {
        mermaid.initialize(frameConfig(vars));
        const { svg } = await mermaid.render(`d${id.replace(/[^A-Za-z0-9_-]/g, '')}`, text);
        const labels = checkHtmlLabels(mermaid.mermaidAPI.getConfig());
        const moved = labels ? null : moveStyles(svg);
        reply = labels ? { id, error: labels } : svgHasHtml(moved.svg) ? { id, error: HTML_LABELS } : { id, ...moved };
      } catch (err) {
        reply = { id, error: String((err && (err.message || err.str)) || err).slice(0, 2000) };
      }
      window.parent.postMessage(reply, location.origin);
    });
  });
  window.parent.postMessage({ ready: true }, location.origin);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.parent !== window) start();
