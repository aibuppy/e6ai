/**
 * GenInfo Extractor
 *
 * Extracts generation parameters from media files:
 * - PNG: tEXt chunks (pnginfo)
 * - JPEG: EXIF UserComment (piexif unicode encoding)
 * - WebP: EXIF IFD0 tags (ComfyUI prompt/workflow)
 * - WebM: Matroska SimpleTag elements
 * - MP4: iTunes-style metadata atoms (moov/udta/meta)
 *
 * Uses HTTP Range requests to fetch only the header portion of the file.
 */

const GenInfo = {};

// Fetch sizes per format
const FETCH_BYTES_IMAGE = 32 * 1024;
const FETCH_BYTES_WEBP = 128 * 1024;
const FETCH_BYTES_VIDEO = 512 * 1024;

// PNG signature: 0x89 P N G \r \n 0x1A \n
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// EXIF constants
const EXIF_IFD_TAG = 0x8769;
const USER_COMMENT_TAG = 0x9286;

// Matroska EBML element IDs
const EBML_HEADER = 0x1A45DFA3;
const EBML_SEGMENT = 0x18538067;
const EBML_TAGS = 0x1254C367;
const EBML_TAG = 0x7373;
const EBML_SIMPLE_TAG = 0x67C8;
const EBML_TAG_NAME = 0x45A3;
const EBML_TAG_STRING = 0x4487;

// ─── PNG ──────────────────────────────────────────────────────────────

/**
 * Parse PNG chunks from an ArrayBuffer.
 * Stops when it hits IDAT (image data) since metadata comes before that.
 */
GenInfo.parsePngChunks = function (buffer) {
  const view = new DataView(buffer);
  const chunks = [];

  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (view.getUint8(i) !== PNG_SIGNATURE[i]) {
      throw new Error("Not a valid PNG file");
    }
  }

  let offset = 8;

  while (offset < buffer.byteLength - 12) {
    const length = view.getUint32(offset);
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const type = String.fromCharCode(...typeBytes);

    if (type === "IDAT") break;

    if (type === "tEXt") {
      const data = new Uint8Array(buffer, offset + 8, Math.min(length, buffer.byteLength - offset - 12));
      const nullIndex = data.indexOf(0);
      if (nullIndex !== -1) {
        chunks.push({
          keyword: GenInfo.decodeText(data.slice(0, nullIndex)),
          text: GenInfo.decodeText(data.slice(nullIndex + 1)),
        });
      }
    }

    offset += 12 + length;
  }

  return chunks;
};

// ─── JPEG ─────────────────────────────────────────────────────────────

/**
 * Parse JPEG EXIF UserComment from an ArrayBuffer.
 * Follows the same approach as piexif: find APP1, walk IFD0 -> ExifIFD -> UserComment.
 */
GenInfo.parseJpegUserComment = function (buffer) {
  const view = new DataView(buffer);

  if (view.getUint16(0) !== 0xFFD8) {
    throw new Error("Not a valid JPEG file");
  }

  let offset = 2;
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) {
      const segmentLength = view.getUint16(offset + 2);
      const segmentStart = offset + 4;

      if (
        view.getUint32(segmentStart) === 0x45786966
        && view.getUint16(segmentStart + 4) === 0x0000
      ) {
        return GenInfo.parseExifUserComment(buffer, segmentStart + 6, segmentLength - 2);
      }
    }

    if ((marker & 0xFF00) !== 0xFF00) break;
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
  const le = view.getUint16(tiffStart) === 0x4949;

  const getU16 = (off) => view.getUint16(tiffStart + off, le);
  const getU32 = (off) => view.getUint32(tiffStart + off, le);

  const ifd0Offset = getU32(4);
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

  const exifEntries = getU16(exifIfdOffset);
  for (let i = 0; i < exifEntries; i++) {
    const entryOff = exifIfdOffset + 2 + (i * 12);
    if (getU16(entryOff) === USER_COMMENT_TAG) {
      const count = getU32(entryOff + 4);
      const valueOffset = count > 4 ? getU32(entryOff + 8) : entryOff + 8;
      const commentBytes = new Uint8Array(buffer, tiffStart + valueOffset, Math.min(count, buffer.byteLength - tiffStart - valueOffset));

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

// ─── WebP ─────────────────────────────────────────────────────────────

/**
 * Parse WebP RIFF container to find EXIF chunk, then read IFD0 tags.
 * ComfyUI stores prompt/workflow in IFD0 Model (0x0110) and Make (0x010F) tags
 * as "keyname:{JSON}" strings.
 */
GenInfo.parseWebpChunks = function (buffer) {
  const view = new DataView(buffer);

  if (buffer.byteLength < 12) return [];
  if (view.getUint32(0) !== 0x52494646) return []; // "RIFF"
  if (view.getUint32(8) !== 0x57454250) return []; // "WEBP"

  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const fourcc = GenInfo.readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true); // RIFF is little-endian

    if (fourcc === "EXIF") {
      const chunks = GenInfo.parseWebpExifTags(buffer, offset + 8);
      // Also try UserComment as fallback (some third-party tools use it)
      if (chunks.length === 0) {
        return GenInfo.parseWebpExifUserComment(buffer, offset + 8);
      }
      return chunks;
    }

    // Chunks are padded to even byte boundary
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return [];
};

/**
 * Parse IFD0 ASCII tags from WebP EXIF data.
 * Reads tags that contain "key:value" format strings (ComfyUI convention).
 */
GenInfo.parseWebpExifTags = function (buffer, exifStart) {
  const view = new DataView(buffer);
  const chunks = [];

  // EXIF chunk may start with "Exif\0\0" or directly with TIFF header
  let tiffStart = exifStart;
  if (
    exifStart + 6 <= buffer.byteLength
    && view.getUint32(exifStart) === 0x45786966
    && view.getUint16(exifStart + 4) === 0x0000
  ) {
    tiffStart = exifStart + 6;
  }

  if (tiffStart + 8 > buffer.byteLength) return [];

  const le = view.getUint16(tiffStart) === 0x4949;
  const getU16 = (off) => view.getUint16(tiffStart + off, le);
  const getU32 = (off) => view.getUint32(tiffStart + off, le);

  const ifd0Offset = getU32(4);
  if (tiffStart + ifd0Offset + 2 > buffer.byteLength) return [];

  const ifd0Entries = getU16(ifd0Offset);

  for (let i = 0; i < ifd0Entries; i++) {
    const entryOff = ifd0Offset + 2 + (i * 12);
    if (tiffStart + entryOff + 12 > buffer.byteLength) break;

    const type = getU16(entryOff + 2);
    if (type !== 2) continue; // Only ASCII strings (type 2)

    const count = getU32(entryOff + 4);
    if (count < 3) continue; // Too short for "k:v"

    const valueOffset = count <= 4 ? entryOff + 8 : getU32(entryOff + 8);
    const absOffset = tiffStart + valueOffset;
    if (absOffset + count > buffer.byteLength) continue;

    const strBytes = new Uint8Array(buffer, absOffset, count);
    let str = GenInfo.decodeText(strBytes).replace(/\0+$/, "");

    // ComfyUI format: "keyname:{JSON}"
    const colonIndex = str.indexOf(":");
    if (colonIndex > 0) {
      chunks.push({
        keyword: str.substring(0, colonIndex),
        text: str.substring(colonIndex + 1),
      });
    }
  }

  return chunks;
};

/**
 * Fallback: try reading EXIF UserComment from WebP (for third-party tools).
 */
GenInfo.parseWebpExifUserComment = function (buffer, exifStart) {
  let tiffStart = exifStart;
  const view = new DataView(buffer);
  if (
    exifStart + 6 <= buffer.byteLength
    && view.getUint32(exifStart) === 0x45786966
    && view.getUint16(exifStart + 4) === 0x0000
  ) {
    tiffStart = exifStart + 6;
  }
  if (tiffStart + 8 > buffer.byteLength) return [];
  return GenInfo.parseExifUserComment(buffer, tiffStart);
};

// ─── WebM (Matroska/EBML) ─────────────────────────────────────────────

/**
 * Read an EBML variable-length integer.
 * For element IDs, the marker bit is part of the value.
 * For sizes, the marker bit is stripped.
 * Returns { value, width } or null.
 */
GenInfo.readEbmlVint = function (view, offset, isSize) {
  if (offset >= view.byteLength) return null;
  const first = view.getUint8(offset);
  if (first === 0) return null;

  let width = 1;
  let mask = 0x80;
  while (width <= 8 && !(first & mask)) {
    width++;
    mask >>= 1;
  }
  if (width > 4) return null; // We only handle up to 4-byte VINTs for simplicity

  let value = isSize ? (first & ~mask) : first;
  for (let i = 1; i < width; i++) {
    if (offset + i >= view.byteLength) return null;
    value = value * 256 + view.getUint8(offset + i);
  }

  return { value, width };
};

/**
 * Parse WebM file for Matroska Tags containing prompt/workflow metadata.
 * ComfyUI/VHS stores metadata as SimpleTag elements with TagName/TagString.
 */
GenInfo.parseWebmTags = function (buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) return [];

  // Verify EBML header
  const headerId = GenInfo.readEbmlVint(view, 0, false);
  if (!headerId || headerId.value !== EBML_HEADER) return [];
  const headerSize = GenInfo.readEbmlVint(view, headerId.width, true);
  if (!headerSize) return [];

  // Skip past EBML header to find Segment
  let offset = headerId.width + headerSize.width + headerSize.value;
  if (offset >= buffer.byteLength) return [];

  const segId = GenInfo.readEbmlVint(view, offset, false);
  if (!segId || segId.value !== EBML_SEGMENT) return [];
  const segSize = GenInfo.readEbmlVint(view, offset + segId.width, true);
  if (!segSize) return [];

  const segStart = offset + segId.width + segSize.width;
  const segEnd = Math.min(segStart + segSize.value, buffer.byteLength);

  // Scan segment children for Tags element
  offset = segStart;
  while (offset < segEnd - 4) {
    const id = GenInfo.readEbmlVint(view, offset, false);
    if (!id) break;
    const size = GenInfo.readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_TAGS) {
      return GenInfo.parseEbmlTagsElement(view, buffer, dataStart, dataEnd);
    }

    // Skip to next element
    offset = dataEnd;
  }

  return [];
};

/**
 * Parse a Matroska Tags element, extracting all SimpleTag name/value pairs.
 */
GenInfo.parseEbmlTagsElement = function (view, buffer, start, end) {
  const chunks = [];
  let offset = start;

  while (offset < end - 4) {
    const id = GenInfo.readEbmlVint(view, offset, false);
    if (!id) break;
    const size = GenInfo.readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_TAG) {
      GenInfo.parseEbmlTagElement(view, buffer, dataStart, dataEnd, chunks);
    }

    offset = dataEnd;
  }

  return chunks;
};

/**
 * Parse a single Matroska Tag element for SimpleTag children.
 */
GenInfo.parseEbmlTagElement = function (view, buffer, start, end, chunks) {
  let offset = start;

  while (offset < end - 4) {
    const id = GenInfo.readEbmlVint(view, offset, false);
    if (!id) break;
    const size = GenInfo.readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_SIMPLE_TAG) {
      const result = GenInfo.parseEbmlSimpleTag(view, buffer, dataStart, dataEnd);
      if (result) chunks.push(result);
    }

    offset = dataEnd;
  }
};

/**
 * Parse a Matroska SimpleTag, extracting TagName and TagString.
 */
GenInfo.parseEbmlSimpleTag = function (view, buffer, start, end) {
  let tagName = null;
  let tagString = null;
  let offset = start;

  while (offset < end - 2) {
    const id = GenInfo.readEbmlVint(view, offset, false);
    if (!id) break;
    const size = GenInfo.readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataLen = Math.min(size.value, buffer.byteLength - dataStart);

    if (id.value === EBML_TAG_NAME) {
      tagName = GenInfo.decodeText(new Uint8Array(buffer, dataStart, dataLen));
    } else if (id.value === EBML_TAG_STRING) {
      tagString = GenInfo.decodeText(new Uint8Array(buffer, dataStart, dataLen));
    }

    offset = dataStart + size.value;
  }

  if (tagName && tagString) {
    return { keyword: tagName, text: GenInfo.unwrapJson(tagString) };
  }
  return null;
};

// ─── MP4 ──────────────────────────────────────────────────────────────

/**
 * Parse MP4 container for metadata tags.
 * With ffmpeg -movflags use_metadata_tags, custom tags are stored in
 * moov > udta > meta > keys + ilst.
 */
GenInfo.parseMp4Tags = function (buffer) {
  const view = new DataView(buffer);

  const moov = GenInfo.findMp4Box(view, buffer, 0, buffer.byteLength, "moov");
  if (!moov) return [];

  const udta = GenInfo.findMp4Box(view, buffer, moov.start, moov.end, "udta");
  if (!udta) return [];

  const meta = GenInfo.findMp4Box(view, buffer, udta.start, udta.end, "meta");
  if (!meta) return [];

  // meta is a full box (has 4 bytes version/flags after header)
  const metaStart = meta.start + 4;

  const keys = GenInfo.findMp4Box(view, buffer, metaStart, meta.end, "keys");
  const ilst = GenInfo.findMp4Box(view, buffer, metaStart, meta.end, "ilst");
  if (!keys || !ilst) return [];

  const keyList = GenInfo.parseMp4Keys(view, buffer, keys.start, keys.end);
  return GenInfo.parseMp4Ilst(view, buffer, ilst.start, ilst.end, keyList);
};

/**
 * Find an MP4 box by type within [start, end).
 * Returns { start, end } of the box data (after the 8-byte header), or null.
 */
GenInfo.findMp4Box = function (view, buffer, start, end, type) {
  let offset = start;
  while (offset < end - 8) {
    let size = view.getUint32(offset);
    const boxType = GenInfo.readFourCC(view, offset + 4);

    if (size === 0) size = end - offset;
    if (size < 8 || offset + size > end) break;

    if (boxType === type) {
      return { start: offset + 8, end: offset + size };
    }

    offset += size;
  }
  return null;
};

/**
 * Parse the `keys` box: version/flags (4) + entry_count (4) + entries.
 * Each entry: key_size (4) + key_namespace (4) + key_name (key_size - 8).
 */
GenInfo.parseMp4Keys = function (view, buffer, start, end) {
  if (start + 8 > end) return [];

  const entryCount = view.getUint32(start + 4);
  const keyList = [];
  let offset = start + 8;

  for (let i = 0; i < entryCount && offset < end; i++) {
    if (offset + 8 > end) break;
    const keySize = view.getUint32(offset);
    if (keySize < 8 || offset + keySize > end) break;

    const name = GenInfo.decodeText(new Uint8Array(buffer, offset + 8, keySize - 8));
    keyList.push(name);
    offset += keySize;
  }

  return keyList;
};

/**
 * Parse the `ilst` box: indexed items matching keys.
 * Each item: size (4) + 1-based_index (4) + "data" sub-box.
 * Data sub-box: size (4) + "data" (4) + type_indicator (4) + locale (4) + value.
 */
GenInfo.parseMp4Ilst = function (view, buffer, start, end, keyList) {
  const chunks = [];
  let offset = start;

  while (offset < end - 8) {
    const size = view.getUint32(offset);
    const index = view.getUint32(offset + 4); // 1-based key index

    if (size < 8 || offset + size > end) break;

    // Find "data" sub-box
    let sub = offset + 8;
    while (sub < offset + size - 8) {
      const subSize = view.getUint32(sub);
      const subType = GenInfo.readFourCC(view, sub + 4);

      if (subType === "data" && subSize > 16) {
        const valueStart = sub + 16; // skip type indicator + locale
        const valueLen = Math.min(subSize - 16, buffer.byteLength - valueStart);
        if (valueLen > 0) {
          const value = GenInfo.decodeText(new Uint8Array(buffer, valueStart, valueLen));

          if (index > 0 && index <= keyList.length) {
            chunks.push({
              keyword: keyList[index - 1],
              text: GenInfo.unwrapJson(value),
            });
          }
        }
      }

      if (subSize < 8) break;
      sub += subSize;
    }

    offset += size;
  }

  return chunks;
};

// ─── Shared helpers ───────────────────────────────────────────────────

/**
 * Read 4 ASCII characters at offset.
 */
GenInfo.readFourCC = function (view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
};

/**
 * Decode bytes to string (UTF-8 with Latin-1 fallback).
 */
GenInfo.decodeText = function (bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
};

/**
 * If the string is a JSON-encoded string (double-serialized), unwrap one layer.
 * VHS double-encodes the "prompt" value: json.dumps(json.dumps(prompt)).
 */
GenInfo.unwrapJson = function (str) {
  if (str.startsWith('"') || str.startsWith("'")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "string") return parsed;
    } catch { /* not double-encoded, return as-is */ }
  }
  return str;
};

// ─── Fetch & render ───────────────────────────────────────────────────

/**
 * Determine fetch size for a given file extension.
 */
GenInfo.fetchSize = function (fileExt) {
  if (fileExt === "webp") return FETCH_BYTES_WEBP;
  if (fileExt === "webm" || fileExt === "mp4") return FETCH_BYTES_VIDEO;
  return FETCH_BYTES_IMAGE;
};

/**
 * Fetch media metadata using Range request.
 */
GenInfo.fetchMetadata = async function (url, fileExt) {
  const maxBytes = GenInfo.fetchSize(fileExt);

  const response = await fetch(url, {
    headers: {
      "Range": `bytes=0-${maxBytes - 1}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  let buffer = await response.arrayBuffer();

  if (fileExt === "png") return GenInfo.parsePngChunks(buffer);
  if (fileExt === "webp") return GenInfo.parseWebpChunks(buffer);
  if (fileExt === "webm") return GenInfo.parseWebmTags(buffer);
  if (fileExt === "mp4") {
    // moov atom may be at the start or end of the file
    let chunks = GenInfo.parseMp4Tags(buffer);
    if (chunks.length > 0) return chunks;

    // Try fetching from the end of the file
    const contentRange = response.headers.get("Content-Range");
    if (!contentRange) return [];
    const match = contentRange.match(/\/(\d+)$/);
    if (!match) return [];

    const fileSize = parseInt(match[1], 10);
    if (fileSize <= maxBytes) return []; // Already fetched everything

    const tailBytes = Math.min(FETCH_BYTES_VIDEO, fileSize);
    const tailResponse = await fetch(url, {
      headers: { "Range": `bytes=${fileSize - tailBytes}-${fileSize - 1}` },
    });
    if (!tailResponse.ok) return [];

    buffer = await tailResponse.arrayBuffer();
    return GenInfo.parseMp4Tags(buffer);
  }
  return GenInfo.parseJpegUserComment(buffer);
};

/**
 * Render metadata chunks to HTML.
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
 * Get the original file URL and extension.
 */
GenInfo.getOriginalUrl = function () {
  const $container = $("#image-container");
  if (!$container.length) return null;

  const fileExt = $container.data("file-ext");
  if (!["png", "jpg", "jpeg", "webp", "webm", "mp4"].includes(fileExt)) return null;

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
