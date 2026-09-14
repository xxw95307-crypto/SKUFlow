import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptionHtml } from '../lib/domain/description.ts';
import { buildShopifyProductInput } from '../lib/platforms/shopify-dev.ts';

test('description keeps Chinese paragraphs emphasis lists and tables', () => {
  const html='<p>中文描述 <strong>纯棉</strong></p><ul><li>商品参数</li></ul><table><tr><td>尺码</td><td>M</td></tr></table>';
  assert.equal(descriptionHtml(html),html);
  assert.equal(descriptionHtml(descriptionHtml(html)),html);
});
test('plain text becomes escaped Shopify paragraphs without changing facts', () => {
  assert.equal(descriptionHtml('<p><br></p>'), '');
  assert.equal(descriptionHtml('中文商品\n克重 180 & 尺码 < M'),'<p>中文商品</p><p>克重 180 &amp; 尺码 &lt; M</p>');
});
test('preview and publication strip executable markup and attributes', () => {
  assert.equal(descriptionHtml('<p onclick="evil()">中文<script>alert(1)</script><img src="x" onerror="evil()"></p><iframe>evil</iframe>'),'<p>中文</p>');
});
test('Shopify payload converts edited description to HTML at publication', () => {
  const product=buildShopifyProductInput({fields:{title:'中文标题',body_html:'编辑后的描述\n第二段'}} as any,'draft-description-test');
  assert.equal(product.descriptionHtml,'<p>编辑后的描述</p><p>第二段</p>');
  assert.equal(product.status,'DRAFT');
});
