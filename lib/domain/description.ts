import sanitizeHtml from 'sanitize-html';

export function descriptionHtml(value: unknown): string {
  const source = typeof value === 'string' ? value : '';
  const html = /<\/?[a-z][^>]*>/i.test(source) ? source : source.split(/\r?\n/).map(line => `<p>${line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`).join('');
  const clean = sanitizeHtml(html, {
    allowedTags: ['p','br','strong','b','em','i','u','ul','ol','li','h2','h3','h4','blockquote','table','thead','tbody','tr','th','td','div'],
    allowedAttributes: {},
    nonTextTags: ['script','style','textarea','option','iframe','object'],
  });
  return sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;|\s/g, '') ? clean : '';
}
