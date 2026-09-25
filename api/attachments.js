"use strict";
const crypto = require("crypto");
const { isUtf8 } = require("buffer");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 64 * 1024;
const MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + MAX_MULTIPART_OVERHEAD;
const MAX_HEADER_BYTES = 16 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BOUNDARY = /^[0-9A-Za-z'()+_,./:=?-]+$/;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const GENERIC_DOCUMENT_MIMES = new Set(["", "application/octet-stream"]);
const DOCUMENT_TYPES = {
  ".pdf": {
    mime: "application/pdf",
    aliases: ["application/pdf", "application/x-pdf"],
    signature: "pdf",
  },
  ".doc": {
    mime: "application/msword",
    aliases: ["application/msword", "application/vnd.ms-word", "application/x-msword"],
    signature: "ole",
  },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    aliases: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-word.document.12",
    ],
    signature: "zip",
  },
  ".xls": {
    mime: "application/vnd.ms-excel",
    aliases: [
      "application/vnd.ms-excel",
      "application/msexcel",
      "application/x-msexcel",
      "application/x-ms-excel",
      "application/x-excel",
      "application/excel",
    ],
    signature: "ole",
  },
  ".xlsx": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    aliases: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel.sheet.12",
    ],
    signature: "zip",
  },
  ".ppt": {
    mime: "application/vnd.ms-powerpoint",
    aliases: [
      "application/vnd.ms-powerpoint",
      "application/mspowerpoint",
      "application/x-mspowerpoint",
      "application/powerpoint",
      "application/x-powerpoint",
    ],
    signature: "ole",
  },
  ".pptx": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    aliases: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint.presentation.12",
    ],
    signature: "zip",
  },
  ".odt": {
    mime: "application/vnd.oasis.opendocument.text",
    aliases: ["application/vnd.oasis.opendocument.text"],
    signature: "zip",
  },
  ".ods": {
    mime: "application/vnd.oasis.opendocument.spreadsheet",
    aliases: ["application/vnd.oasis.opendocument.spreadsheet"],
    signature: "zip",
  },
  ".odp": {
    mime: "application/vnd.oasis.opendocument.presentation",
    aliases: ["application/vnd.oasis.opendocument.presentation"],
    signature: "zip",
  },
  ".rtf": {
    mime: "application/rtf",
    aliases: ["application/rtf", "application/x-rtf", "text/rtf", "text/richtext"],
    signature: "rtf",
  },
  ".txt": { mime: "text/plain", aliases: ["text/plain"], signature: "text" },
  ".md": {
    mime: "text/markdown",
    aliases: ["text/markdown", "text/x-markdown", "text/plain"],
    signature: "text",
  },
  ".csv": {
    mime: "text/csv",
    aliases: ["text/csv", "application/csv", "text/comma-separated-values"],
    signature: "text",
  },
  ".tsv": {
    mime: "text/tab-separated-values",
    aliases: ["text/tab-separated-values", "text/tsv"],
    signature: "text",
  },
  ".json": { mime: "application/json", aliases: ["application/json", "text/json"], signature: "text" },
  ".xml": { mime: "application/xml", aliases: ["application/xml", "text/xml"], signature: "text" },
  ".yaml": {
    mime: "application/yaml",
    aliases: ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"],
    signature: "text",
  },
  ".yml": {
    mime: "application/yaml",
    aliases: ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"],
    signature: "text",
  },
  ".log": { mime: "text/plain", aliases: ["text/plain"], signature: "text" },
};

function attachmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseParameterizedHeader(input) {
  const value = String(input || "");
  const semicolon = value.indexOf(";");
  const type = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  const parameters = Object.create(null);
  let cursor = semicolon === -1 ? value.length : semicolon;

  while (cursor < value.length) {
    if (value[cursor] !== ";") throw attachmentError("EBADMULTIPART", "invalid multipart header");
    cursor += 1;
    while (cursor < value.length && /[\t ]/.test(value[cursor])) cursor += 1;

    const keyStart = cursor;
    while (cursor < value.length && TOKEN.test(value[cursor])) cursor += 1;
    const key = value.slice(keyStart, cursor).toLowerCase();
    if (!key || Object.hasOwn(parameters, key)) {
      throw attachmentError("EBADMULTIPART", "invalid multipart header parameter");
    }
    while (cursor < value.length && /[\t ]/.test(value[cursor])) cursor += 1;
    if (value[cursor] !== "=") throw attachmentError("EBADMULTIPART", "invalid multipart header parameter");
    cursor += 1;
    while (cursor < value.length && /[\t ]/.test(value[cursor])) cursor += 1;

    let parameter = "";
    if (value[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < value.length) {
        const char = value[cursor];
        cursor += 1;
        if (char === '"') {
          closed = true;
          break;
        }
        if (char === "\\") {
          if (cursor >= value.length) break;
          parameter += value[cursor];
          cursor += 1;
        } else {
          if (char === "\r" || char === "\n") {
            throw attachmentError("EBADMULTIPART", "invalid multipart header parameter");
          }
          parameter += char;
        }
      }
      if (!closed) throw attachmentError("EBADMULTIPART", "invalid multipart header parameter");
    } else {
      const valueStart = cursor;
      while (cursor < value.length && value[cursor] !== ";") cursor += 1;
      parameter = value.slice(valueStart, cursor).trim();
      if (!parameter) throw attachmentError("EBADMULTIPART", "invalid multipart header parameter");
    }
    parameters[key] = parameter;
    while (cursor < value.length && /[\t ]/.test(value[cursor])) cursor += 1;
  }

  return { type, parameters };
}

function multipartBoundary(contentType) {
  const parsed = parseParameterizedHeader(contentType);
  const boundary = parsed.parameters.boundary;
  if (parsed.type !== "multipart/form-data" || !boundary || boundary.length > 70 || !BOUNDARY.test(boundary)) {
    throw attachmentError("EBADMULTIPART", "content-type must be multipart/form-data with a valid boundary");
  }
  return boundary;
}

function readLimitedBody(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw attachmentError("EBADMULTIPART", "invalid content-length");
    }
    if (declared > MAX_REQUEST_BYTES) {
      req.resume();
      throw attachmentError("EATTACHMENTTOOLARGE", "attachment must be 10 MiB or smaller");
    }
  }

  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        settled = true;
        chunks = [];
        reject(attachmentError("EATTACHMENTTOOLARGE", "attachment must be 10 MiB or smaller"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, bytes));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parsePartHeaders(buffer) {
  const text = buffer.toString("latin1");
  const headers = Object.create(null);
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw attachmentError("EBADMULTIPART", "invalid multipart part header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!TOKEN.test(name) || !value || Object.hasOwn(headers, name)) {
      throw attachmentError("EBADMULTIPART", "invalid multipart part header");
    }
    headers[name] = value;
  }
  return headers;
}

function findBoundary(body, marker, start) {
  let cursor = start;
  while (cursor < body.length) {
    const found = body.indexOf(marker, cursor);
    if (found === -1) return -1;
    const suffix = found + marker.length;
    const validSuffix =
      body.subarray(suffix, suffix + 2).equals(CRLF) ||
      body.subarray(suffix, suffix + 2).equals(Buffer.from("--"));
    if (validSuffix) return found;
    cursor = found + 1;
  }
  return -1;
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const marker = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let cursor = 0;

  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw attachmentError("EBADMULTIPART", "malformed multipart body");
  }
  cursor += delimiter.length;

  while (true) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      cursor += 2;
      if (body.subarray(cursor, cursor + 2).equals(CRLF)) cursor += 2;
      if (cursor !== body.length) throw attachmentError("EBADMULTIPART", "malformed multipart epilogue");
      break;
    }
    if (!body.subarray(cursor, cursor + 2).equals(CRLF)) {
      throw attachmentError("EBADMULTIPART", "malformed multipart boundary");
    }
    cursor += 2;

    const headerEnd = body.indexOf(HEADER_END, cursor);
    if (headerEnd === -1 || headerEnd - cursor > MAX_HEADER_BYTES) {
      throw attachmentError("EBADMULTIPART", "invalid multipart part headers");
    }
    const headers = parsePartHeaders(body.subarray(cursor, headerEnd));
    const dataStart = headerEnd + HEADER_END.length;
    const nextBoundary = findBoundary(body, marker, dataStart);
    if (nextBoundary === -1) throw attachmentError("EBADMULTIPART", "unterminated multipart part");

    parts.push({ headers, data: body.subarray(dataStart, nextBoundary) });
    if (parts.length > 1) throw attachmentError("EBADMULTIPART", "exactly one attachment is required");
    cursor = nextBoundary + CRLF.length + delimiter.length;
  }

  if (parts.length !== 1) throw attachmentError("EBADMULTIPART", "exactly one attachment is required");
  return parts[0];
}

function hasPrefix(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

function detectImage(buffer) {
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: ".png", aliases: ["image/png", "image/x-png"] };
  }
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", extension: ".jpg", aliases: ["image/jpeg", "image/jpg", "image/pjpeg"] };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return { mime: "image/gif", extension: ".gif", aliases: ["image/gif"] };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", extension: ".webp", aliases: ["image/webp"] };
  }
  if (hasPrefix(buffer, [0x42, 0x4d])) {
    return { mime: "image/bmp", extension: ".bmp", aliases: ["image/bmp", "image/x-ms-bmp"] };
  }
  if (hasPrefix(buffer, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(buffer, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mime: "image/tiff", extension: ".tif", aliases: ["image/tiff"] };
  }
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const boxSize = buffer.readUInt32BE(0);
    const end = Math.min(buffer.length, boxSize >= 16 ? boxSize : 16);
    const brands = [];
    for (let offset = 8; offset + 4 <= end; offset += 4) brands.push(buffer.subarray(offset, offset + 4).toString("ascii"));
    if (brands.some((brand) => brand === "avif" || brand === "avis")) {
      return { mime: "image/avif", extension: ".avif", aliases: ["image/avif"] };
    }
    if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand))) {
      return { mime: "image/heic", extension: ".heic", aliases: ["image/heic", "image/heif"] };
    }
    if (brands.some((brand) => ["mif1", "msf1", "heim", "heis", "hevm", "hevs"].includes(brand))) {
      return { mime: "image/heif", extension: ".heif", aliases: ["image/heif", "image/heic"] };
    }
  }
  return null;
}

function decodeExtendedFilename(value) {
  const match = /^utf-8'[^']*'(.*)$/i.exec(value);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function attachmentFilename(disposition) {
  if (Object.hasOwn(disposition.parameters, "filename*")) {
    const decoded = decodeExtendedFilename(disposition.parameters["filename*"]);
    if (decoded !== null) return decoded;
  }
  const plain = disposition.parameters.filename;
  if (plain === undefined) return "";
  const bytes = Buffer.from(plain, "latin1");
  return isUtf8(bytes) ? bytes.toString("utf8") : plain;
}

function basename(filename) {
  return String(filename).split(/[\\/]/).pop() || "";
}

function displayName(filename, fallbackExtension) {
  let name = basename(filename)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "_")
    .trim();
  if (!name || name === "." || name === "..") name = `attachment${fallbackExtension}`;

  const characters = Array.from(name);
  if (characters.length <= 255) return name;
  const suffix = path.extname(name);
  const suffixCharacters = Array.from(suffix);
  if (!suffix || suffixCharacters.length > 20) return characters.slice(0, 255).join("");
  return characters.slice(0, 255 - suffixCharacters.length).join("") + suffix;
}

function matchesDocumentSignature(buffer, signature) {
  if (signature === "pdf") return hasPrefix(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (signature === "ole") {
    return hasPrefix(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  }
  if (signature === "zip") return hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]);
  if (signature === "rtf") return hasPrefix(buffer, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
  if (signature === "text") return buffer.indexOf(0) === -1 && isUtf8(buffer);
  return false;
}

function validateAttachmentPart(part) {
  const disposition = parseParameterizedHeader(part.headers["content-disposition"]);
  if (
    disposition.type !== "form-data" ||
    disposition.parameters.name !== "attachment" ||
    (!Object.hasOwn(disposition.parameters, "filename") && !Object.hasOwn(disposition.parameters, "filename*"))
  ) {
    throw attachmentError("EBADMULTIPART", 'multipart field "attachment" must contain one file');
  }
  if (part.data.length > MAX_ATTACHMENT_BYTES) {
    throw attachmentError("EATTACHMENTTOOLARGE", "attachment must be 10 MiB or smaller");
  }

  const filename = attachmentFilename(disposition);
  const declared = parseParameterizedHeader(part.headers["content-type"]).type;
  if (declared.startsWith("image/")) {
    const detected = detectImage(part.data);
    if (!detected || !detected.aliases.includes(declared)) {
      throw attachmentError("EUNSUPPORTEDATTACHMENT", "attachment content does not match a supported image type");
    }
    return { ...detected, name: displayName(filename, detected.extension) };
  }

  const extension = path.extname(basename(filename)).toLowerCase();
  const document = DOCUMENT_TYPES[extension];
  const mimeAccepted = document &&
    (GENERIC_DOCUMENT_MIMES.has(declared) || document.aliases.includes(declared));
  if (!mimeAccepted || !matchesDocumentSignature(part.data, document.signature)) {
    throw attachmentError(
      "EUNSUPPORTEDATTACHMENT",
      "attachment extension, content-type, or content does not match a supported file type",
    );
  }
  return { ...document, extension, name: displayName(filename, extension) };
}

async function ensurePrivateDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`attachment path is not a private directory: ${directory}`);
  }
  await fs.promises.chmod(directory, 0o700);
}

async function writeAttachment(sessionId, data, attachment) {
  await ensurePrivateDirectory(config.attachmentsDir);
  const sessionDirectory = path.join(config.attachmentsDir, sessionId);
  await ensurePrivateDirectory(sessionDirectory);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const storedName = `${crypto.randomBytes(16).toString("hex")}${attachment.extension}`;
    const filePath = path.join(sessionDirectory, storedName);
    let handle;
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
      handle = await fs.promises.open(filePath, flags, 0o600);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }

    try {
      await handle.writeFile(data);
      await handle.chmod(0o600);
      await handle.close();
      return { path: filePath, name: attachment.name, bytes: data.length, mime: attachment.mime };
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(filePath).catch(() => {});
      throw error;
    }
  }
  throw new Error("could not allocate an attachment filename");
}

async function saveAttachment(req, sessionId) {
  const boundary = multipartBoundary(req.headers["content-type"]);
  const body = await readLimitedBody(req);
  const part = parseMultipart(body, boundary);
  const attachment = validateAttachmentPart(part);
  return writeAttachment(sessionId, part.data, attachment);
}

module.exports = { saveAttachment, multipartBoundary, readLimitedBody, parseMultipart };
