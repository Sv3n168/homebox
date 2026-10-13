import { BrowserMultiFormatReader } from "@zxing/library";

type DecodeCallback = Parameters<BrowserMultiFormatReader["decodeContinuously"]>[1];

/**
 * zxing's video loop stops for good on any error other than "not found",
 * checksum or format. Printed labels (glare, angle, small print) regularly
 * trigger such odd errors for single frames, which froze the scanner. This
 * reader treats every failed frame as "try the next one".
 */
export class TolerantReader extends BrowserMultiFormatReader {
  private stopped = false;

  override decodeContinuously(element: HTMLVideoElement, callbackFn: DecodeCallback): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      try {
        const result = this.decode(element);
        callbackFn(result);
        setTimeout(loop, this.timeBetweenScansMillis);
      } catch (e) {
        callbackFn(null as never, e as Parameters<DecodeCallback>[1]);
        setTimeout(loop, Math.max(this.timeBetweenDecodingAttempts, 50));
      }
    };
    loop();
  }

  override stopContinuousDecode(): void {
    this.stopped = true;
    super.stopContinuousDecode();
  }

  override reset(): void {
    this.stopped = true;
    super.reset();
  }
}
