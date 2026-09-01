export const sampleProducts = [
  {
    id: 'blendgo-mini',
    name: 'BlendGo Mini 便携榨汁杯',
    sku: 'BG-MINI-380',
    scenario: '参数密集型商品',
    expectedIssue: '包装图与参数表中的刀头数量冲突',
    suggestedFiles: ['商品主图.jpg', '包装背标.jpg', 'supplier-spec.xlsx', '说明书.pdf'],
  },
  {
    id: 'commute-jacket',
    name: 'Commute Shell 通勤夹克',
    sku: 'CS-JACKET-01',
    scenario: '多变体商品',
    expectedIssue: '尺码表缺少目标市场单位',
    suggestedFiles: ['款式图.jpg', '颜色变体.zip', '尺码表.xlsx'],
  },
  {
    id: 'stack-box',
    name: 'StackBox 模块化收纳盒',
    sku: 'SB-HOME-04',
    scenario: '视觉表达型商品',
    expectedIssue: '材质字段缺少可信证据',
    suggestedFiles: ['白底图.png', '场景图.jpg', '包装清单.pdf'],
  },
] as const;
