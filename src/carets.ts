// Paints things over a plain textarea, Google Docs style: who wrote each stretch of text,
// and other people's carets and selections.
// For each it builds an invisible copy of the text with the same fonts and wrapping,
// marks things inside that copy, and lays it over the textarea.
import type { AuthorSegment } from './collab';
import { cleanColor } from './room';

export interface DrawnCaret {
  id: string;
  name: string;
  color: string;
  start: number;
  end: number;
  back: boolean;
}

export class CaretLayer {
  private textarea: HTMLTextAreaElement;
  private authorLayer: HTMLDivElement;
  private layer: HTMLDivElement;
  private carets: DrawnCaret[] = [];
  private segments: AuthorSegment[] = [];

  constructor(textarea: HTMLTextAreaElement, host: HTMLElement) {
    this.textarea = textarea;
    // Authorship goes underneath the carets.
    this.authorLayer = document.createElement('div');
    this.authorLayer.className = 'caret-layer';
    this.layer = document.createElement('div');
    this.layer.className = 'caret-layer';
    host.append(this.authorLayer, this.layer);
    textarea.addEventListener('scroll', () => this.followScroll());
    new ResizeObserver(() => {
      this.drawAuthors();
      this.draw();
    }).observe(textarea);
  }

  set(carets: DrawnCaret[]): void {
    this.carets = carets;
    this.draw();
  }

  // Who wrote what. Pass an empty list to turn the colors off.
  setAuthors(segments: AuthorSegment[]): void {
    this.segments = segments;
    this.drawAuthors();
  }

  private followScroll(): void {
    const shift = 'translateY(' + -this.textarea.scrollTop + 'px)';
    [this.authorLayer, this.layer].forEach((layer) => {
      layer.querySelectorAll<HTMLElement>('.caret-inner').forEach((node) => {
        node.style.transform = shift;
      });
    });
  }

  private size(layer: HTMLDivElement): void {
    layer.style.width = this.textarea.clientWidth + 'px';
    layer.style.height = this.textarea.clientHeight + 'px';
  }

  private drawAuthors(): void {
    const textarea = this.textarea;
    this.authorLayer.replaceChildren();
    this.size(this.authorLayer);
    if (!this.segments.length) return;

    const value = textarea.value;
    const clamp = (index: number) => Math.min(value.length, Math.max(0, index));
    const inner = document.createElement('div');
    inner.className = 'caret-inner';
    inner.style.transform = 'translateY(' + -textarea.scrollTop + 'px)';

    let cursor = 0;
    for (const segment of this.segments) {
      const start = Math.max(cursor, clamp(segment.start));
      const end = clamp(segment.end);
      if (start > cursor) inner.append(value.slice(cursor, start));
      if (end > start) {
        const span = document.createElement('span');
        span.className = 'author-span';
        span.style.setProperty('--c', cleanColor(segment.color));
        span.textContent = value.slice(start, end);
        inner.append(span);
        cursor = end;
      }
    }
    if (cursor < value.length) inner.append(value.slice(cursor));
    inner.append('\u200b');

    const mirror = document.createElement('div');
    mirror.className = 'caret-mirror';
    mirror.append(inner);
    this.authorLayer.append(mirror);
  }

  private draw(): void {
    const textarea = this.textarea;
    this.layer.replaceChildren();
    this.size(this.layer);
    const value = textarea.value;
    const clamp = (index: number) => Math.min(value.length, Math.max(0, index));

    for (const caret of this.carets) {
      const start = clamp(Math.min(caret.start, caret.end));
      const end = clamp(Math.max(caret.start, caret.end));

      const marker = document.createElement('span');
      marker.className = 'caret';
      const label = document.createElement('span');
      label.className = 'caret-name';
      label.textContent = caret.name;
      marker.append(label);

      const selected = document.createElement('span');
      selected.className = 'caret-sel';
      selected.textContent = value.slice(start, end);

      const inner = document.createElement('div');
      inner.className = 'caret-inner';
      inner.style.transform = 'translateY(' + -textarea.scrollTop + 'px)';
      const before = value.slice(0, start);
      const after = value.slice(end);
      if (start === end) inner.append(before, marker, after);
      else if (caret.back) inner.append(before, marker, selected, after);
      else inner.append(before, selected, marker, after);
      // A zero-width character keeps a trailing newline from collapsing.
      inner.append('\u200b');

      const mirror = document.createElement('div');
      mirror.className = 'caret-mirror';
      mirror.style.setProperty('--c', cleanColor(caret.color));
      mirror.append(inner);
      this.layer.append(mirror);
    }
  }
}
