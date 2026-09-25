"use strict";

// Incremental JSONL reader for OMP session transcripts.
// readFrom(file, fromByte, expectedAnchor?, oversize?) -> { entries, nextByte, reset, anchor, oversize, scan }
//
// Design constraints mirrored from upstream docs/session.md:
// - Lines are newline-atomic (each appended line includes its trailing \n).
// - A full-body rewrite may precede incremental appends; no fsync guarantee.
// - Reader therefore checks alignment on every call and signals reset when
//   the offset is no longer on a line boundary or the file shrank.

const fs = require("fs");

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB cap per call
const MAX_RECORDS = 1000;
const MAX_OVERSIZE_SCAN_BYTES = 16 * 1024 * 1024;
const ANCHOR_BYTES = 64;
const SCAN_BYTES = 64 * 1024;

async function readAnchor(fd, offset) {
  const length = Math.min(ANCHOR_BYTES, offset);
  if (length <= 0) return "";
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await fd.read(buf, 0, length, offset - length);
  return buf.subarray(0, bytesRead).toString("base64");
}

async function findNextLineBoundary(fd, position, fileSize) {
  const buf = Buffer.allocUnsafe(SCAN_BYTES);
  const limit = Math.min(fileSize, position + MAX_OVERSIZE_SCAN_BYTES);
  let cursor = position;
  while (cursor < limit) {
    const length = Math.min(buf.length, limit - cursor);
    const { bytesRead } = await fd.read(buf, 0, length, cursor);
    if (!bytesRead) break;
    const newline = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (newline !== -1) {
      return { boundary: cursor + newline + 1, scannedBytes: cursor + newline + 1 - position };
    }
    cursor += bytesRead;
  }
  return { boundary: null, scannedBytes: cursor - position };
}

async function scanOversizeRecord(fd, recordStart, position, fileSize, reset, bytesAlreadyRead = 0) {
  const found = await findNextLineBoundary(fd, position, fileSize);
  if (found.boundary !== null) {
    const omittedBytes = found.boundary - recordStart;
    return {
      entries: [],
      nextByte: found.boundary,
      reset,
      anchor: await readAnchor(fd, found.boundary),
      oversize: null,
      scan: {
        bytesRead: bytesAlreadyRead + found.scannedBytes,
        recordsScanned: 1,
        malformedRecords: 0,
        omittedRecords: 1,
        omittedBytes,
        pendingOversizeBytes: 0,
        oversizeRecordStart: recordStart,
      },
    };
  }

  const scanByte = position + found.scannedBytes;
  if (scanByte < fileSize) {
    return {
      entries: [],
      nextByte: recordStart,
      reset,
      anchor: await readAnchor(fd, recordStart),
      oversize: {
        recordStart,
        scanByte,
        scanAnchor: await readAnchor(fd, scanByte),
      },
      scan: {
        bytesRead: bytesAlreadyRead + found.scannedBytes,
        recordsScanned: 0,
        malformedRecords: 0,
        omittedRecords: 0,
        omittedBytes: 0,
        pendingOversizeBytes: scanByte - recordStart,
        oversizeRecordStart: recordStart,
      },
    };
  }

  const err = new Error("Oversized transcript record is not newline-terminated");
  err.code = "EPAYLOADTOOLARGE";
  throw err;
}

async function readFrom(file, fromByte, expectedAnchor = null, oversize = null) {
  let fd;
  try {
    fd = await fs.promises.open(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") {
      const err = new Error(`Transcript not found: ${file}`);
      err.code = "ENOTRANSCRIPT";
      throw err;
    }
    throw e;
  }

  try {
    const stat = await fd.stat();
    const fileSize = stat.size;

    // A reset means the caller's cursor is no longer a valid record boundary.
    let reset = false;
    let startByte = (typeof fromByte === "number" && fromByte > 0) ? fromByte : 0;

    if (!fromByte || fromByte === 0) {
      reset = true;
      startByte = 0;
    } else if (fileSize < fromByte) {
      reset = true;
      startByte = 0;
    } else {
      const checkBuf = Buffer.allocUnsafe(1);
      await fd.read(checkBuf, 0, 1, fromByte - 1);
      const anchorChanged = expectedAnchor !== null
        && await readAnchor(fd, fromByte) !== expectedAnchor;
      if (checkBuf[0] !== 0x0a || anchorChanged) {
        reset = true;
        startByte = 0;
      }
    }

    // Oversized records advance through a separately anchored scan cursor.
    // The public nextByte remains the last proven newline boundary.
    const continuingOversize = oversize
      && oversize.recordStart === startByte
      && Number.isSafeInteger(oversize.scanByte)
      && oversize.scanByte >= startByte + MAX_BYTES
      && oversize.scanByte <= fileSize
      && typeof oversize.scanAnchor === "string"
      && await readAnchor(fd, oversize.scanByte) === oversize.scanAnchor;
    if (continuingOversize) {
      return await scanOversizeRecord(fd, startByte, oversize.scanByte, fileSize, startByte === 0 ? false : reset);
    }

    const remaining = fileSize - startByte;
    const toRead = Math.min(remaining, MAX_BYTES);
    const emptyScan = {
      bytesRead: 0,
      recordsScanned: 0,
      malformedRecords: 0,
      omittedRecords: 0,
      omittedBytes: 0,
      pendingOversizeBytes: 0,
      oversizeRecordStart: null,
    };

    if (toRead <= 0) {
      return {
        entries: [],
        nextByte: startByte,
        reset,
        anchor: await readAnchor(fd, startByte),
        scan: emptyScan,
      };
    }

    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fd.read(buf, 0, toRead, startByte);
    const chunk = buf.subarray(0, bytesRead);

    let completeEnd;
    if (chunk.length > 0 && chunk[chunk.length - 1] === 0x0a) {
      completeEnd = chunk.length;
    } else {
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) {
        // A record larger than the page cap is omitted only after finding its
        // newline within a separate bounded scan. The response reports the
        // omission so state loss is never silent.
        if (toRead === MAX_BYTES) {
          return await scanOversizeRecord(
            fd,
            startByte,
            startByte + chunk.length,
            fileSize,
            reset,
            chunk.length
          );
        }
        return {
          entries: [],
          nextByte: startByte,
          reset,
          anchor: await readAnchor(fd, startByte),
          scan: Object.assign({}, emptyScan, { bytesRead: chunk.length }),
        };
      }
      completeEnd = lastNl + 1;
    }

    // Parse no more than MAX_RECORDS complete records. The unparsed remainder
    // stays reachable at nextByte instead of becoming a large response.
    const entries = [];
    let cursor = 0;
    let recordsScanned = 0;
    let malformedRecords = 0;
    while (cursor < completeEnd && recordsScanned < MAX_RECORDS) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline === -1 || newline >= completeEnd) break;
      const line = chunk.subarray(cursor, newline);
      cursor = newline + 1;
      recordsScanned++;
      if (!line.length) continue;
      const text = line.toString("utf8").trim();
      if (!text) continue;
      try {
        entries.push(JSON.parse(text));
      } catch {
        malformedRecords++;
      }
    }

    const nextByte = startByte + cursor;
    return {
      entries,
      nextByte,
      reset,
      anchor: await readAnchor(fd, nextByte),
      scan: {
        bytesRead: chunk.length,
        recordsScanned,
        malformedRecords,
        omittedRecords: 0,
        omittedBytes: 0,
      },
    };
  } finally {
    await fd.close();
  }
}

module.exports = { readFrom };
