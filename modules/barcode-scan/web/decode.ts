// Reading a barcode from the camera. Chrome on Android reads barcodes itself (BarcodeDetector); Safari on iPhone does not, so everything
// else uses ZXing's EAN/UPC readers in plain JavaScript. Only those readers are imported (from their own files, not the library's index)
// so the module stays small. Both give back the digits; the caller checks the check digit.
import EAN13Reader from '@zxing/library/esm/core/oned/EAN13Reader';
import EAN8Reader from '@zxing/library/esm/core/oned/EAN8Reader';
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap';
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer';
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource';

// EAN-8, UPC-A (12), EAN-13 and GTIN-14: the last digit is a check digit over the others.
export function validBarcode(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number);
  const check = d.pop() as number;
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export type Decoder = { kind: 'native' | 'js'; decode: (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null> };

export async function makeDecoder(): Promise<Decoder> {
  const BD = (globalThis as any).BarcodeDetector;
  if (BD) {
    try {
      const formats: string[] = await BD.getSupportedFormats();
      const want = ['ean_13', 'ean_8', 'upc_a'].filter((f) => formats.includes(f));
      if (want.length) {
        const det = new BD({ formats: want });
        return { kind: 'native', decode: async (video) => { try { return (await det.detect(video))[0]?.rawValue ?? null; } catch { return null; } } };
      }
    } catch { /* fall through to the JavaScript reader */ }
  }
  const ean13 = new EAN13Reader(), ean8 = new EAN8Reader();
  return {
    kind: 'js',
    decode: async (video, canvas) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      // the middle band of the picture, scaled down: fast enough for a phone, and where the user aims
      const sw = vw, sh = Math.round(vh * 0.5), sy = Math.round(vh * 0.25);
      const w = Math.min(sw, 800), h = Math.round(sh * (w / sw));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, sy, sw, sh, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (px[p] * 306 + px[p + 1] * 601 + px[p + 2] * 117) >> 10;
      const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, w, h)));
      for (const reader of [ean13, ean8]) {
        try { return reader.decode(bitmap).getText(); } catch { /* not found in this frame */ }
      }
      return null;
    },
  };
}
