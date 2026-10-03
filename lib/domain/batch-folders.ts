export interface BatchFolderFile { index: number; name: string; relativePath: string; size: number }
export interface BatchProductFolder { name: string; files: BatchFolderFile[] }

const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'xlsx', 'xls', 'csv', 'txt']);
const spreadsheetExtensions = new Set(['xlsx', 'xls', 'csv']);

export function groupBatchFolders(files: readonly BatchFolderFile[]): { root: string; products: BatchProductFolder[] } {
  if (files.length < 2 || files.length > 100) throw new Error('每批请上传 2–100 个资料文件');
  const groups = new Map<string, BatchFolderFile[]>();
  let root = '';
  let total = 0;
  for (const file of files) {
    const parts = file.relativePath.replace(/\\/g, '/').split('/');
    if (parts.length < 3 || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('请选择包含多个商品子文件夹的总文件夹');
    if (parts.at(-1) !== file.name) throw new Error(`文件路径与名称不一致：${file.name}`);
    if (root && parts[0] !== root) throw new Error('所有商品必须属于同一个总文件夹');
    root = parts[0];
    const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
    if (!allowedExtensions.has(extension)) throw new Error(`不支持的文件类型：${file.name}`);
    if (file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error(`文件大小需在 15 MB 以内：${file.name}`);
    total += file.size;
    if (total > 40 * 1024 * 1024) throw new Error('整批资料不能超过 40 MB');
    const product = parts[1].trim();
    if (product.length > 100) throw new Error('商品文件夹名称不能超过 100 字');
    groups.set(product, [...(groups.get(product) || []), file]);
  }
  if (groups.size < 2 || groups.size > 10) throw new Error('每批请选择 2–10 个商品子文件夹');
  const products = [...groups].map(([name, productFiles]) => {
    if (productFiles.length > 12) throw new Error(`${name} 的文件超过 12 个，请分批处理`);
    if (!productFiles.some((file) => spreadsheetExtensions.has(file.name.split('.').at(-1)?.toLowerCase() || ''))) {
      throw new Error(`${name} 缺少商品表格（XLSX、XLS 或 CSV）`);
    }
    return { name, files: productFiles };
  });
  return { root, products };
}
