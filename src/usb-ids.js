function normalizeHexId(value) {
  if (!value) return undefined;
  const raw = String(value).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return undefined;
  return `0x${raw.padStart(4, '0')}`;
}

function parseUsbIdsFromText(value) {
  const text = String(value || '');
  const match = text.match(/VID_([0-9a-f]{4}).*PID_([0-9a-f]{4})/i);
  if (!match) return {};

  return {
    vendorId: normalizeHexId(match[1]),
    productId: normalizeHexId(match[2]),
  };
}

module.exports = {
  normalizeHexId,
  parseUsbIdsFromText,
};
