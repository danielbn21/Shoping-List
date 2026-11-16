"""Writes /tmp/barcode_a.y4m and /tmp/barcode_b.y4m: a fake camera picture of an EAN-13 barcode, for e2e_scan.py.
   Chromium plays such a file as the camera (--use-file-for-fake-video-capture)."""
import sys
from PIL import Image, ImageDraw

L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"]
G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"]
R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"]
PAR = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"]

def with_check(base12):
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(base12))
    return base12 + str((10 - s % 10) % 10)

def modules(code):
    p = PAR[int(code[0])]
    bits = "101"
    for i, d in enumerate(code[1:7]):
        bits += (L if p[i] == "L" else G)[int(d)]
    bits += "01010"
    for d in code[7:]:
        bits += R[int(d)]
    return bits + "101"

def y4m(code, path, w=640, h=480, frames=30, scale=4):
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    bits = modules(code)
    x0 = (w - len(bits) * scale) // 2
    for i, b in enumerate(bits):
        if b == "1":
            d.rectangle([x0 + i * scale, h // 2 - 90, x0 + (i + 1) * scale - 1, h // 2 + 90], fill=0)
    y = img.tobytes()
    uv = bytes([128]) * ((w // 2) * (h // 2))
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F30:1 Ip A1:1 C420jpeg\n".encode())
        for _ in range(frames):
            f.write(b"FRAME\n" + y + uv + uv)

if __name__ == "__main__":
    a, b = with_check("729000000001"), with_check("729000000002")
    y4m(a, "/tmp/barcode_a.y4m"); y4m(b, "/tmp/barcode_b.y4m")
    print(a, b)
