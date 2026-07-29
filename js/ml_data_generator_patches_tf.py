"""
TensorFlow training-data generator for 2D phase model training.

Extracts top-N 2D patches and applies linear phase and baseline errors in TensorFlow.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

# Add parent directory to sys.path to allow imports from "nus2D"
parent_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if parent_dir not in sys.path:
    sys.path.append(parent_dir)

from nus2D.ml_data_generator_tilted import generate_nmr_batch as generate_full_spectrum_batch


@dataclass
class PatchCache:
    patches: np.ndarray
    phase_weights: np.ndarray
    full_spectra: Optional[np.ndarray] = None
    row_idx: Optional[np.ndarray] = None
    row_score: Optional[np.ndarray] = None


def _extract_topn_patches_numpy(
    spectra: np.ndarray,
    top_n: int = 5,
    token_width: int = 32,
    patch_height: int = 32,
    direct_extension: int = 32,
    exclude_border: bool = False,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    spectra = np.asarray(spectra, dtype=np.float32)
    bsz, ny, nx, channels = spectra.shape

    t_total = max(nx // token_width, 1)
    nx_use = t_total * token_width
    spectra = spectra[:, :, :nx_use, :]

    ext_width = token_width + 2 * direct_extension
    half = patch_height // 2

    patches = np.zeros((bsz, t_total, top_n, patch_height, ext_width, channels), dtype=np.float32)
    row_idx = np.zeros((bsz, t_total, top_n), dtype=np.int32)
    row_score = np.full((bsz, t_total, top_n), -1e9, dtype=np.float32)

    # Pad direct dimension to allow extended extraction at the edges
    spectra_x_pad = np.pad(spectra, ((0, 0), (0, 0), (direct_extension, direct_extension), (0, 0)), mode="constant")

    for b in range(bsz):
        for t in range(t_total):
            x0 = t * token_width

            token_x = spectra[b, :, x0 : x0 + token_width, :]
            power = token_x[..., 0] * token_x[..., 0] + token_x[..., 1] * token_x[..., 1]
            score_per_row = np.max(power, axis=1)
            order = np.argsort(score_per_row)[::-1]

            selected = []
            for idx in order:
                idx = int(idx)
                if exclude_border and (idx < half or idx >= ny - half):
                    continue
                if all(abs(idx - s) >= patch_height for s in selected):
                    selected.append(idx)
                if len(selected) >= top_n:
                    break

            if len(selected) < top_n:
                for idx in order:
                    idx = int(idx)
                    if exclude_border and (idx < half or idx >= ny - half):
                        continue
                    if idx not in selected:
                        selected.append(idx)
                    if len(selected) >= top_n:
                        break

            if len(selected) == 0:
                fallback_idx = half if (exclude_border and ny > patch_height) else 0
                selected = [fallback_idx] * top_n
            elif len(selected) < top_n:
                selected.extend([selected[-1]] * (top_n - len(selected)))

            # Extract extended patches using the padded spectrum
            token_ext = spectra_x_pad[b, :, x0 : x0 + ext_width, :]
            token_ext_padded_y = np.pad(token_ext, ((half, half), (0, 0), (0, 0)), mode="constant")

            for k in range(top_n):
                cy = int(selected[k]) + half
                patch = token_ext_padded_y[cy - half : cy - half + patch_height, :, :]
                patches[b, t, k, :, :, :] = patch
                row_idx[b, t, k] = int(selected[k])
                row_score[b, t, k] = float(score_per_row[int(selected[k])])

            # Normalize patches for this token to max absolute amplitude 1.0
            token_patches = patches[b, t, ...]
            max_val = np.max(np.abs(token_patches))
            if max_val > 1e-9:
                patches[b, t, ...] = token_patches / max_val

    return patches, row_idx, row_score


def build_patch_cache_from_base_spectra(
    num_base_spectra: int,
    top_n: int = 5,
    token_width: int = 32,
    patch_height: int = 32,
    direct_extension: int = 32,
    use_nus: bool | str = "mix",
) -> PatchCache:
    spectra_list = []
    weights_list = []

    for _ in range(int(num_base_spectra)):
        curr_nus = np.random.choice([True, False]) if use_nus == "mix" else bool(use_nus)
        spectrum, _, _, phase_weights = generate_full_spectrum_batch(
            batchsize=1,
            number_of_phase=1,
            debug_clean=True,
            include_gt=False,
            use_nus=curr_nus,
        )
        spectra_list.append(np.asarray(spectrum[0], dtype=np.float32))
        weights_list.append(np.asarray(phase_weights[0], dtype=np.float32))
    max_ny = max(s.shape[0] for s in spectra_list)
    padded_spectra_list = []
    for s in spectra_list:
        if s.shape[0] < max_ny:
            padded = np.pad(s, ((0, max_ny - s.shape[0]), (0, 0), (0, 0)), mode="constant")
            padded_spectra_list.append(padded)
        else:
            padded_spectra_list.append(s)

    spectra = np.stack(padded_spectra_list, axis=0).astype(np.float32)
    phase_weights = np.stack(weights_list, axis=0).astype(np.float32)

    patches, row_idx, row_score = _extract_topn_patches_numpy(
        spectra,
        top_n=top_n,
        token_width=token_width,
        patch_height=patch_height,
        direct_extension=direct_extension,
    )

    return PatchCache(
        patches=patches,
        phase_weights=phase_weights,
        full_spectra=spectra,
        row_idx=row_idx,
        row_score=row_score,
    )


def apply_random_baseline_to_patches_np(patches: np.ndarray, max_deviation: float = 0.1) -> np.ndarray:
    """
    Adds a random 0, 1, or 2 order polynomial baseline to patches in spatial and direct directions.
    The total baseline deviation is scaled to at most max_deviation.
    """
    patches = np.asarray(patches, dtype=np.float32)
    s = patches.shape
    bsz, ntok, top_n, ny, nx = s[0], s[1], s[2], s[3], s[4]

    def get_poly_basis(size):
        x = np.linspace(-1.0, 1.0, size, dtype=np.float32)
        # order 0, 1, 2 basis: [1, x, x^2]
        return np.stack([np.ones_like(x), x, x*x], axis=0) # (3, size)

    basis_y = get_poly_basis(ny)
    basis_x = get_poly_basis(nx)

    # Random coefficients for each sample, token, top_n, and for both Real/Imag channels
    # Shape: (bsz, ntok, top_n, channels=2, directions=2, orders=3)
    coeffs = np.random.uniform(-1.0, 1.0, size=(bsz, ntok, top_n, 2, 2, 3)).astype(np.float32)

    # 1D Baselines
    b_y = np.matmul(coeffs[:, :, :, :, 0, :], basis_y) # (bsz, ntok, top_n, 2, ny)
    b_x = np.matmul(coeffs[:, :, :, :, 1, :], basis_x) # (bsz, ntok, top_n, 2, nx)

    # Total baseline: (bsz, ntok, top_n, 2, ny, nx)
    total_b = b_y[:, :, :, :, :, np.newaxis] + b_x[:, :, :, :, np.newaxis, :]

    # Scale each patch's baseline to max_deviation
    max_val = np.max(np.abs(total_b), axis=(4, 5), keepdims=True)
    total_b = total_b * (max_deviation / (max_val + 1e-9))

    # Transpose to match (bsz, ntok, top_n, ny, nx, 2)
    total_b_final = np.transpose(total_b, (0, 1, 2, 4, 5, 3))
    return patches + total_b_final


def apply_linear_phase_to_patches_np(
    patches: np.ndarray,
    phi_left_deg: np.ndarray,
    phi_right_deg: np.ndarray,
    token_width: int = 32,
) -> np.ndarray:
    patches = np.asarray(patches, dtype=np.float32)
    phi_left_deg = np.asarray(phi_left_deg, dtype=np.float32)
    phi_right_deg = np.asarray(phi_right_deg, dtype=np.float32)

    bsz = patches.shape[0]
    ntok = patches.shape[1]
    top_n = patches.shape[2]
    patch_h = patches.shape[3]
    direct_size = patches.shape[4]

    # nd_total is the original spectrum width (before tokenization)
    nd_total = float(ntok * token_width)
    # direct_ext is the padding on each side (e.g., 32)
    direct_ext = (float(direct_size) - float(token_width)) / 2.0

    # Token-wise x_global calculation
    t_idx = np.arange(ntok, dtype=np.float32)[:, np.newaxis, np.newaxis]
    d_idx = np.arange(direct_size, dtype=np.float32)[np.newaxis, np.newaxis, :]
    global_idx = t_idx * float(token_width) - direct_ext + d_idx
    x_global = global_idx / max(nd_total - 1.0, 1.0) # (ntok, 1, direct_size)

    # Phase calculation
    p_left = phi_left_deg[:, np.newaxis, np.newaxis, np.newaxis]
    p_right = phi_right_deg[:, np.newaxis, np.newaxis, np.newaxis]
    phi = (p_left + (p_right - p_left) * x_global[np.newaxis, ...]) * (np.pi / 180.0)

    # Collapse patches to rank 5
    patches_flat = patches.reshape(bsz, ntok, -1, direct_size, 2)
    
    rr = patches_flat[..., 0]
    ri = patches_flat[..., 1]
    c = np.cos(phi)
    s = np.sin(phi)
    rr_p = rr * c - ri * s
    ri_p = rr * s + ri * c
    
    out_flat = np.stack([rr_p, ri_p], axis=-1)
    return out_flat.reshape(bsz, ntok, top_n, patch_h, direct_size, 2)


def generate_nmr_batch(
    batchsize: int,
    number_of_phase: int,
    patch_cache: Optional[PatchCache] = None,
    debug_clean: bool = False,
    top_n: int = 5,
    token_width: int = 32,
    patch_height: int = 32,
    direct_extension: int = 32,
    min_left_phase_deg: float = -20.0,
    max_left_phase_deg: float = 20.0,
    min_right_phase_deg: float = -20.0,
    max_right_phase_deg: float = 20.0,
):
    """Generate phase-augmented patch batches for TensorFlow training."""
    if number_of_phase <= 0:
        raise ValueError("number_of_phase must be >= 1")
    if batchsize % number_of_phase != 0:
        raise ValueError("batchsize must be evenly divisible by number_of_phase")

    num_base = batchsize // number_of_phase

    if patch_cache is None:
        patch_cache = build_patch_cache_from_base_spectra(
            num_base_spectra=num_base,
            top_n=top_n,
            token_width=token_width,
            patch_height=patch_height,
            direct_extension=direct_extension,
        )

    rng = np.random.default_rng()
    base_count = int(patch_cache.patches.shape[0])
    base_indices = rng.choice(base_count, size=num_base, replace=True)

    base_patches = patch_cache.patches[base_indices]
    base_weights = patch_cache.phase_weights[base_indices]

    patches = np.repeat(base_patches, number_of_phase, axis=0)
    phase_weights = np.repeat(base_weights, number_of_phase, axis=0)

    if debug_clean:
        phi_left = np.zeros((batchsize,), dtype=np.float32)
        phi_right = np.zeros((batchsize,), dtype=np.float32)
    else:
        phi_left = rng.uniform(min_left_phase_deg, max_left_phase_deg, size=(batchsize,)).astype(np.float32)
        phi_right = rng.uniform(min_right_phase_deg, max_right_phase_deg, size=(batchsize,)).astype(np.float32)

    phased_patches = apply_linear_phase_to_patches_np(
        patches,
        phi_left,
        phi_right,
        token_width=token_width,
    )
    
    # Add random baseline
    phased_patches = apply_random_baseline_to_patches_np(phased_patches, max_deviation=0.1)

    # Normalize patches for each token to max absolute amplitude 1.0 (Method 1)
    max_val = np.max(np.abs(phased_patches), axis=(2, 3, 4, 5), keepdims=True)
    phased_patches = np.where(max_val > 1e-9, phased_patches / max_val, phased_patches).astype(np.float32)

    return phased_patches, phi_left, phi_right, phase_weights


def dict_generator(
    batchsize: int,
    number_of_phase: int,
    patch_cache: Optional[PatchCache] = None,
    top_n: int = 5,
    token_width: int = 32,
    patch_height: int = 32,
    direct_extension: int = 32,
):
    """Yield model-ready dictionaries for training pipelines using pure NumPy."""
    while True:
        patches, phi_left, phi_right, phase_weights = generate_nmr_batch(
            batchsize=batchsize,
            number_of_phase=number_of_phase,
            patch_cache=patch_cache,
            debug_clean=False,
            top_n=top_n,
            token_width=token_width,
            patch_height=patch_height,
            direct_extension=direct_extension,
        )

        # Reals only as requested for model22 input
        reals_only = patches[..., :1]

        x = {"patch_input": reals_only.astype(np.float32)}
        y_local = np.stack([phi_left, phi_right], axis=-1)
        y_phase = np.concatenate([y_local, phase_weights], axis=-1)
        yield x, {"phase": y_phase, "local": y_local}


if __name__ == "__main__":
    import scipy.io

    # 1. Generate one simulated GT spectrum (clean)
    print("Generating one simulated GT spectrum...")
    res_full = generate_full_spectrum_batch(
        batchsize=1,
        number_of_phase=1,
        include_gt=True,
        use_nus=True,
        include_water=True,
        debug_clean=True
    )
    spectra_gt_np = res_full[4]  # Shape: (1, 1024, 2048, 2)
    ny, nx = spectra_gt_np.shape[1], spectra_gt_np.shape[2]

    # 2. Extract clean patches from the clean spectrum first (so they are normalized clean)
    print("Extracting clean patches...")
    patches_clean, row_idx, row_score = _extract_topn_patches_numpy(
        spectra_gt_np,
        top_n=5,
        token_width=32,
        patch_height=32,
        direct_extension=32
    )  # Shape: (1, 64, 5, 32, 96, 2)

    # Replicate clean patches 5 times for the 5 phase error samples
    patches_clean_tiled = np.repeat(patches_clean, 5, axis=0)  # Shape: (5, 64, 5, 32, 96, 2)

    # 3. Apply phase errors to both spectra and patches
    phase_pairs = [(-20.0, -20.0), (-10.0, -10.0), (0.0, 0.0), (10.0, 10.0), (20.0, 20.0)]
    phi_left = np.array([p[0] for p in phase_pairs], dtype=np.float32)
    phi_right = np.array([p[1] for p in phase_pairs], dtype=np.float32)

    # 3a. Phase the full spectra
    phased_spectra_list = []
    w2_indices = np.arange(nx, dtype=np.float32)
    rr_gt = spectra_gt_np[0, :, :, 0]
    ir_gt = spectra_gt_np[0, :, :, 1]

    for pl, pr in phase_pairs:
        phi_deg = pl + (pr - pl) * (w2_indices / (nx - 1.0))
        phi_rad = phi_deg * (np.pi / 180.0)
        cos_phi = np.cos(phi_rad)[None, :]
        sin_phi = np.sin(phi_rad)[None, :]

        # Standard complex phase rotation
        rr_phased = rr_gt * cos_phi - ir_gt * sin_phi
        ir_phased = rr_gt * sin_phi + ir_gt * cos_phi
        phased_spectra_list.append(np.stack([rr_phased, ir_phased], axis=-1))

    spectra_phased = np.stack(phased_spectra_list, axis=0)  # Shape: (5, 1024, 2048, 2)
    print("Phased spectra stacked shape:", spectra_phased.shape)

    # 3b. Extract patches from the phased spectra directly
    print("Extracting patches from phased spectra...")
    patches_phased, row_idx_phased, row_score_phased = _extract_topn_patches_numpy(
        spectra_phased,
        top_n=5,
        token_width=32,
        patch_height=32,
        direct_extension=32
    )
    print("Phased patches shape:", patches_phased.shape)

    # 4. Save everything to a MATLAB file
    out_file = 'debug_phased_patches.mat'
    scipy.io.savemat(out_file, {
        'spectra_rr': spectra_phased[:, :, :, 0],
        'spectra_ir': spectra_phased[:, :, :, 1],
        'patches': patches_phased,
        'row_idx': row_idx_phased + 1,  # 1-based indexing for MATLAB
        'row_score': row_score_phased,
        'phi_left': phi_left,
        'phi_right': phi_right,
    })
    print(f"Saved to {out_file} successfully.")

