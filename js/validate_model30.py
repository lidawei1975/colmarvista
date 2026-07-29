import argparse
import os
import sys
import itertools

import numpy as np
import scipy.io as sio
import tensorflow as tf

# Add parent directory to sys.path to allow imports from "nus2D"
parent_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if parent_dir not in sys.path:
    sys.path.append(parent_dir)

from nus2D.ml_data_generator_patches_tf import _extract_topn_patches_numpy
from nus2D.model30 import (
    build_transformer_phase_model_v30_patches,
)

def read_ft2(file_path):
    with open(file_path, "rb") as f:
        # Read the 512 float32 header (2048 bytes)
        header = np.fromfile(f, dtype="<f4", count=512)
        if header.size < 512:
            raise ValueError(f"Could not read full header from {file_path}")

        # Extract dimensions and flags
        tp = int(round(header[221]))
        n1 = int(round(header[219]))
        n2 = int(round(header[99]))
        quad_flag_1 = header[55]
        quad_flag_2 = header[56]

        # Read the matrix data
        if quad_flag_1 == 0.0 and quad_flag_2 == 0.0:
            # both are complex
            n1 = n1 // 2
            spectrumrr = np.zeros((n1, n2), dtype=np.float32)
            spectrumri = np.zeros((n1, n2), dtype=np.float32)
            for i in range(n1):
                spectrumrr[i, :] = np.fromfile(f, dtype="<f4", count=n2)
                spectrumri[i, :] = np.fromfile(f, dtype="<f4", count=n2)
                # skip/consume spectrumir and spectrumii
                np.fromfile(f, dtype="<f4", count=n2)
                np.fromfile(f, dtype="<f4", count=n2)
        elif quad_flag_1 == 1.0 and quad_flag_2 == 0.0:
            # indirect is real, direct is complex
            spectrumrr = np.zeros((n1, n2), dtype=np.float32)
            spectrumri = np.zeros((n1, n2), dtype=np.float32)
            for i in range(n1):
                spectrumrr[i, :] = np.fromfile(f, dtype="<f4", count=n2)
                spectrumri[i, :] = np.fromfile(f, dtype="<f4", count=n2)
        elif quad_flag_1 == 0.0 and quad_flag_2 == 1.0:
            # indirect is complex, direct is real
            spectrumrr = np.zeros((n1, n2), dtype=np.float32)
            spectrumri = np.zeros((n1, n2), dtype=np.float32) # remains zero
            for i in range(n1):
                spectrumrr[i, :] = np.fromfile(f, dtype="<f4", count=n2)
                np.fromfile(f, dtype="<f4", count=n2) # consume spectrumir
        else:
            # both are real
            spectrumrr = np.zeros((n1, n2), dtype=np.float32)
            spectrumri = np.zeros((n1, n2), dtype=np.float32) # remains zero
            for i in range(n1):
                spectrumrr[i, :] = np.fromfile(f, dtype="<f4", count=n2)

        # Transpose if tp == 1
        if tp == 1:
            spectrumrr = spectrumrr.T
            spectrumri = spectrumri.T

        return spectrumrr, spectrumri

TOP_N = 5
TOKEN_WIDTH = 32
PATCH_HEIGHT = 32
DIRECT_EXTEND = 32
L2_REG = 1e-6


def wls_phase_regression_softmax_numpy(
    local_predictions,
    direct_dim,
    token_norms,
    token_width=TOKEN_WIDTH,
    l2_reg=L2_REG,
    use_token_norms=False,
):
    y = local_predictions[..., 0].astype(np.float32)
    s = local_predictions[..., 1].astype(np.float32)

    # Numerically stable softmax over negative log-variance (-s), excluding first and last tokens
    s_mid = s[:, 1:-1]
    s_max = np.max(-s_mid, axis=-1, keepdims=True)
    exp_s_mid = np.exp(-s_mid - s_max)
    w_mid = exp_s_mid / np.sum(exp_s_mid, axis=-1, keepdims=True)

    # Reconstruct the full w with 0 for the first and last tokens
    w = np.zeros_like(s)
    w[:, 1:-1] = w_mid

    if use_token_norms:
        # Multiply by the token normalization factors so strong-signal tokens get larger weights
        w = w * token_norms

    bsz, t = y.shape
    if t <= 0:
        raise ValueError("local_predictions must contain at least one token")

    # Align with token centers: (idx + 0.5) / t
    x_coords = ((np.arange(t, dtype=np.float32) * float(token_width)) + (0.5 * float(token_width))) / float(direct_dim)

    x_mat = np.stack([1.0 - x_coords, x_coords], axis=-1).astype(np.float32)
    out = np.zeros((bsz, 2), dtype=np.float32)
    eye = np.eye(2, dtype=np.float32)

    for b in range(bsz):
        wb = w[b][:, None]
        xb = x_mat
        yb = y[b][:, None]

        xt_wx = xb.T @ (xb * wb)
        xt_wx_reg = xt_wx + float(l2_reg) * eye
        xt_wy = xb.T @ (yb * wb)

        beta = np.linalg.solve(xt_wx_reg, xt_wy)
        out[b, :] = beta[:, 0]

    return out


def validate_model30(
    weights_path,
    output_mat,
    val_exp_file,
    phase_values=(-20.0, 0.0, 20.0),
    force_cpu=True,
    use_token_norms=False,
):
    if force_cpu:
        try:
            tf.config.set_visible_devices([], "GPU")
            print("[Config] Running in CPU-only mode.")
        except Exception as ex:
            print(f"[Config] Could not force CPU-only mode: {ex}")

    tf.config.optimizer.set_jit(False)

    print(f"\n[Validation] Loading experimental spectrum from {val_exp_file}...")
    if not val_exp_file.endswith(".ft2"):
        raise ValueError(f"Expected file ending in .ft2, got {val_exp_file}")
    d2rr, d2ir = read_ft2(val_exp_file)

    # Normalise to unit peak height so scale matches training data
    max_val = max(np.max(np.abs(d2rr)), np.max(np.abs(d2ir)))
    if max_val > 0:
        d2rr = d2rr / max_val
        d2ir = d2ir / max_val

    # Generate a grid of combinations of left/right phase errors
    pairs = list(itertools.product(phase_values, phase_values))
    n_samples = len(pairs)

    ny, nx = d2rr.shape
    spectra_np = np.zeros((n_samples, ny, nx, 2), dtype=np.float32)
    gt_left = np.zeros((n_samples,), dtype=np.float32)
    gt_right = np.zeros((n_samples,), dtype=np.float32)

    # Use coordinates along the direct dimension (x) to apply linear phase error
    x_coords_spectrum = np.arange(nx, dtype=np.float32) / max(nx - 1.0, 1.0) # shape (nx,)

    for i, (pl, pr) in enumerate(pairs):
        phi_deg = pl + (pr - pl) * x_coords_spectrum
        phi_rad = phi_deg * (np.pi / 180.0)
        cos_phi = np.cos(phi_rad)[None, :]
        sin_phi = np.sin(phi_rad)[None, :]

        # Apply rotation (standard complex rotation)
        rr_phased = d2rr * cos_phi - d2ir * sin_phi
        ir_phased = d2rr * sin_phi + d2ir * cos_phi

        spectra_np[i, :, :, 0] = rr_phased
        spectra_np[i, :, :, 1] = ir_phased
        gt_left[i] = pl
        gt_right[i] = pr

    t_total = nx // TOKEN_WIDTH

    print(f"  Spectra grid shape: {spectra_np.shape}")
    print(f"  Number of tokens: {t_total} (token_width={TOKEN_WIDTH})")

    # Extract 2D patches from reference spectrum copies, excluding boundary regions along indirect dimension
    print("[Validation] Extracting Top-N patches from spectra (excluding edges)...")
    patches_power, row_idx, row_score = _extract_topn_patches_numpy(
        spectra_np,
        top_n=TOP_N,
        token_width=TOKEN_WIDTH,
        patch_height=PATCH_HEIGHT,
        direct_extension=DIRECT_EXTEND,
        exclude_border=True,
    )

    # Reals only for model30 input
    patches_np = patches_power[..., :1]

    # Build model30 patches model
    model = build_transformer_phase_model_v30_patches(
        n_tokens=t_total,
        top_n=TOP_N,
        token_width=TOKEN_WIDTH,
        patch_height=PATCH_HEIGHT,
        direct_extend=DIRECT_EXTEND,
    )

    if os.path.exists(weights_path):
        model.load_weights(weights_path)
        print(f"[Model] Loaded weights: {weights_path}")
    else:
        print(f"[Warning] Weights not found: {weights_path}")
        print("[Warning] Running with random model weights.")

    # Model inference
    x_batch = {"patch_input": tf.constant(patches_np, dtype=tf.float32)}
    phase_model_t, local_preds_t, patch_local_t = model(x_batch, training=False)

    phase_model = phase_model_t.numpy().astype(np.float32)
    local_preds = local_preds_t.numpy().astype(np.float32)
    patch_local = patch_local_t.numpy().astype(np.float32)

    # Calculate token normalization factors (maximum absolute value before normalization)
    token_norms = np.zeros((n_samples, t_total), dtype=np.float32)
    spectra_x_pad = np.pad(spectra_np, ((0, 0), (0, 0), (DIRECT_EXTEND, DIRECT_EXTEND), (0, 0)), mode="constant")
    half = PATCH_HEIGHT // 2
    ext_width = TOKEN_WIDTH + 2 * DIRECT_EXTEND

    for b in range(n_samples):
        for t in range(t_total):
            x0 = t * TOKEN_WIDTH
            token_ext = spectra_x_pad[b, :, x0 : x0 + ext_width, :]
            token_ext_padded_y = np.pad(token_ext, ((half, half), (0, 0), (0, 0)), mode="constant")
            max_val = 0.0
            for k in range(TOP_N):
                cy = int(row_idx[b, t, k]) + half
                patch = token_ext_padded_y[cy - half : cy - half + PATCH_HEIGHT, :, :]
                max_val = max(max_val, np.max(np.abs(patch)))
            token_norms[b, t] = max_val

    # Compute WLS regression in numpy using combined model weights and signal strength weights
    phase_wls = wls_phase_regression_softmax_numpy(
        local_preds,
        direct_dim=nx,
        token_norms=token_norms,
        token_width=TOKEN_WIDTH,
        l2_reg=L2_REG,
        use_token_norms=use_token_norms,
    )

    err_left = phase_wls[:, 0] - gt_left
    err_right = phase_wls[:, 1] - gt_right

    mae_left = float(np.mean(np.abs(err_left)))
    mae_right = float(np.mean(np.abs(err_right)))
    rmse_left = float(np.sqrt(np.mean(err_left * err_left)))
    rmse_right = float(np.sqrt(np.mean(err_right * err_right)))

    # Calculate w_eff using stable softmax of s (excluding first and last tokens)
    s_tensor = local_preds[..., 1]
    s_mid = s_tensor[:, 1:-1]
    s_max = np.max(-s_mid, axis=-1, keepdims=True)
    exp_s_mid = np.exp(-s_mid - s_max)
    w_mid = exp_s_mid / np.sum(exp_s_mid, axis=-1, keepdims=True)
    w_eff = np.zeros_like(s_tensor)
    w_eff[:, 1:-1] = w_mid

    x_coords = (((np.arange(t_total, dtype=np.float32) * TOKEN_WIDTH) + (0.5 * TOKEN_WIDTH)) / float(nx))[None, :]
    true_local = gt_left[:, None] * (1.0 - x_coords) + gt_right[:, None] * x_coords

    print("[Metrics]")
    print(f"  MAE left : {mae_left:.6f} deg")
    print(f"  MAE right: {mae_right:.6f} deg")
    print(f"  RMSE left : {rmse_left:.6f} deg")
    print(f"  RMSE right: {rmse_right:.6f} deg")

    print("[Per-Sample]")
    for i in range(min(10, n_samples)):
        print(
            f"  #{i+1:02d} gt=({gt_left[i]:>5.1f},{gt_right[i]:>5.1f}) "
            f"wls=({phase_wls[i,0]:>7.3f},{phase_wls[i,1]:>7.3f}) "
            f"model=({phase_model[i,0]:>7.3f},{phase_model[i,1]:>7.3f})"
        )

    out = {
        "train_patches": patches_np.astype(np.float32),
        "train_patches_power": patches_power.astype(np.float32),
        "train_gt_left": gt_left,
        "train_gt_right": gt_right,
        "train_pred_left": phase_wls[:, 0],
        "train_pred_right": phase_wls[:, 1],
        "train_pred_local_phase": local_preds[..., 0],
        "train_pred_local_s": local_preds[..., 1],
        "train_pred_local_w": w_eff,
        "train_true_local": true_local,
        "train_x_coords_tokens": x_coords,
        "train_pred_patch_phase": patch_local[..., 0],
        "train_pred_patch_w_logits": patch_local[..., 1],
        "train_topn_row_idx_from_power": row_idx.astype(np.int32) + 1,
        "train_topn_row_score_from_power": row_score,
        "mae_left": np.array([mae_left], dtype=np.float32),
        "mae_right": np.array([mae_right], dtype=np.float32),
        "train_spectrum_rr": spectra_np[:, :, :, 0],
        "train_spectrum_ir": spectra_np[:, :, :, 1],
        "train_token_norms": token_norms,
    }

    sio.savemat(output_mat, out)
    print(f"[Save] Wrote validation MAT: {output_mat}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validate NUS2D model30 on experimental KRAS data")
    parser.add_argument("--weights", type=str, default="model30_2d_patches.weights.h5", help="Path to model30 weights")
    parser.add_argument("--output", type=str, default="model30_validation_fixed_equal.mat", help="Output MAT file")
    parser.add_argument("--ft2", type=str, default="kras_nus25.ft2", help="Path to experimental .ft2 file (NMRPipe format)")
    parser.add_argument("--cpu", type=int, default=1, choices=[0, 1], help="Force CPU-only inference")
    parser.add_argument(
        "--use-token-norms",
        type=int,
        default=0,
        choices=[0, 1],
        help="Use token normalization factor as additional weight factor",
    )
    args = parser.parse_args()

    validate_model30(
        weights_path=args.weights,
        output_mat=args.output,
        val_exp_file=args.ft2,
        phase_values=(-20.0, 0.0, 20.0),
        force_cpu=bool(args.cpu),
        use_token_norms=bool(args.use_token_norms),
    )
