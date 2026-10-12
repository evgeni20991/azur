"""Единая сетка кадрирования для всех товаров: набор должен выглядеть
снятым в одну съёмку, а не собранным из разных источников."""
import sys, os
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
tw, th = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (900, 1200)
im = Image.open(src).convert('RGB')
r = max(tw / im.width, th / im.height)
im = im.resize((round(im.width * r), round(im.height * r)), Image.LANCZOS)
l = (im.width - tw) // 2
t = int((im.height - th) * 0.5)
im.crop((l, t, l + tw, t + th)).save(dst, quality=84, method=6)
print(f'  {os.path.basename(dst)} {tw}x{th} {round(os.path.getsize(dst)/1024)} KB')
