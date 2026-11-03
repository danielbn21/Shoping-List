# Generates two test receipts (English, and Hebrew laid out right-to-left) used by e2e.py. Needs Pillow and the DejaVu fonts.
import random, re
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
font, bold = ImageFont.truetype(FONT, 30), ImageFont.truetype(BOLD, 34)
heb = lambda s: re.sub(r'[\u0590-\u05FF][\u0590-\u05FF \.\"\'\u05f4]*[\u0590-\u05FF]|[\u0590-\u05FF]', lambda m: m.group(0)[::-1], s)  # PIL draws left-to-right

def make(path, rows, total, label, rtl=False, angle=0.5):
    W, H = 640, 120 + 52 * len(rows) + 170
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im); y = 20
    d.text((W // 2 - 120, y), "SUPER DEAL", font=bold, fill="black"); y += 70
    for left, right in rows:
        d.text((30, y), left, font=font, fill="black")
        if right: d.text((W - 30 - d.textlength(right, font=font), y), right, font=font, fill="black")
        y += 52
    y += 20
    d.text((30, y), total if rtl else label, font=bold, fill="black")
    d.text((W - 30 - d.textlength(label if rtl else total, font=bold), y), label if rtl else total, font=bold, fill="black")
    im.rotate(angle, fillcolor="white", resample=Image.BICUBIC).save(path, quality=88)

random.seed(3)
make("/tmp/receipt_en.jpg", [("Milk 3% 1L", "7.90"), ("Bread", "12.50"), ("Tomatoes", "9.80"), ("Cucumbers 2 x 4.50", "9.00"), ("Rice 1kg", "14.90")], "54.10", "TOTAL")
make("/tmp/receipt_he.jpg", [("7.90", heb("חלב 3%")), ("12.50", heb("לחם אחיד")), ("9.80", heb("עגבניות")), ("14.90", heb("אורז בסמטי")), ("22.00", heb("שמן זית"))], "67.10", heb("סה״כ"), rtl=True)
print("wrote /tmp/receipt_en.jpg and /tmp/receipt_he.jpg")
