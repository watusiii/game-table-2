// What kind of file is this, and how do we show it? Text opens in the editor; the rest is read-only.

export type FileKind = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'font' | 'other';

const TEXT = /\.(md|txt|json|js|mjs|ts|html|css)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a|flac)$/i;
const VIDEO = /\.(mp4|webm)$/i;
const FONT = /\.(woff2?|ttf|otf)$/i;

export function kindOf(path: string): FileKind {
  if (TEXT.test(path)) return 'text';
  if (IMAGE.test(path)) return 'image';
  if (AUDIO.test(path)) return 'audio';
  if (VIDEO.test(path)) return 'video';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (FONT.test(path)) return 'font';
  return 'other';
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

// Fills `pane` with a viewer for one file. `urlFor` turns a repo path into a loadable address.
export function renderMedia(
  pane: HTMLElement,
  path: string,
  allFiles: string[],
  urlFor: (path: string) => string,
  open: (path: string) => void,
): void {
  pane.replaceChildren();
  const kind = kindOf(path);
  const url = urlFor(path);
  const stage = node('div', 'media-stage');
  const info = node('div', 'media-info');

  if (kind === 'image') {
    const image = node('img', 'media-image');
    image.alt = path;
    image.src = url;
    image.addEventListener('load', () => {
      info.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · click to toggle fit / full size';
    });
    image.addEventListener('error', () => {
      stage.replaceChildren(node('p', 'media-note', 'Could not load this image. It may be over 20 MB.'));
    });
    image.addEventListener('click', () => image.classList.toggle('full'));
    stage.append(image);
  } else if (kind === 'audio' || kind === 'video') {
    const player = node(kind === 'audio' ? 'audio' : 'video', 'media-player');
    player.controls = true;
    player.src = url;
    stage.append(player);
  } else if (kind === 'pdf') {
    const frame = node('iframe', 'media-pdf');
    frame.src = url;
    frame.title = path;
    stage.append(frame);
  } else if (kind === 'font') {
    const name = 'preview-' + Math.random().toString(36).slice(2);
    const face = new FontFace(name, 'url(' + url + ')');
    const sample = node('div', 'media-font', 'The quick brown fox jumps over the lazy dog\n0123456789  !?&@');
    stage.append(sample);
    face.load().then(
      (loaded) => {
        document.fonts.add(loaded);
        sample.style.fontFamily = '"' + name + '"';
      },
      () => {
        sample.textContent = 'Could not load this font.';
      },
    );
  } else {
    const ext = /\.[^./]+$/.exec(path)?.[0] ?? 'this type';
    stage.append(node('p', 'media-note', 'No preview for ' + ext + ' files yet. It is in the repo; open it on GitHub or in your own tools.'));
  }

  pane.append(stage, info);

  // Other pictures and media in the same folder, so an assets folder can be flipped through.
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const siblings = allFiles.filter(
    (other) => other.startsWith(folder) && !other.slice(folder.length).includes('/') && kindOf(other) === 'image',
  );
  if (siblings.length > 1 && kind === 'image') {
    const strip = node('div', 'media-strip');
    for (const other of siblings) {
      const thumb = node('button', 'media-thumb' + (other === path ? ' active' : ''));
      thumb.title = other.slice(folder.length);
      const image = node('img');
      image.loading = 'lazy';
      image.alt = thumb.title;
      image.src = urlFor(other);
      thumb.append(image);
      thumb.addEventListener('click', () => open(other));
      strip.append(thumb);
    }
    pane.append(strip);
  }
}
