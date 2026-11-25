"""Generate compressed initial PC seed for fresh Android installs."""

from __future__ import annotations

import glob
import gzip
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Tuple


def snappy_uncompress(data: bytes) -> bytes:
    """Decompress a raw Snappy block without external dependencies."""
    i = 0
    shift = 0
    length = 0
    while True:
        b = data[i]
        i += 1
        length |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    out = bytearray()
    while i < len(data):
        tag = data[i]
        i += 1
        tag_type = tag & 0x03
        if tag_type == 0:
            lit_code = tag >> 2
            if lit_code < 60:
                lit_len = lit_code + 1
            else:
                n_bytes = lit_code - 59
                lit_len = int.from_bytes(data[i : i + n_bytes], 'little') + 1
                i += n_bytes
            out.extend(data[i : i + lit_len])
            i += lit_len
        else:
            if tag_type == 1:
                copy_len = ((tag >> 2) & 0x07) + 4
                offset = ((tag >> 5) << 8) | data[i]
                i += 1
            elif tag_type == 2:
                copy_len = (tag >> 2) + 1
                offset = int.from_bytes(data[i : i + 2], 'little')
                i += 2
            else:
                copy_len = (tag >> 2) + 1
                offset = int.from_bytes(data[i : i + 4], 'little')
                i += 4
            for _ in range(copy_len):
                out.append(out[-offset])
    return bytes(out)


def read_varint(buf: bytes, pos: int) -> Tuple[int, int]:
    val = 0
    shift = 0
    while True:
        c = buf[pos]
        pos += 1
        val |= (c & 0x7F) << shift
        if not (c & 0x80):
            return val, pos
        shift += 7


def decode_leveldb_entries(ldb_dir: Path) -> Dict[str, str]:
    """Read latest personal-chess-analyzer-* entries from LevelDB .ldb and .log files."""
    latest: Dict[str, Tuple[int, str]] = {}

    def record_entry(seq: int, raw_key: bytes, raw_val: bytes) -> None:
        if b'personal-chess-analyzer-' not in raw_key:
            return
        idx = raw_key.find(b'personal-chess-analyzer-')
        key_name = raw_key[idx:].decode('utf-8', errors='ignore')
        if not raw_val:
            return
        # Chromium LocalStorage prepends \x01 for UTF-8 or \x00 for UTF-16LE strings.
        encoding_flag = raw_val[0]
        payload_bytes = raw_val[1:]
        if encoding_flag == 1:
            text = payload_bytes.decode('utf-8', errors='replace')
        elif encoding_flag == 0:
            text = payload_bytes.decode('utf-16-le', errors='replace')
        else:
            text = raw_val.decode('utf-8', errors='replace')
        prev = latest.get(key_name)
        if prev is None or seq >= prev[0]:
            latest[key_name] = (seq, text)

    # 1. Read .ldb SSTable files
    for ldb_path in sorted(glob.glob(str(ldb_dir / '*.ldb'))):
        raw = Path(ldb_path).read_bytes()
        if len(raw) < 48:
            continue
        footer = raw[-48:]
        _, p = read_varint(footer, 0)
        _, p = read_varint(footer, p)
        idx_off, p = read_varint(footer, p)
        idx_sz, _ = read_varint(footer, p)

        def read_block(off: int, sz: int) -> bytes:
            comp = raw[off + sz]
            chunk = raw[off : off + sz]
            return snappy_uncompress(chunk) if comp == 1 else chunk

        idx_blk = read_block(idx_off, idx_sz)
        restarts = int.from_bytes(idx_blk[-4:], 'little')
        idx_end = len(idx_blk) - 4 * (restarts + 1)
        p = 0
        prev_key = b''
        handles: List[Tuple[int, int]] = []
        while p < idx_end:
            sh, p = read_varint(idx_blk, p)
            nsh, p = read_varint(idx_blk, p)
            vl, p = read_varint(idx_blk, p)
            key = prev_key[:sh] + idx_blk[p : p + nsh]
            p += nsh
            prev_key = key
            val = idx_blk[p : p + vl]
            p += vl
            ho, q = read_varint(val, 0)
            hs, _ = read_varint(val, q)
            handles.append((ho, hs))

        for ho, hs in handles:
            blk = read_block(ho, hs)
            n_rest = int.from_bytes(blk[-4:], 'little')
            blk_end = len(blk) - 4 * (n_rest + 1)
            bp = 0
            bprev = b''
            while bp < blk_end:
                sh, bp = read_varint(blk, bp)
                nsh, bp = read_varint(blk, bp)
                vl, bp = read_varint(blk, bp)
                full_key = bprev[:sh] + blk[bp : bp + nsh]
                bp += nsh
                bprev = full_key
                val = blk[bp : bp + vl]
                bp += vl
                if len(full_key) > 8:
                    tag = int.from_bytes(full_key[-8:], 'little')
                    seq = tag >> 8
                    val_type = tag & 0xFF
                    if val_type == 1:
                        record_entry(seq, full_key[:-8], val)

    # 2. Read newer .log WAL files (uncompressed length-prefixed write batches)
    for log_path in sorted(glob.glob(str(ldb_dir / '*.log'))):
        raw = Path(log_path).read_bytes()
        # Reassemble LevelDB log physical records (32KB blocks)
        payload_stream = bytearray()
        pos = 0
        while pos + 7 <= len(raw):
            rec_len = int.from_bytes(raw[pos + 4 : pos + 6], 'little')
            rec_type = raw[pos + 6]
            pos += 7
            if rec_type == 0 or pos + rec_len > len(raw):
                break
            chunk = raw[pos : pos + rec_len]
            pos += rec_len
            if rec_type in (1, 2):
                payload_stream = bytearray(chunk)
            else:
                payload_stream.extend(chunk)
            if rec_type in (1, 4):
                # Parse WriteBatch: 8-byte seq + 4-byte count
                wb = bytes(payload_stream)
                if len(wb) >= 12:
                    seq = int.from_bytes(wb[0:8], 'little')
                    wp = 12
                    while wp < len(wb):
                        vtype = wb[wp]
                        wp += 1
                        klen, wp = read_varint(wb, wp)
                        kbytes = wb[wp : wp + klen]
                        wp += klen
                        if vtype == 1:
                            vlen, wp = read_varint(wb, wp)
                            vbytes = wb[wp : wp + vlen]
                            wp += vlen
                            record_entry(seq, kbytes, vbytes)
                        seq += 1

    return {k: v for k, (_, v) in latest.items()}


def main() -> None:
    app_data = Path(os.environ['APPDATA']) / 'personal-chess-analyzer'
    games_db = json.loads((app_data / 'games_db.json').read_text(encoding='utf-8'))
    settings = json.loads((app_data / 'settings.json').read_text(encoding='utf-8'))
    learning = decode_leveldb_entries(app_data / 'Local Storage' / 'leveldb')

    # Keep Android settings portable (no Windows stockfish.exe path).
    clean_settings = dict(settings)
    clean_settings['stockfishPath'] = ''

    # Default training qualities should expose all error categories on mobile unless empty;
    # keep user's review history, repertoires, and opening selections intact.
    seed = {
        'version': 1,
        'games': games_db.get('games', []),
        'settings': clean_settings,
        'learningStorage': learning,
    }

    out_path = Path(__file__).resolve().parents[1] / 'android-app' / 'seed' / 'mobile-initial-seed.bin'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    raw_json = json.dumps(seed, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    compressed = gzip.compress(raw_json, compresslevel=9)
    out_path.write_bytes(compressed)

    print(f'Seed written to: {out_path}')
    print(f'  games: {len(seed["games"])}')
    print(f'  learning keys ({len(learning)}): {list(learning.keys())}')
    for k, v in learning.items():
        if 'reviews-v1' in k:
            try:
                rev = json.loads(v)
                print(f'    {k}: {len(rev.get("reviews", {}))} review entries')
            except Exception:
                pass
    print(f'  compressed size: {len(compressed) / 1024:.1f} KB (raw {len(raw_json) / 1024 / 1024:.2f} MB)')


if __name__ == '__main__':
    main()
