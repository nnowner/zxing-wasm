import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import * as full from "../src/full/index.js";
import * as reader from "../src/reader/index.js";

const png = await readFile(
  new URL("./samples/qrcode/wikipedia.png", import.meta.url),
);
// Progressive JPEG, 800x551.
const jpeg = await readFile(
  new URL("../zxing-cpp/test/samples/dxfilmedge-1/1.jpg", import.meta.url),
);
// Baseline JPEG, 100x99, QR code.
const baselineJpeg = await readFile(
  new URL("../zxing-cpp/test/samples/qrcode-2/%23199b.jpg", import.meta.url),
);

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

describe.each([
  { name: "reader", mod: reader, wasm: "../src/reader/zxing_reader.wasm" },
  { name: "full", mod: full, wasm: "../src/full/zxing_full.wasm" },
])("decodeImage ($name)", ({ mod, wasm }) => {
  beforeAll(async () => {
    await mod.prepareZXingModule({
      overrides: {
        wasmBinary: toArrayBuffer(
          await readFile(new URL(wasm, import.meta.url)),
        ),
      },
      fireImmediately: true,
    });
  });

  test("decodes PNG bytes into RGBA pixels", async () => {
    const decoded = await mod.decodeImage(png);
    expect(decoded.width).toBe(296);
    expect(decoded.height).toBe(296);
    expect(decoded.data).toBeInstanceOf(Uint8ClampedArray);
    expect(decoded.data.byteLength).toBe(296 * 296 * 4);
    // RGB source without alpha: stb fills alpha with 255.
    expect(decoded.data[3]).toBe(255);
    expect(Object.keys(decoded).sort()).toEqual(["data", "height", "width"]);
  });

  test("decodes progressive JPEG bytes", async () => {
    const decoded = await mod.decodeImage(jpeg);
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(551);
    expect(decoded.data.byteLength).toBe(800 * 551 * 4);
  });

  test("returns a JS-owned copy rather than a view into WASM memory", async () => {
    const zxingModule = await mod.prepareZXingModule({ fireImmediately: true });
    const decoded = await mod.decodeImage(png);
    expect(decoded.data.buffer).not.toBe(zxingModule.HEAPU8.buffer);
  });

  test("accepts Uint8Array, ArrayBuffer and Blob inputs", async () => {
    const expected = await mod.decodeImage(png);
    for (const input of [
      new Uint8Array(png),
      toArrayBuffer(png),
      new Blob([new Uint8Array(png)]),
    ]) {
      expect(await mod.decodeImage(input)).toEqual(expected);
    }
  });

  test("decoded pixels can be fed back into readBarcodes", async () => {
    const decoded = await mod.decodeImage(png);
    const results = await mod.readBarcodes(decoded as unknown as ImageData);
    expect(results.map(({ text }) => text)).toEqual([
      "http://en.m.wikipedia.org",
    ]);
  });

  // A JPEG without an EOI marker violates the spec. stb rejects it since
  // nothings/stb@e4efdc8, and decodeImage deliberately does not repair it.
  test("rejects JPEGs whose EOI marker is replaced by padding", async () => {
    expect(baselineJpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    const padded = new Uint8Array(baselineJpeg.length);
    padded.set(baselineJpeg.subarray(0, -2));
    await expect(mod.decodeImage(padded)).rejects.toThrow(
      "Failed to load image from memory",
    );
  });

  // Conforming JPEGs may carry vendor data after EOI (e.g. Samsung "SEFT").
  test("ignores data after EOI, as in JPEGs with vendor trailers", async () => {
    // A marker-like FF E1, then bytes ending in "SEFT" like Samsung trailers.
    const trailer = new Uint8Array([
      0xff, 0xe1, 0x00, 0x08, 0x6a, 0x75, 0x6e, 0x6b, 0x00, 0x00, 0x53, 0x45,
      0x46, 0x54,
    ]);
    const withTrailer = new Uint8Array(baselineJpeg.length + trailer.length);
    withTrailer.set(baselineJpeg);
    withTrailer.set(trailer, baselineJpeg.length);
    expect(await mod.decodeImage(withTrailer)).toEqual(
      await mod.decodeImage(baselineJpeg),
    );
  });

  test("rejects bytes that are not a supported image", async () => {
    await expect(mod.decodeImage(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      "Failed to load image from memory",
    );
    // The module stays usable after a failed decode.
    expect((await mod.decodeImage(png)).width).toBe(296);
  });
});
