// Browser-native sanitizer. Server publication uses lib/domain/description.ts.
// Never load the server sanitizer's CommonJS/PostCSS dependencies into the UI.
export function editableDescriptionHtml(value: unknown): string {
  const source = typeof value === 'string' ? value : '';
  const output = document.createElement('div');
  if (!/<\/?[a-z][^>]*>/i.test(source)) {
    for (const line of source.split(/\r?\n/)) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      output.append(paragraph);
    }
  } else {
    const template = document.createElement('template');
    template.innerHTML = source;
    const allowed = new Set(['p','br','strong','b','em','i','u','ul','ol','li','h2','h3','h4','blockquote','table','thead','tbody','tr','th','td','div']);
    const excluded = new Set(['script','style','textarea','option','iframe','object']);
    const copy = (node: Node, parent: Node) => {
      if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent || '')); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = (node as Element).tagName.toLowerCase();
      if (excluded.has(tag)) return;
      const target = allowed.has(tag) ? document.createElement(tag) : parent;
      if (target !== parent) parent.appendChild(target);
      for (const child of node.childNodes) copy(child, target);
    };
    for (const node of template.content.childNodes) copy(node, output);
  }
  return output.textContent?.replace(/\s|\u00a0/g, '') ? output.innerHTML : '';
}
