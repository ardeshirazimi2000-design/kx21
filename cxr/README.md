# Chest X-ray pattern service (research aid)

- Model: [TorchXRayVision](https://github.com/mlmed/torchxrayvision) DenseNet121 `densenet121-res224-all`
  (Cohen et al., code Apache-2.0; weights trained on public research datasets — research use).
- Exported to ONNX (`model/cxr-densenet121-all.onnx`) with an extra output: class-activation maps
  (exact for the model's global-average-pool + linear head). Preprocessing reproduces
  torchxrayvision (scale to [-1024, 1024], centre crop, anti-aliased resize to 224).
  Checked against the PyTorch model: max score difference 0.0005 on the NIH sample.
- Output scores are the library's operating-point-normalised probabilities (0.5 = model threshold);
  the app flags ≥ 0.55 as "possible" and ≥ 0.65 as "notable".
- Runs on CPU (~1 s per image, ~400 MB RAM), listens on 127.0.0.1 only. Not a medical device.
