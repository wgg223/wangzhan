const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/jpg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF header
  'image/bmp': [[0x42, 0x4D]], // BM header
  'image/avif': [[0x00, 0x00, 0x00]], // ftyp box (varies)
  'image/heic': [[0x00, 0x00, 0x00]], // ftyp box (varies)
  'image/tiff': [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]], // II or MM
};

// Formats that can be reliably validated via Magic Bytes
const VALIDATABLE_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

// Formats that we accept but cannot reliably validate (skip validation)
const ACCEPTED_UNVALIDATED = ['image/avif', 'image/heic', 'image/heif', 'image/svg+xml', 'image/x-ms-bmp'];

function validateMagicBytes(buffer, mimeType) {
  // If format is not validatable, skip validation
  if (ACCEPTED_UNVALIDATED.includes(mimeType)) return true;

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;

  if (buffer.length < 4) return false;

  for (const sig of signatures) {
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

module.exports = { validateMagicBytes, MAGIC_BYTES };
