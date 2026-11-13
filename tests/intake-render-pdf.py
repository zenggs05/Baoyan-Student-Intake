# 把 PDF 每页渲染成 PNG，便于视觉检查。
# 用法：python -I tests/intake-render-pdf.py <in.pdf> <out-prefix> [zoom]
import sys
import pymupdf

src, prefix = sys.argv[1], sys.argv[2]
zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 1.3
doc = pymupdf.open(src)
print(f"pages={doc.page_count}")
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    out = f"{prefix}-p{i + 1}.png"
    pix.save(out)
    print(out)
