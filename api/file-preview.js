"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const sessions = require("../sessions");
const { refusedInExtraRoot } = require("./preview-roots");
const { previewError, isStrictDescendant, resolvePreviewPath } = require("./file-resolve");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const execFileAsync = promisify(execFile);

// This mirrors the attachment allowlist. Previewing is deliberately extension
// based: workspace files do not carry the upload-time content-type metadata.
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".odp", "application/vnd.oasis.opendocument.presentation"],
  [".rtf", "application/rtf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".yaml", "application/yaml; charset=utf-8"],
  [".yml", "application/yaml; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
]);

// `realpath` before `open` is not a containment proof: a writable directory
// component can be swapped for a symlink in between. Resolve the path from the
// already-open descriptor so the check and the streamed bytes name one vnode.
async function openedFilePath(handle) {
  if (process.platform === "linux") {
    return fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(process.pid), "-d", String(handle.fd), "-F0n"],
      { maxBuffer: 64 * 1024 },
    );
    const field = stdout.toString("utf8").split("\0").find((value) => value.startsWith("n"));
    if (field?.length > 1) return field.slice(1);
  }
  throw previewError("EBADPATH", "could not verify opened file path");
}


async function openPreviewFile(id, requestedPath) {
  if (!SESSION_ID.test(id)) throw previewError("ENOSESSION", "session not found");
  if (
    typeof requestedPath !== "string"
    || !requestedPath
    || requestedPath.length > 4096
    || requestedPath.includes("\0")
  ) {
    throw previewError("EBADPATH", "file path is required");
  }

  const session = await sessions.get(id);
  if (!session) throw previewError("ENOSESSION", "session not found");
  const { filePath, roots, extra } = await resolvePreviewPath(session, id, requestedPath);

  const extension = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXTENSION.get(extension);

  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const openedPath = await openedFilePath(handle);
    if (!roots.some((root) => isStrictDescendant(root, openedPath))) {
      throw previewError("EBADPATH", "file path is outside session storage");
    }
    // Checked on the opened descriptor's path, so a symlink inside a normal
    // root cannot smuggle a credential file past it. Session and workspace
    // roots keep their existing behavior; only user-added folders are filtered.
    const inBase = roots.some((root) => !extra.includes(root) && isStrictDescendant(root, openedPath));
    const extraRoot = !inBase && extra.find((root) => isStrictDescendant(root, openedPath));
    if (extraRoot && refusedInExtraRoot(extraRoot, openedPath)) {
      throw previewError("EBADPATH", "credential-like and hidden files are never shown from viewer folders");
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw previewError("EBADPATH", "file path must name a regular file");
    if (stat.size > MAX_FILE_BYTES) throw previewError("EATTACHMENTTOOLARGE", "file must be 10 MiB or smaller");
    if (!mime) throw previewError("EUNSUPPORTEDATTACHMENT", "unsupported file type");
    return { handle, bytes: stat.size, mime, name: path.basename(filePath) };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error && ["EBADPATH", "EATTACHMENTTOOLARGE", "EUNSUPPORTEDATTACHMENT"].includes(error.code)) throw error;
    throw previewError("ENOTFOUND", "file not found");
  }
}

async function servePreviewFile(res, id, requestedPath) {
  const file = await openPreviewFile(id, requestedPath);
  const headers = {
    "cache-control": "no-store",
    "content-type": file.mime,
    "content-length": file.bytes,
    "x-omp-file-name": encodeURIComponent(file.name),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  if (file.bytes === 0) {
    await file.handle.close();
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
  stream.once("error", () => res.destroy());
  stream.pipe(res);
}

module.exports = { servePreviewFile };
