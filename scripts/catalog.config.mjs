// 产品定义（docs/ARCHITECTURE.md §5.1）。
// 这里只放“声明”：哪些 md 属于哪个产品、价格、副标题、slug 规则、报告用的内部用语清单。
// 扫描目录、排序、生成 docId 的逻辑在 scripts/lib-content/catalog.mjs。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 资料源目录（只读）。可用环境变量 CONTENT_ROOT / SOP_ROOT 覆盖。
 *  默认：本项目与资料目录同级（<资料根>/06_网站 与 <资料根>/03_对外产品_脱敏）。 */
export const CONTENT_ROOT = (process.env.CONTENT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '03_对外产品_脱敏')).replace(/\\/g, '/');
export const SOP_ROOT = (process.env.SOP_ROOT || join(dirname(CONTENT_ROOT), '04_服务模板与SOP')).replace(/\\/g, '/');

/** 公开内容所在目录（相对 CONTENT_ROOT）。 */
export const PUBLIC_DIR = '目录与试读';
/** 服务介绍页目录（相对 SOP_ROOT）。文件名形如 T_CV_服务介绍.md → services/T_CV.html */
export const SERVICES_DIR = '服务介绍页';

/**
 * 发行版标签：PDF 封面「版本」一栏显示的文字（所有产品共用）。
 * 不再读取源文件第一行元信息里的版本号（那是写作过程中的修订号）；每次正式发行时改这里。
 */
export const EDITION_LABEL = '2026年11月版';

/**
 * 产品列表，顺序即清单 / 目录页顺序。
 * kind:
 *   'dir'     —— 一个目录下按 pattern 匹配的所有 md，按文件名里的序号排序
 *   'perFile' —— 目录下每个 md 单独成为一个产品（P3），id = `${idPrefix}-${slug}`
 *   'codes'   —— 在 SOP_ROOT 中按代号挑文件（KIT）
 * 字段：
 *   price        数字（元），不售卖为 null
 *   priceNote    价格补充说明，没有就空字符串
 *   subtitle     字符串；或函数：perFile 传入学校学院名，其他传入（已展开 includes 的）产品对象
 *   sellingPoint 不写时从售卖页提取：优先「一句话卖点：…」行，否则取售卖页第一个二级标题
 *   sale/preview 公开页面源文件（相对 CONTENT_ROOT），没有就不写
 *   pdfParts     PDF 分部：[{label, docs:[docId 或 前缀*]} | {label, products:[产品 id 或 前缀*]}]。
 *                products 会把别的产品整份并入这份 PDF（仅 PDF；在线阅读仍按 includes 展开权限）。
 *                没被任何分部列出的本产品文档按原顺序放在最后。
 */
export const PRODUCTS = [
  {
    id: 'P1', kind: 'dir', dir: 'P1_保研经验指南', pattern: /^P1_\d{2}_.+\.md$/,
    title: '保研经验指南',
    subtitle: '从大一规划到推免结束的全流程方法，十五章',
    price: 29.9, priceNote: '',
    sale: `${PUBLIC_DIR}/P1_售卖页.md`, preview: `${PUBLIC_DIR}/P1_试读.md`,
  },
  {
    id: 'P2', kind: 'dir', dir: 'P2_理工科面试题库', pattern: /^P2_\d{2}_.+\.md$/,
    title: '理工科面试题库',
    subtitle: '十三类 305 题，每题附考察点、答题要点与常见误区',
    price: 49.9, priceNote: '',
    sale: `${PUBLIC_DIR}/P2_售卖页.md`, preview: `${PUBLIC_DIR}/P2_试读.md`,
  },
  {
    id: 'P3', kind: 'perFile', idPrefix: 'P3', dir: 'P3_单校面经复盘', pattern: /^P3_[^/]+\.md$/,
    titlePrefix: '单校面经复盘·',
    subtitle: '考核流程、回忆题型与公开面经整理',
    price: 59.9, priceNote: '',
    sale: `${PUBLIC_DIR}/P3_售卖页.md`,
    // 每个单校产品默认用 P3 系列试读；有专属试读的在 previewBySlug 里覆盖
    preview: `${PUBLIC_DIR}/P3_试读.md`,
    previewBySlug: { 'seu-ic': `${PUBLIC_DIR}/P3_东南_B级流程试读.md` },
  },
  {
    id: 'P4', kind: 'dir', dir: 'P4_多校面经合集', pattern: /^P4_\d{2}_.+\.md$/,
    title: '多校面经合集',
    // 函数形式：拿到展开 includes 后的产品对象，数字随资料增减自动更新
    subtitle: (p) => `${p.includes.length} 份单校复盘、横向对比、往年整理资料与 ${p.docs.filter((d) => d.id.startsWith('pub-')).length} 个院校方向的公开面经汇编`,
    price: 169, priceNote: '含 30 分钟答疑版 199 元',
    sale: `${PUBLIC_DIR}/P4_售卖页.md`, preview: `${PUBLIC_DIR}/P4_试读.md`,
    includes: ['P3-*'],
    // P4_03 是 公开面经汇编/*.md 的合并版（内容 99% 重复）。这里只保留它开头的“覆盖总览”，
    // 各院校正文改用 公开面经汇编/ 下的单独文件（每校一篇，阅读器加载更快）。
    docOptions: { 'P4_03_公开面经汇编.md': { trim: 'beforeSecondH1' } },
    extraDirs: [{ dir: 'P3_单校面经复盘/公开面经汇编', pattern: /^P3公开_.+\.md$/, slug: 'public' }],
    pdfParts: [
      { label: '对比指南与往年资料', docs: ['P4_01', 'P4_02'] },
      { label: '单校面经复盘', products: ['P3-*'] },
      { label: '公开面经汇编', docs: ['P4_03', 'pub-*'] },
    ],
  },
  {
    id: 'P5', kind: 'dir', dir: 'P5_DFT一周入门笔记', pattern: /^P5_.+\.md$/,
    title: 'DFT 一周入门笔记',
    subtitle: '七天从原理、建模到论文复现，以 QE / CP2K 为主',
    price: 199, priceNote: '含一周答疑版 249 元',
    sale: `${PUBLIC_DIR}/P5_售卖页.md`, preview: `${PUBLIC_DIR}/P5_试读.md`,
  },
  {
    id: 'KIT', kind: 'codes', root: 'SOP',
    codes: ['T_MAIL', 'T_CV', 'T_PS', 'T_CVPS', 'T_PPT', 'T_MOCK', 'T_PLAN', 'T_RUNALL'],
    title: '陪跑学员工具包',
    subtitle: '套磁、简历、个人陈述、科研汇报、模拟面试与计划模板（陪跑学员专用）',
    price: null, priceNote: '仅陪跑学员可见，不单独出售',
    sellingPoint: '陪跑过程中用到的模板与检查清单',
    forSale: false, studentOnly: true,
  },
];

// ---------------------------------------------------------------- slug 规则
// P3 单校产品：已有文件写死映射；新增文件按「学校_学院」自动拼 slug（学校 + 学院缩写），
// 例如 P3_南京大学_电子学院.md → nju-ee、P3_南京大学_集成电路学院.md → nju-ic。
// 学校不在字典里时退化为 x-<6位哈希>，并在 report.md 里提醒补字典。
export const P3_SLUGS = {
  '东南大学_集成电路学院': 'seu-ic',
  '北京大学_集成电路学院': 'pku-ic',
  '北京大学_新材料学院': 'pku-sam',
  '北京大学_环境与能源学院': 'pku-see',
  '电子科技大学_集成电路科学与工程学院': 'uestc-ic',
  '中科院金属所_冬令营': 'imr',
  '苏州纳米所_科学营': 'sinano',
  '中科院物理所_物理方向': 'iop',
  '中国科学院大学_物理学院': 'ucas-phys',
};

// 公开面经汇编：docId 用短 slug（统一加 pub- 前缀，避免与 P3 产品 slug 混淆）
export const PUBLIC_SLUGS = {
  '北京大学_集成电路学院': 'pub-pku-ic',
  '北京大学_电子学院': 'pub-pku-ee',
  '北京大学_信息工程学院深圳': 'pub-pku-sz',
  '北京大学_新材料学院': 'pub-pku-sam',
  '北京大学_材料科学与工程学院': 'pub-pku-mse',
  '北京大学_环境与能源学院': 'pub-pku-see',
  '北京大学_人工智能相关方向': 'pub-pku-ai',
  '清华大学_电子系与集成电路学院': 'pub-thu-ee',
  '清华大学_深研院与材料学院': 'pub-thu-sigs',
  '浙江大学_集成电路学院与信电学院': 'pub-zju',
  '复旦大学_集成电路与微纳电子创新学院': 'pub-fudan',
  '上海交通大学_集成电路学院': 'pub-sjtu',
  '南京大学_电子学院与集成电路学院': 'pub-nju',
  '东南大学_集成电路学院与电子学院': 'pub-seu',
  '电子科技大学_集成电路与电子学院': 'pub-uestc',
  '哈工大深圳_集成电路与电信': 'pub-hitsz',
  '厦门大学_电子科学与技术学院': 'pub-xmu',
  '上海创芯学院与港科广微电子': 'pub-sics-hkustgz',
  '中科院金属所与苏州纳米所': 'pub-imr-sinano',
  '中科院物理所与国科大物理学院': 'pub-iop-ucas',
  '中科院半导体所与微电子所': 'pub-semi-ime',
};
// 公开汇编在 P4 中的排列顺序（与 P4_03 合并版一致）；不在列表里的新文件排在最后
export const PUBLIC_ORDER = Object.keys(PUBLIC_SLUGS);

/** 自动 slug 用的学校字典（越长越先匹配）。 */
export const SCHOOL_ABBR = {
  '北京大学': 'pku', '清华大学': 'thu', '浙江大学': 'zju', '复旦大学': 'fudan', '上海交通大学': 'sjtu',
  '南京大学': 'nju', '东南大学': 'seu', '电子科技大学': 'uestc', '哈工大深圳': 'hitsz',
  '哈尔滨工业大学深圳': 'hitsz', '哈尔滨工业大学': 'hit', '厦门大学': 'xmu', '中国科学技术大学': 'ustc',
  '中国科学院大学': 'ucas', '国科大': 'ucas', '中科院金属所': 'imr', '金属所': 'imr', '苏州纳米所': 'sinano',
  '中科院物理所': 'iop', '物理所': 'iop', '中科院半导体所': 'semi', '半导体所': 'semi', '中科院微电子所': 'ime',
  '微电子所': 'ime', '上海创芯学院': 'sics', '港科广': 'hkustgz', '华中科技大学': 'hust',
  '西安电子科技大学': 'xidian', '西安交通大学': 'xjtu', '武汉大学': 'whu', '中山大学': 'sysu',
  '同济大学': 'tongji', '北京航空航天大学': 'buaa', '北京理工大学': 'bit', '天津大学': 'tju',
  '南方科技大学': 'sustech', '山东大学': 'sdu', '四川大学': 'scu', '华南理工大学': 'scut',
  '大连理工大学': 'dlut', '北京邮电大学': 'bupt', '南京邮电大学': 'njupt', '湖南大学': 'hnu',
  '中南大学': 'csu', '吉林大学': 'jlu', '南开大学': 'nankai', '香港科技大学': 'hkust',
};
/** 学院/方向关键词 → 缩写（按顺序匹配，同一文件可命中多个）。空字符串表示忽略该词。 */
export const DEPT_ABBR = [
  ['集成电路科学与工程', 'ic'], ['集成电路', 'ic'], ['微纳电子', 'ic'], ['新材料', 'sam'],
  ['材料科学与工程', 'mse'], ['材料', 'mse'], ['环境与能源', 'see'], ['电子科学与技术', 'ee'],
  ['电子工程', 'ee'], ['电子', 'ee'], ['信息工程', 'sece'], ['信电', 'isee'], ['电信', 'eie'],
  ['计算机', 'cs'], ['人工智能', 'ai'], ['软件', 'ss'], ['物理', 'phys'], ['化学', 'chem'],
  ['自动化', 'au'], ['通信', 'comm'], ['光电', 'oe'], ['能源', 'energy'], ['深研院', 'sigs'], ['深圳', 'sz'],
  ['冬令营', ''], ['夏令营', ''], ['科学营', ''], ['方向', ''],
];

// ---------------------------------------------------------------- 清洗与报告
/** 固定免责声明段落：以这句话开头的整段改成 <aside class="disclaimer">（§5.2-4）。 */
export const DISCLAIMER_PREFIX = '本资料由作者本人及合作同学的亲历回忆';

/** 报告里提示的内部用语（§5.2-6，只提示不修改）。 */
export const INTERNAL_TERMS = [
  '待作者补充', '待作者确认', '待团队核对', '待审校', '待定稿', '不单独销售', '暂不销售', '不开放收款',
  '单售门槛', '来源台账', '内部台账', '内部来源表', '内部', 'Codex', 'Claude', 'sale_ready', '草稿',
  'B级', 'A版', 'collab', 'licensed', 'R3',
];
/** 上面这些词里，也常出现在正常表述中的（如“内部结构”“草稿纸”），报告里单独记为“疑似”。 */
export const INTERNAL_TERMS_WEAK = ['内部', '草稿', 'B级', 'A版', 'R3'];

/** 报告阈值：列数 ≥ wideCols、行数 ≥ longRows 或单元格字数 ≥ longCell 的表格会被列出。 */
// pdfCardCols：PDF 里列数 ≥ 这个值的表格改成“逐条卡片”排版（A4 竖版放不下）
export const TABLE_LIMITS = { wideCols: 7, longRows: 30, longCell: 240, pdfCardCols: 9 };

// ---------------------------------------------------------------- 发布前检查（公开页 × 锁定正文）
/**
 * build-content 把每个公开页（售卖页、试读、服务介绍）和全部锁定正文逐句比对（规则见 lib-content/leak-gate.mjs）：
 *   minChars      少于这么多字的短句不比对（标题、短语容易撞车）
 *   minSentences  一篇正文累计重复不到这么多句时不处理
 *   maxRatio / maxSentences  别的公开页（服务介绍页、其他产品的页面）累计公开某篇正文超过这个比例或句数 → 不发布这些页面
 *   ownMaxRatio   产品自己的售卖页 + 试读合计公开了本产品正文的这个比例以上 → 不发布（防止误把整份资料当试读）
 */
export const LEAK_LIMITS = { minChars: 12, minSentences: 5, maxRatio: 0.2, maxSentences: 30, ownMaxRatio: 0.3 };
/** 确认是有意公开的重复，在这里登记后不再拦截：'<公开页路径>|<产品 id>/<docId>'，例如 'services/T_CV.html|KIT/T_CV'。 */
export const LEAK_ALLOW = [
  // 四周陪跑介绍页与「全程陪跑计划」共有的 6 句都是服务条款（答疑频次、新增任务先评估、结案记录、不代写推荐信等），
  // 本来就应该对外说明；不是模板正文。如不同意，删掉这一行即可（四周陪跑介绍页会暂停发布）。
  'services/T_RUN4.html|KIT/T_RUNALL',
];
