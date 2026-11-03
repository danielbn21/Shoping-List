import { apiUpload } from './api';

// Shrink a camera photo before upload: a 12 MP photo is ~4 MB, a 2000 px JPEG is a few hundred KB and still readable by OCR.
// createImageBitmap also applies the photo's EXIF rotation, so the picture is the right way up on the server.
export async function compressImage(file: Blob, maxSide = 2000, quality = 0.85): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return blob ?? file;
  } catch {
    return file; // e.g. a format the browser cannot decode: let the server judge it
  }
}

export async function uploadReceiptPhoto(tripId: number, photo: Blob) {
  return apiUpload<{ id: number; ocrStatus: string }>(`/trips/${tripId}/receipts`, await compressImage(photo));
}
