const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/mp2t': 'ts',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

function safeAttachmentNameParts(
  originalName: string | null | undefined,
  mimeType: string | null | undefined,
): { extension: string; stem: string } {
  const fallbackExtension = MIME_EXTENSIONS[mimeType || ''] || 'bin';
  const original = (originalName || `attachment.${fallbackExtension}`).split(/[\\/]/).pop() || 'attachment.bin';
  const separator = original.lastIndexOf('.');
  const originalStem = separator > 0 ? original.slice(0, separator) : original;
  const originalExtension = separator > 0 ? original.slice(separator + 1) : fallbackExtension;
  const stem = originalStem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'attachment';
  const extension = originalExtension.replace(/[^A-Za-z0-9]+/g, '').slice(0, 16) || fallbackExtension;
  return { extension, stem };
}

export function attachmentUploadName(
  originalName: string | null | undefined,
  mimeType: string | null | undefined,
  now = new Date(),
): string {
  const { extension, stem } = safeAttachmentNameParts(originalName, mimeType);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${stem}.${extension}`;
}
