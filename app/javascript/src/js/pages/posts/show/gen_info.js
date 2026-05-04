/**
 * GenInfo Extractor
 *
 * Extracts generation parameters from image files:
 * - PNG: tEXt and zTXt chunks (pnginfo)
 * - JPEG: EXIF UserComment (piexif unicode encoding)
 * - Reforge "stealth pnginfo" in PNG/WEBP pixel LSBs (alpha or RGB channels)
 */

const GenInfo = {};

// PNG signature: 0x89 P N G \r \n 0x1A \n
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// EXIF constants
const EXIF_IFD_TAG = 0x8769;
const USER_COMMENT_TAG = 0x9286;

/**
 * Parse PNG tEXt and zTXt chunks from an ArrayBuffer.
 */
GenInfo.parsePngChunks = async function (buffer) {
  const view = new DataView(buffer);
  const chunks = [];

  // Verify PNG signature
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (view.getUint8(i) !== PNG_SIGNATURE[i]) {
      return [];
    }
  }

  const latin1 = new TextDecoder("latin1");
  let offset = 8; // Skip signature

  while (offset < buffer.byteLength - 12) {
    const length = view.getUint32(offset);
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const type = String.fromCharCode(...typeBytes);

    if (type === "tEXt" || type === "zTXt") {
      const data = new Uint8Array(buffer, offset + 8, Math.min(length, buffer.byteLength - offset - 12));
      const nullIndex = data.indexOf(0);
      if (nullIndex !== -1) {
        const keyword = latin1.decode(data.subarray(0, nullIndex));
        let text = data.subarray(nullIndex + 1);
        if (type === "zTXt") {
          // Skip compression method byte (always 0 = deflate), then decompress
          text = await GenInfo.inflate(text.subarray(1));
        }
        chunks.push({ keyword, text: latin1.decode(text) });
      }
    }

    // Move to next chunk: 4 (length) + 4 (type) + length (data) + 4 (CRC)
    offset += 12 + length;
  }

  return chunks;
};

/**
 * Parse JPEG EXIF UserComment from an ArrayBuffer.
 * Follows the same approach as piexif: find APP1, walk IFD0 -> ExifIFD -> UserComment.
 * Returns chunks array compatible with PNG output format.
 */
GenInfo.parseJpegUserComment = function (buffer) {
  const view = new DataView(buffer);

  // Verify JPEG SOI marker
  if (view.getUint16(0) !== 0xFFD8) {
    throw new Error("Not a valid JPEG file");
  }

  // Find APP1 (Exif) marker
  let offset = 2;
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) {
      const segmentLength = view.getUint16(offset + 2);
      const segmentStart = offset + 4;

      // Check for "Exif\0\0" header
      if (
        view.getUint32(segmentStart) === 0x45786966 // "Exif"
        && view.getUint16(segmentStart + 4) === 0x0000
      ) {
        return GenInfo.parseExifUserComment(buffer, segmentStart + 6, segmentLength - 2);
      }
    }

    // Not APP1 or not Exif — skip this segment
    if ((marker & 0xFF00) !== 0xFF00) break; // Not a valid marker
    const len = view.getUint16(offset + 2);
    offset += 2 + len;
  }

  return [];
};

/**
 * Parse EXIF IFDs to extract UserComment.
 * tiffStart is the absolute offset of the TIFF header ("II" or "MM") in the buffer.
 */
GenInfo.parseExifUserComment = function (buffer, tiffStart) {
  const view = new DataView(buffer);

  // Read byte order
  const byteOrder = view.getUint16(tiffStart);
  const le = byteOrder === 0x4949; // "II" = little-endian

  const getU16 = (off) => view.getUint16(tiffStart + off, le);
  const getU32 = (off) => view.getUint32(tiffStart + off, le);

  // IFD0 offset (from TIFF header)
  const ifd0Offset = getU32(4);

  // Walk IFD0 to find ExifIFD pointer
  const ifd0Entries = getU16(ifd0Offset);
  let exifIfdOffset = null;
  for (let i = 0; i < ifd0Entries; i++) {
    const entryOff = ifd0Offset + 2 + (i * 12);
    if (getU16(entryOff) === EXIF_IFD_TAG) {
      exifIfdOffset = getU32(entryOff + 8);
      break;
    }
  }

  if (exifIfdOffset === null) return [];

  // Walk ExifIFD to find UserComment
  const exifEntries = getU16(exifIfdOffset);
  for (let i = 0; i < exifEntries; i++) {
    const entryOff = exifIfdOffset + 2 + (i * 12);
    if (getU16(entryOff) === USER_COMMENT_TAG) {
      const count = getU32(entryOff + 4);
      // Value offset (UNDEFINED type, count > 4 means offset is stored)
      const valueOffset = count > 4 ? getU32(entryOff + 8) : entryOff + 8;
      const commentBytes = new Uint8Array(buffer, tiffStart + valueOffset, Math.min(count, buffer.byteLength - tiffStart - valueOffset));

      // First 8 bytes are charset identifier
      const charset = String.fromCharCode(...commentBytes.slice(0, 8)).replace(/\0/g, "");
      const payload = commentBytes.slice(8);

      let text;
      if (charset === "UNICODE") {
        text = new TextDecoder("utf-16be").decode(payload);
      } else {
        text = GenInfo.decodeText(payload);
      }

      if (text) {
        return [{ keyword: "parameters", text }];
      }
    }
  }

  return [];
};

/**
 * Decompress deflate/zlib data using the browser's DecompressionStream.
 */
GenInfo.inflate = async function (data) {
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Decompress gzip data using the browser's DecompressionStream.
 */
GenInfo.gunzip = async function (data) {
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Read bytes from pixel LSBs in column-major order (x outer, y inner).
 *
 * mode "alpha": 1 bit per pixel from alpha LSB
 * mode "rgb":   3 bits per pixel from R, G, B LSBs
 */
GenInfo.readLSBBytes = function (imageData, mode, byteCount) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(byteCount);
  let buffer = 0;
  let bitCount = 0;
  let byteIndex = 0;

  for (let x = 0; x < width && byteIndex < byteCount; x++) {
    for (let y = 0; y < height && byteIndex < byteCount; y++) {
      const i = (y * width + x) * 4;

      if (mode === "alpha") {
        buffer = (buffer << 1) | (data[i + 3] & 1);
        bitCount += 1;
      } else {
        buffer = (buffer << 1) | (data[i] & 1);
        buffer = (buffer << 1) | (data[i + 1] & 1);
        buffer = (buffer << 1) | (data[i + 2] & 1);
        bitCount += 3;
      }

      while (bitCount >= 8 && byteIndex < byteCount) {
        bitCount -= 8;
        out[byteIndex++] = (buffer >> bitCount) & 0xFF;
      }
    }
  }

  return out;
};

/**
 * Try to decode stealth data from one channel (alpha or rgb).
 * Returns {keyword, text} or null if no valid signature found.
 *
 * Reference: https://github.com/Panchovix/stable-diffusion-webui-reForge/blob/739b2e1d/modules/stealth_infotext.py
 */
GenInfo.tryDecodeStealth = async function (imageData, mode) {
  const SIGNATURE_LEN = 15; // "stealth_pnginfo".length
  const signatures = mode === "alpha"
    ? { plain: "stealth_pnginfo", compressed: "stealth_pngcomp" }
    : { plain: "stealth_rgbinfo", compressed: "stealth_rgbcomp" };

  // Read signature (15 bytes) + length field (4 bytes)
  const header = GenInfo.readLSBBytes(imageData, mode, SIGNATURE_LEN + 4);
  const sig = new TextDecoder("utf-8").decode(header.subarray(0, SIGNATURE_LEN));

  const compressed = sig === signatures.compressed;
  if (!compressed && sig !== signatures.plain) return null;

  // Length field is payload size in bits
  const payloadBits = new DataView(header.buffer).getInt32(SIGNATURE_LEN);
  const payloadBytes = Math.floor(payloadBits / 8);
  if (payloadBytes <= 0) return null;

  // Read full data: signature + length + payload
  const totalBytes = SIGNATURE_LEN + 4 + payloadBytes;
  const allData = GenInfo.readLSBBytes(imageData, mode, totalBytes);
  let payload = allData.subarray(SIGNATURE_LEN + 4);

  if (compressed) {
    payload = await GenInfo.gunzip(payload);
  }

  return {
    keyword: `stealth (${mode})`,
    text: new TextDecoder("utf-8").decode(payload),
  };
};

/**
 * Decode reForge "stealth pnginfo" from pixel LSBs.
 * Tries both alpha and RGB channels independently.
 */
GenInfo.decodeStealthData = async function (blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const results = [];
  for (const mode of ["alpha", "rgb"]) {
    try {
      const result = await GenInfo.tryDecodeStealth(imageData, mode);
      if (result) results.push(result);
    } catch { /* no stealth data in this channel */ }
  }
  return results;
};

/**
 * Fetch image metadata.
 * For PNG/WEBP: fetches full file to support stealth decoding.
 * For JPEG: uses Range request (stealth doesn't apply).
 */
GenInfo.fetchMetadata = async function (url, fileExt) {
  const supportsStealthFormats = ["png", "webp"];
  const useRange = !supportsStealthFormats.includes(fileExt);

  const headers = {};
  if (useRange) {
    headers["Range"] = "bytes=0-32767";
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const blob = await response.blob();
  let chunks = [];

  // Try stealth decoding for PNG/WEBP
  if (supportsStealthFormats.includes(fileExt)) {
    try {
      chunks = await GenInfo.decodeStealthData(blob);
    } catch { /* no stealth data */ }
  }

  const buffer = await blob.arrayBuffer();

  if (fileExt === "png") {
    return chunks.concat(await GenInfo.parsePngChunks(buffer));
  }
  if (fileExt === "jpg" || fileExt === "jpeg") {
    return chunks.concat(GenInfo.parseJpegUserComment(buffer));
  }

  return chunks;
};

/**
 * Render metadata chunks to HTML
 */
GenInfo.renderMetadata = function (chunks) {
  if (!chunks || chunks.length === 0) return null;

  const $details = $("<details>").attr("id", "gen-info");
  $details.append($("<summary>").text("Generation Info"));

  const $content = $("<div>").addClass("gen-info-content");

  chunks.forEach(chunk => {
    const $item = $("<div>").addClass("gen-info-item");
    $item.append($("<div>").addClass("gen-info-key").text(chunk.keyword));
    $item.append($("<code>").addClass("gen-info-value").text(chunk.text));
    $content.append($item);
  });

  $details.append($content);
  return $details;
};

/**
 * Get the original file URL and extension (handle sample URL rewriting)
 */
GenInfo.getOriginalUrl = function () {
  const $container = $("#image-container");
  if (!$container.length) return null;

  const fileExt = $container.data("file-ext");
  if (!["png", "jpg", "jpeg", "webp"].includes(fileExt)) return null;

  const postData = $container.data("post");
  const url = postData?.file?.url || null;
  if (!url) return null;

  return { url, fileExt };
};

/**
 * Fetch and render metadata, inserting it into the page.
 * Returns true if metadata was found, false otherwise.
 */
GenInfo.loadAndShow = async function () {
  const result = GenInfo.getOriginalUrl();
  if (!result) return false;

  const $container = $("#gen-info-container");
  if (!$container.length) return false;

  const chunks = await GenInfo.fetchMetadata(result.url, result.fileExt);
  const $element = GenInfo.renderMetadata(chunks);

  if ($element) {
    $container.append($element);
    $element.attr("open", true);
    return true;
  }

  const $details = $("<details>")
    .attr({
      "id": "gen-info",
      "open": true,
    })
    .appendTo($container);
  $("<summary>").text("Generation Info").appendTo($details);
  $("<span>").text("No generation info found.").appendTo($details);
  return false;
};

export default GenInfo;
