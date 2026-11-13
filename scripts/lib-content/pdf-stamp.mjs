// 构建时给 PDF 预留授权标识（docs/ARCHITECTURE.md §5.4）。
// 每页叠加一行淡色斜向文字「LICENSED ####-####-#### · ~~~~-~~-~~」，并写入同样内容的 XMP 元数据。
// 占位符所在的流不压缩，保存后用 findStampSlots 记下字节位置；下载时 Worker 只改写这几处字节
// （src/worker/pdf-stamp.js 的 applyPdfStamp），把占位符换成买家的密钥和日期。
import { PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { STAMP_CODE_SLOT, STAMP_DAY_SLOT, stampText } from '../../src/worker/pdf-stamp.js';

export { findStampSlots, applyPdfStamp } from '../../src/worker/pdf-stamp.js';

const FONT_KEY = 'BysLicF';
const GS_KEY = 'BysLicGS';
// 只用来排版（算宽度、居中）；真实密钥与占位符字宽略有差别，居中误差可以忽略
const SAMPLE = stampText('ABCD-EFGH-JKMN', '2026-01-01');
const n = (x) => (Math.abs(x) < 1e-6 ? '0' : x.toFixed(4).replace(/\.?0+$/, ''));
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 一页的叠加内容流（ASCII；「·」写成八进制转义 \267，即 WinAnsi 的 0xB7）。 */
function stampOperators(font, { width, height, x0, y0, rot }) {
  const [vw, vh] = rot === 90 || rot === 270 ? [height, width] : [width, height];
  const diag = Math.hypot(vw, vh);
  let size = Math.min(vw, vh) * 0.05;
  const maxW = diag * 0.72;
  const w0 = font.widthOfTextAtSize(SAMPLE, size);
  if (w0 > maxW) size *= maxW / w0;
  const tw = font.widthOfTextAtSize(SAMPLE, size);
  const capH = font.heightAtSize(size, { descender: false });
  const theta = Math.atan2(vh, vw) + (rot * Math.PI) / 180; // 抵消 /Rotate，按显示方向斜着读
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const cx = x0 + width / 2, cy = y0 + height / 2;
  const x = cx - (tw / 2) * cos + (capH / 2) * sin;
  const y = cy - (tw / 2) * sin - (capH / 2) * cos;
  const literal = `(LICENSED ${STAMP_CODE_SLOT} \\267 ${STAMP_DAY_SLOT})`;
  return [
    '/Artifact <</Type /Pagination /Subtype /Watermark>> BDC',
    'q',
    `/${GS_KEY} gs`,
    '0.42 0.48 0.58 rg',
    'BT',
    `/${FONT_KEY} ${n(size)} Tf`,
    `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(x)} ${n(y)} Tm`,
    `${literal} Tj`,
    'ET',
    'Q',
    'EMC',
    '',
  ].join('\n');
}

function xmpPacket({ title, rights }) {
  return `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${xml(rights)}</rdf:li></rdf:Alt></dc:rights>
   <xmpRights:Marked>True</xmpRights:Marked>
   <xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang="x-default">${xml(rights)}</rdf:li></rdf:Alt></xmpRights:UsageTerms>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * 给已经排好版的 PDFDocument 加上授权标识占位符（原地修改，之后照常 doc.save()）。
 * 同样尺寸、同样旋转的页面共用一个叠加内容流，所以占位符只有寥寥几处。
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {{title?:string, usage?:string}} opts  title 写进 XMP；usage 是使用范围说明（如「仅供购买者个人学习使用」）
 */
export async function addStampPlaceholders(doc, { title = '', usage = '仅供购买者个人学习使用' } = {}) {
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const gsRef = ctx.register(ctx.obj({ Type: 'ExtGState', ca: 0.16, CA: 0.16 }));
  const streams = new Map(); // 页面几何 → 叠加内容流 ref
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const { x: x0, y: y0 } = page.getMediaBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const geo = { width, height, x0, y0, rot };
    const key = JSON.stringify(geo);
    if (!streams.has(key)) streams.set(key, ctx.register(ctx.stream(stampOperators(font, geo))));
    const leaf = page.node;
    leaf.normalize(); // Contents 变成数组并包上 q … Q，原有内容的坐标变换不会影响叠加层
    const { Font, ExtGState } = leaf.normalizedEntries();
    // 资源字典可能被多页共用：已经是本次加的就跳过检查，是别的东西说明这份 PDF 处理过
    const oldF = Font.get(PDFName.of(FONT_KEY)), oldG = ExtGState.get(PDFName.of(GS_KEY));
    if ((oldF && oldF !== font.ref) || (oldG && oldG !== gsRef)) throw new Error('这份 PDF 已经加过授权标识占位符');
    leaf.setFontDictionary(PDFName.of(FONT_KEY), font.ref);
    leaf.setExtGState(PDFName.of(GS_KEY), gsRef);
    leaf.addContentStream(streams.get(key));
  }
  const rights = `${stampText(STAMP_CODE_SLOT, STAMP_DAY_SLOT)} ${usage}`;
  const meta = ctx.register(PDFRawStream.of(
    ctx.obj({ Type: 'Metadata', Subtype: 'XML' }),
    new TextEncoder().encode(xmpPacket({ title, rights })),
  ));
  doc.catalog.set(PDFName.of('Metadata'), meta);
  return doc;
}
