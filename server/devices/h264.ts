export interface AvcCodec {
  codec: string;
  description: Buffer;
}

export function annexBNals(buffer: Buffer): Buffer[] {
  const prefixes: { at: number; length: number }[] = [];
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
    const long = buffer[i + 2] === 0 && buffer[i + 3] === 1;
    const short = buffer[i + 2] === 1;
    if (!long && !short) continue;
    const length = long ? 4 : 3;
    prefixes.push({ at: i, length });
    i += length - 1;
  }
  return prefixes.map((prefix, index) => {
    const start = prefix.at + prefix.length;
    const end = prefixes[index + 1]?.at ?? buffer.length;
    return buffer.subarray(start, end);
  });
}

export function avcCodec(config: Buffer): AvcCodec | null {
  const nals = annexBNals(config);
  const sps = nals.find((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
  const pps = nals.find((nal) => ((nal[0] ?? 0) & 0x1f) === 8);
  if (!sps || !pps) return null;
  const profile = sps[1];
  const compat = sps[2];
  const level = sps[3];
  // An SPS under 4 bytes has no profile bytes, so there is no codec string to build.
  if (profile === undefined || compat === undefined || level === undefined) return null;
  const description = Buffer.alloc(11 + sps.length + pps.length);
  description[0] = 1;
  description[1] = profile;
  description[2] = compat;
  description[3] = level;
  description[4] = 0xff;
  description[5] = 0xe1;
  description.writeUInt16BE(sps.length, 6);
  sps.copy(description, 8);
  const at = 8 + sps.length;
  description[at] = 1;
  description.writeUInt16BE(pps.length, at + 1);
  pps.copy(description, at + 3);
  return {
    codec: `avc1.${byteHex(profile)}${byteHex(compat)}${byteHex(level)}`,
    description,
  };
}

export function annexBToLength(buffer: Buffer): Buffer {
  const nals = annexBNals(buffer).filter((nal) => nal.length);
  const out = Buffer.alloc(nals.reduce((sum, nal) => sum + 4 + nal.length, 0));
  let at = 0;
  for (const nal of nals) {
    out.writeUInt32BE(nal.length, at);
    nal.copy(out, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}
