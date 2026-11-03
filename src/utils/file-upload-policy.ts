import path from 'path';
import {CUSTOMER_DOCUMENT_FOLDERS} from './customer-document-storage';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// The public download route derives Content-Type from the extension, so the
// stored extension must never be one a browser would execute (html, svg, js).
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jfif',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.pdf',
  '.webm',
  '.mp4',
  '.m4a',
  '.ogg',
  '.mp3',
  '.wav',
  '.aac',
]);

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/aac': '.aac',
};

/** The extension to store an upload under, or null if the type is not allowed. */
export function resolveUploadExtension(
  originalName: string,
  mimeType: string,
): string | null {
  const nameExtension = path.extname(originalName).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(nameExtension)) return nameExtension;
  // Camera captures and blobs can arrive with no usable file name.
  const bareMimeType = mimeType.split(';')[0].trim().toLowerCase();
  return EXTENSION_BY_MIME_TYPE[bareMimeType] ?? null;
}

/**
 * Absolute path for a public file request, or null if it escapes the storage
 * root or points into a customer document folder. Those documents are only
 * served through the signed /documents routes.
 */
export function resolvePublicFilePath(
  storageRoot: string,
  requestedPath: string,
): string | null {
  const resolved = path.resolve(storageRoot, requestedPath);
  const relative = path.relative(storageRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const topFolder = relative.split(path.sep)[0].toLowerCase();
  const isCustomerDocument = (
    CUSTOMER_DOCUMENT_FOLDERS as readonly string[]
  ).includes(topFolder);
  return isCustomerDocument ? null : resolved;
}
