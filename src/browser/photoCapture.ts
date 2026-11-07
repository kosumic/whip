/** Transient camera UI requests; Rust owns the tool contract and deadline. */
export interface PhotoCaptureOptions {
  facing: 'front' | 'back';
  max_dimension: number;
  max_base64_chars: number;
}

export interface CapturedPhoto {
  image: string;
  mime_type: 'image/jpeg';
  width: number;
  height: number;
}

export interface PhotoCaptureRequest {
  id: number;
  options: PhotoCaptureOptions;
  signal: AbortSignal;
  complete: (photo: CapturedPhoto) => void;
  fail: (error: Error) => void;
}

export function photoCaptureError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class PhotoCaptureController {
  private request: PhotoCaptureRequest | null = null;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  readonly snapshot = () => this.request;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  capture(options: PhotoCaptureOptions, signal: AbortSignal): Promise<CapturedPhoto> {
    if (signal.aborted)
      return Promise.reject(photoCaptureError('cancelled', 'Photo capture cancelled'));
    if (this.request)
      return Promise.reject(photoCaptureError('device_unavailable', 'Another photo capture is already open'));
    return new Promise((resolve, reject) => {
      const finish = (photo?: CapturedPhoto, error?: Error) => {
        if (this.request !== request) return;
        signal.removeEventListener('abort', cancel);
        this.request = null;
        if (photo) resolve(photo);
        else reject(error ?? photoCaptureError('cancelled', 'Photo capture cancelled'));
        this.changed();
      };
      const cancel = () => finish();
      const request: PhotoCaptureRequest = {
        id: ++this.nextId,
        options, signal,
        complete: photo => finish(photo),
        fail: error => finish(undefined, error),
      };
      this.request = request;
      signal.addEventListener('abort', cancel, { once: true });
      this.changed();
    });
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }
}

export const photoCapture = new PhotoCaptureController();
