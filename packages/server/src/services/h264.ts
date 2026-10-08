/** Reading just enough of an H.264 stream. */

/**
 * Whether a non-IDR slice (NAL type 1) is an I-slice: its slice_type, the
 * second Exp-Golomb number after the NAL header, is 2 or 7. A muxer that
 * marked every frame a keyframe would otherwise read as a film of I-frames.
 */
export function isISlice(nal: Uint8Array): boolean {
  let bit = 8; // past the NAL header byte
  const read = () => {
    const byte = nal[bit >> 3];
    if (byte === undefined) return null;
    return (byte >> (7 - (bit++ & 7))) & 1;
  };
  const expGolomb = (): number | null => {
    let zeros = 0;
    for (;;) {
      const b = read();
      if (b === null || zeros > 31) return null;
      if (b === 1) break;
      zeros++;
    }
    let value = 0;
    for (let i = 0; i < zeros; i++) {
      const b = read();
      if (b === null) return null;
      value = value * 2 + b;
    }
    return 2 ** zeros - 1 + value;
  };
  if (expGolomb() === null) return false; // first_mb_in_slice
  const type = expGolomb();
  return type === 2 || type === 7;
}
