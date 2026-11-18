// Dependency-free streaming ISO BMFF (MP4) muxer for WebCodecs H.264 (AVCC) chunks.
// Works identically in browsers and Node.js using Uint8Array/DataView only.

const enc = new TextEncoder();

const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n) => [(n >>> 8) & 0xff, n & 0xff];
const fourcc = (s) => [...enc.encode(s).slice(0, 4)];

const concatBytes = (parts) => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const box = (type, ...payloads) => {
  const body = concatBytes(payloads.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length, false);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
};

const fullBox = (type, version, flags, ...payloads) =>
  box(type, new Uint8Array([version & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), ...payloads);

const COLOR_PRIMARIES = Object.freeze({ bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 });
const COLOR_TRANSFER = Object.freeze({ bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 });
const COLOR_MATRIX = Object.freeze({ rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 });

const mapColorPrimaries = (p) => COLOR_PRIMARIES[p] ?? 1;
const mapColorTransfer = (t) => COLOR_TRANSFER[t] ?? 1;
const mapColorMatrix = (m) => COLOR_MATRIX[m] ?? 1;

const readColorSpace = (cs) => {
  if (!cs || typeof cs !== "object") return null;
  const out = {
    primaries: cs.primaries ?? null,
    transfer: cs.transfer ?? null,
    matrix: cs.matrix ?? null,
    fullRange: typeof cs.fullRange === "boolean" ? cs.fullRange : null,
  };
  return (out.primaries || out.transfer || out.matrix || out.fullRange !== null) ? out : null;
};

export class StreamingMp4Muxer {
  constructor({ width, height, fps = 30 }) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.fps = Math.max(1, Math.round(fps));
    this.timescale = this.fps * 1000;
    this.frameDuration = 1000;
    this.avcC = null;
    this.colorSpace = null;
    this.samples = [];
    this.mdatDataBytes = 0;

    const ftyp = box("ftyp", [
      ...fourcc("isom"),
      ...u32be(0x200),
      ...fourcc("isom"),
      ...fourcc("iso2"),
      ...fourcc("avc1"),
      ...fourcc("mp41"),
    ]);
    // 64-bit extended-size mdat header: size=1, type='mdat', 8-byte largesize placeholder.
    const mdatHeader = new Uint8Array(16);
    const dv = new DataView(mdatHeader.buffer);
    dv.setUint32(0, 1, false);
    mdatHeader.set(enc.encode("mdat"), 4);

    this._header = concatBytes([ftyp, mdatHeader]);
    this.mdatSizeOffset = ftyp.length + 8;
    this.dataStartOffset = this._header.length;
  }

  headerBytes() {
    return this._header;
  }

  addSample({ data, isKey = false, decoderConfig = null }) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (decoderConfig?.description && !this.avcC) {
      const desc = decoderConfig.description;
      this.avcC = desc instanceof Uint8Array
        ? new Uint8Array(desc)
        : new Uint8Array(ArrayBuffer.isView(desc) ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
    }
    if (decoderConfig?.colorSpace) {
      const next = readColorSpace(decoderConfig.colorSpace);
      if (next) {
        this.colorSpace = {
          primaries: this.colorSpace?.primaries || next.primaries,
          transfer: this.colorSpace?.transfer || next.transfer,
          matrix: this.colorSpace?.matrix || next.matrix,
          fullRange: this.colorSpace?.fullRange ?? next.fullRange,
        };
      }
    }
    const offset = this.dataStartOffset + this.mdatDataBytes;
    this.samples.push({ size: bytes.length, isKey: !!isKey, offset });
    this.mdatDataBytes += bytes.length;
    return bytes;
  }

  finish() {
    if (!this.avcC || !this.avcC.length) {
      throw new Error("StreamingMp4Muxer: missing AVCDecoderConfigurationRecord (avcC)");
    }
    const count = this.samples.length;
    const movieTimescale = 90000;
    const trackDuration = count * this.frameDuration;
    const movieDuration = Math.round((count / this.fps) * movieTimescale);

    // mvhd (version 0)
    const mvhd = fullBox("mvhd", 0, 0, [
      ...u32be(0), ...u32be(0),
      ...u32be(movieTimescale),
      ...u32be(movieDuration),
      ...u32be(0x00010000), // rate 1.0
      ...u16be(0x0100),     // volume 1.0
      0, 0,                 // reserved
      ...u32be(0), ...u32be(0),
      ...u32be(0x00010000), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32be(0x00010000), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32be(0x40000000),
      ...new Array(24).fill(0),
      ...u32be(2),          // next_track_ID
    ]);

    // tkhd (version 0, flags=3 enabled+in_movie)
    const tkhd = fullBox("tkhd", 0, 3, [
      ...u32be(0), ...u32be(0),
      ...u32be(1),          // track_ID
      ...u32be(0),          // reserved
      ...u32be(movieDuration),
      ...u32be(0), ...u32be(0),
      ...u16be(0), ...u16be(0), ...u16be(0), ...u16be(0),
      ...u32be(0x00010000), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32be(0x00010000), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ...u32be(0x40000000),
      ...u32be((this.width << 16) >>> 0),
      ...u32be((this.height << 16) >>> 0),
    ]);

    const mdhd = fullBox("mdhd", 0, 0, [
      ...u32be(0), ...u32be(0),
      ...u32be(this.timescale),
      ...u32be(trackDuration),
      ...u16be(0x55c4),     // und
      ...u16be(0),
    ]);

    const hdlr = fullBox("hdlr", 0, 0, [
      ...u32be(0),
      ...fourcc("vide"),
      ...u32be(0), ...u32be(0), ...u32be(0),
      ...enc.encode("VideoHandler\0"),
    ]);

    const vmhd = fullBox("vmhd", 0, 1, new Array(8).fill(0));
    const urlBox = fullBox("url ", 0, 1);
    const dref = fullBox("dref", 0, 0, u32be(1), urlBox);
    const dinf = box("dinf", dref);

    // colr (nclx) matching BT.709 / reported decoder colorSpace
    const cs = this.colorSpace || {};
    const primaries = mapColorPrimaries(cs.primaries);
    const transfer = mapColorTransfer(cs.transfer);
    const matrix = mapColorMatrix(cs.matrix);
    const fullRange = cs.fullRange === true ? 0x80 : 0x00;
    const colr = box("colr", [
      ...fourcc("nclx"),
      ...u16be(primaries),
      ...u16be(transfer),
      ...u16be(matrix),
      fullRange,
    ]);
    const avcC = box("avcC", this.avcC);

    const avc1Header = new Uint8Array(78);
    const avc1Dv = new DataView(avc1Header.buffer);
    avc1Dv.setUint16(6, 1, false);              // data_reference_index
    avc1Dv.setUint16(24, this.width, false);
    avc1Dv.setUint16(26, this.height, false);
    avc1Dv.setUint32(28, 0x00480000, false);    // 72 dpi
    avc1Dv.setUint32(32, 0x00480000, false);
    avc1Dv.setUint16(40, 1, false);             // frame_count
    avc1Dv.setUint16(74, 24, false);            // depth
    avc1Dv.setInt16(76, -1, false);             // pre_defined
    const avc1 = box("avc1", avc1Header, avcC, colr);
    const stsd = fullBox("stsd", 0, 0, u32be(1), avc1);

    const stts = fullBox("stts", 0, 0, u32be(count ? 1 : 0), ...(count ? [u32be(count), u32be(this.frameDuration)] : []));
    const stsc = fullBox("stsc", 0, 0, u32be(count ? 1 : 0), ...(count ? [u32be(1), u32be(1), u32be(1)] : []));

    const stszBuf = new Uint8Array(4 + 4 + count * 4);
    const stszDv = new DataView(stszBuf.buffer);
    stszDv.setUint32(0, 0, false);
    stszDv.setUint32(4, count, false);
    for (let i = 0; i < count; i++) stszDv.setUint32(8 + i * 4, this.samples[i].size, false);
    const stsz = fullBox("stsz", 0, 0, stszBuf);

    const co64Buf = new Uint8Array(4 + count * 8);
    const co64Dv = new DataView(co64Buf.buffer);
    co64Dv.setUint32(0, count, false);
    for (let i = 0; i < count; i++) co64Dv.setBigUint64(4 + i * 8, BigInt(this.samples[i].offset), false);
    const co64 = fullBox("co64", 0, 0, co64Buf);

    const keys = [];
    for (let i = 0; i < count; i++) if (this.samples[i].isKey) keys.push(i + 1);
    const stssBuf = new Uint8Array(4 + keys.length * 4);
    const stssDv = new DataView(stssBuf.buffer);
    stssDv.setUint32(0, keys.length, false);
    for (let i = 0; i < keys.length; i++) stssDv.setUint32(4 + i * 4, keys[i], false);
    const stss = keys.length ? [fullBox("stss", 0, 0, stssBuf)] : [];

    const stbl = box("stbl", stsd, stts, stsc, stsz, co64, ...stss);
    const minf = box("minf", vmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const trak = box("trak", tkhd, mdia);
    const moov = box("moov", mvhd, trak);

    const mdatTotalSize = 16 + this.mdatDataBytes;
    const mdatSizeBytes = new Uint8Array(8);
    new DataView(mdatSizeBytes.buffer).setBigUint64(0, BigInt(mdatTotalSize), false);

    return { moov, mdatSizeOffset: this.mdatSizeOffset, mdatSizeBytes };
  }
}
