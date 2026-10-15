"""Chest X-ray pattern flags for the PHYSICIAN (research use, not a diagnosis).

Model: TorchXRayVision DenseNet121 "all" (Cohen et al., Apache-2.0 code; weights trained on
public research datasets) exported to ONNX with class-activation maps, so this service needs
only onnxruntime + numpy + Pillow and runs on CPU. Listens on 127.0.0.1 only.

  POST /analyze   body = image bytes (PNG/JPEG)  → JSON scores, CAM overlays, quality notes
  GET  /health
"""
import base64, io, json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get('CXR_MODEL', os.path.join(HERE, 'model', 'cxr-densenet121-all.onnx'))
META = json.load(open(os.path.join(HERE, 'model', 'meta.json'), encoding='utf-8'))
PATHOLOGIES = META['pathologies']
OP = np.array([np.nan if v is None else v for v in META['op_threshs']], dtype=np.float32)
VERSION = 'xrv-densenet121-all/onnx-cam-1'
MAX_BYTES = 15 * 1024 * 1024
# After operating-point normalisation 0.5 is the model's own (sensitive) threshold; many scores sit
# just above it, so only clearer signals are flagged for the physician.
STRONG, MODERATE = 0.65, 0.55

so = ort.SessionOptions()
so.intra_op_num_threads = int(os.environ.get('CXR_THREADS', '2'))
SESSION = ort.InferenceSession(MODEL, so, providers=['CPUExecutionProvider'])


def resize224(a, size=224):
    """skimage.transform.resize(…, anti_aliasing=True, order=1, mode='constant') in plain numpy —
    the exact preprocessing the model was trained with (Gaussian pre-blur + bilinear)."""
    s = a.shape[0]
    scale = s / size
    sigma = max(0.0, (scale - 1) / 2)
    if sigma > 0:
        r = int(4 * sigma + 0.5)
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        for axis in (0, 1):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (r, r)
            p = np.pad(a, pad)  # constant 0, as skimage mode='constant'
            out = np.zeros_like(a)
            for i, w in enumerate(k):
                out += w * (p[i:i + s, :] if axis == 0 else p[:, i:i + s])
            a = out
    c = (np.arange(size) + 0.5) * scale - 0.5
    i0 = np.floor(c).astype(int)
    f = (c - i0).astype(np.float32)
    ap = np.pad(a, 1)  # outside → 0
    i0 += 1
    rows = ap[i0, :] * (1 - f)[:, None] + ap[i0 + 1, :] * f[:, None]
    return (rows[:, i0] * (1 - f)[None, :] + rows[:, i0 + 1] * f[None, :]).astype(np.float32)


def op_norm(p):
    out = np.full_like(p, 0.5)
    ok = ~np.isnan(OP)
    lo = ok & (p < OP)
    hi = ok & ~(p < OP)
    out[lo] = p[lo] / (OP[lo] * 2)
    out[hi] = 1.0 - (1.0 - p[hi]) / ((1 - OP[hi]) * 2)
    return out


def load(data):
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    notes = []
    arr = np.asarray(img)
    if arr.ndim == 3:
        rgb = arr[..., :3].astype(np.float32)
        # Radiographs are grey; a clearly coloured picture is probably not one.
        if np.mean(np.abs(rgb - rgb.mean(axis=2, keepdims=True))) > 12:
            notes.append('not_grayscale')
        arr = rgb.mean(axis=2)
        maxval = 255.0
    else:
        maxval = 65535.0 if arr.dtype == np.uint16 or arr.max() > 255 else 255.0
        arr = arr.astype(np.float32)
    h, w = arr.shape
    if min(h, w) < 300:
        notes.append('low_resolution')
    if max(h, w) / min(h, w) > 1.6:
        notes.append('unusual_aspect')
    if arr.std() < 0.05 * maxval:
        notes.append('low_contrast')
    # Frontal chest films: bright mediastinum between darker lung fields. Documents, photos of
    # other body parts or inverted images usually fail this rough check.
    g = arr / maxval
    mid = g[:, int(w * 0.42):int(w * 0.58)].mean()
    rows = slice(int(h * 0.2), int(h * 0.7))
    lungs = np.concatenate([g[rows, int(w * 0.15):int(w * 0.38)].ravel(), g[rows, int(w * 0.62):int(w * 0.85)].ravel()]).mean()
    if mid - lungs < 0.08:
        notes.append('not_cxr_like')
    # same scaling as torchxrayvision: [0, maxval] → [-1024, 1024]
    norm = (arr / maxval) * 2048.0 - 1024.0
    s = min(h, w)
    top, left = (h - s) // 2, (w - s) // 2
    crop = norm[top:top + s, left:left + s]
    small = resize224(crop.astype(np.float32))
    view = Image.fromarray(np.clip((crop + 1024) / 2048 * 255, 0, 255).astype(np.uint8)).resize((448, 448), Image.BILINEAR)
    return small[None, None], view, notes, (w, h)


def overlay(view, cam):
    c = np.maximum(cam, 0)
    if c.max() <= 0:
        return None
    c = c / c.max()
    heat = np.asarray(Image.fromarray((c * 255).astype(np.uint8)).resize(view.size, Image.BICUBIC), dtype=np.float32) / 255.0
    base = np.asarray(view.convert('RGB'), dtype=np.float32)
    colour = np.stack([np.ones_like(heat) * 255, heat * 220, np.zeros_like(heat)], axis=-1)  # red → yellow
    alpha = (np.clip((heat - 0.35) / 0.65, 0, 1) * 0.55)[..., None]
    out = base * (1 - alpha) + colour * alpha
    buf = io.BytesIO()
    Image.fromarray(out.astype(np.uint8)).save(buf, 'PNG', optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def analyze(data):
    t0 = time.time()
    x, view, notes, size = load(data)
    logits, cams = SESSION.run(None, {'image': x})
    probs = op_norm(1 / (1 + np.exp(-logits[0])))
    tier = lambda p: 'strong' if p >= STRONG else 'moderate' if p >= MODERATE else 'none'
    findings = sorted(({'key': k, 'score': round(float(p), 3), 'tier': tier(p)} for k, p in zip(PATHOLOGIES, probs)), key=lambda f: -f['score'])
    overlays = {}
    for f in findings:
        if f['tier'] != 'none' and len(overlays) < 3:
            png = overlay(view, cams[0][PATHOLOGIES.index(f['key'])])
            if png:
                overlays[f['key']] = png
    return {
        'model': VERSION, 'findings': findings, 'overlays': overlays, 'quality': notes,
        'thresholds': {'strong': STRONG, 'moderate': MODERATE}, 'input': {'width': size[0], 'height': size[1]},
        'ms': int((time.time() - t0) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'status': 'ok', 'model': VERSION, 'pathologies': PATHOLOGIES})
        self._send(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/analyze':
            return self._send(404, {'error': 'not_found'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(413, {'error': 'size'})
        try:
            self._send(200, analyze(self.rfile.read(n)))
        except Exception as e:  # unreadable image etc.
            self._send(422, {'error': 'unreadable', 'detail': str(e)[:200]})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(os.environ.get('CXR_PORT', '8601'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'cxr service {VERSION} on 127.0.0.1:{port}', flush=True)
    server.serve_forever()
