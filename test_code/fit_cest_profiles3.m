% FIT_CEST_PROFILES3
% Fits 1/Z CEST profiles using a 4-step multi-peak Voigt algorithm with
% Expectation-Maximization (EM) optimization and per-iteration visualization.
%
% Inversion Transformation:
%   Instead of fitting downward dips in Z (where Z drops from ~0.70 to near 0),
%   we fit upward positive peaks in Y = 1/Z.
%   - Baseline is at y0 = 1 / Z_baseline ~ 1.43.
%   - Absorption dips in Z become positive emission-like peaks in 1/Z.
%   - Points with Z <= 0 (due to experimental noise) are clamped to z_min_floor (default: 0.01).
%
% Algorithm:
%   Step 1: Positive peak picking on raw 1/Z profile above 5x noise level,
%           considering noise fluctuations (prominence and line-width separation).
%   Step 2: Single-peak Voigt fitting without additional cost (pure least-squares MSE),
%           limited to within fit_window of primary peak center.
%   Step 3: Peak picking on residues within the fitting area to detect
%           unmodeled secondary peaks (doublets/shoulders).
%   Step 4: Fit all detected peaks using Expectation-Maximization (EM)
%           limited strictly to within fit_window of peak centers,
%           plotting fitted vs. input spectra at each iteration.
%
% Display:
%   Focuses on target profiles [51, 52, 53, 56, 61, 66] across figure(1) to figure(6).
%   - subplot(2, 1, 1): Shows Iteration 1 (initial EM step)
%   - subplot(2, 1, 2): Shows Final Iteration (converged EM step) with fitting residues

% -------------------------------------------------------------------------
% 1. Verify / Load Z_data
% -------------------------------------------------------------------------
if ~exist('Z_data', 'var') || isempty(Z_data)
    fprintf('Z_data not found in workspace. Reading from cest.tab...\n');
    if exist('read_cest_tab', 'file') == 2
        Z_data = read_cest_tab();
    elseif exist(fullfile(fileparts(mfilename('fullpath')), 'cest.tab'), 'file')
        tab_path = fullfile(fileparts(mfilename('fullpath')), 'cest.tab');
        fid = fopen(tab_path, 'r');
        if fid == -1
            error('Could not open %s', tab_path);
        end
        h_cols = {};
        d_tokens = {};
        tline = fgetl(fid);
        while ischar(tline)
            str_t = strtrim(tline);
            if ~isempty(str_t)
                if strncmp(str_t, 'VARS', 4)
                    toks = regexp(str_t, '\s+', 'split');
                    h_cols = toks(2:end);
                elseif ~strncmp(str_t, 'DATA', 4) && ~strncmp(str_t, 'FORMAT', 6) && ~strncmp(str_t, '#', 1)
                    d_tokens{end + 1} = regexp(str_t, '\s+', 'split'); %#ok<AGROW>
                end
            end
            tline = fgetl(fid);
        end
        fclose(fid);
        
        target_cols = arrayfun(@(k) sprintf('Z_A%d', k), 0:99, 'UniformOutput', false);
        z_col_idx = cellfun(@(c) find(strcmp(h_cols, c), 1), target_cols);
        Z_data = zeros(length(d_tokens), length(target_cols));
        for r = 1:length(d_tokens)
            for c = 1:length(target_cols)
                Z_data(r, c) = str2double(d_tokens{r}{z_col_idx(c)});
            end
        end
    else
        error('Z_data not found in workspace and cest.tab could not be located.');
    end
end

[num_rows, num_cols] = size(Z_data);
fprintf('Loaded Z_data: %d rows (peaks), %d columns.\n', num_rows, num_cols);

% -------------------------------------------------------------------------
% 2. Setup x-coordinates and Target Rows
% -------------------------------------------------------------------------
if ~exist('x', 'var') || isempty(x) || length(x) ~= num_cols
    x = 1:num_cols;
else
    x = x(:)';
end

% Target profiles requested: [51, 52, 53, 56, 61, 66]
if ~exist('target_rows', 'var') || isempty(target_rows)
    target_rows = [51, 52, 53, 56, 61, 66];
end

% Ensure target_rows are within valid bounds
target_rows = target_rows(target_rows >= 1 & target_rows <= num_rows);
num_targets = length(target_rows);
fprintf('Selected %d profiles to fit: %s\n', num_targets, mat2str(target_rows));

% -------------------------------------------------------------------------
% 3. Setup Parameters and Execution Controls
% -------------------------------------------------------------------------
% z_min_floor: floor to clamp Z values before inverting to 1/Z (prevents <= 0 division)
if ~exist('z_min_floor', 'var') || isempty(z_min_floor)
    z_min_floor = 0.01;
end
fprintf('1/Z transformation: Z clamped at minimum %.3f (max 1/Z = %.1f).\n', ...
    z_min_floor, 1 / z_min_floor);

% fit_window: maximum distance in points from peak center(s) included in fitting (default: 10)
if ~exist('fit_window', 'var') || isempty(fit_window)
    fit_window = 10;
end
fprintf('Fitting area limit: within %d points of peak centers.\n', fit_window);

% pause_time = 0   -> waits for user keypress ('pause') after each profile
% pause_time > 0   -> pauses pause_time seconds after each profile
% pause_time < 0   -> headless/batch mode (skip interactive pauses)
if ~exist('pause_time', 'var') || isempty(pause_time)
    pause_time = 0;
end

% pause_iter: delay in seconds between EM iterations to visualize live convergence
if ~exist('pause_iter', 'var') || isempty(pause_iter)
    pause_iter = 0.08;
end

% Maximum EM iterations and convergence threshold
if ~exist('max_em_iter', 'var') || isempty(max_em_iter)
    max_em_iter = 60;
end
if ~exist('conv_tol', 'var') || isempty(conv_tol)
    conv_tol = 1e-4;
end

% Physical width bounds for 1/Z peaks:
% In 1/Z, the reciprocal transformation makes peaks sharper near resonance (FWHM ~ 0.4 to 3.5)
if ~exist('max_fwhm', 'var') || isempty(max_fwhm)
    max_fwhm = 4.0;
end
if ~exist('min_fwhm', 'var') || isempty(min_fwhm)
    min_fwhm = 0.4;
end

% Asymmetric error factor (optional, default: 1.0 for pure least-squares):
if ~exist('asym_factor', 'var') || isempty(asym_factor)
    asym_factor = 1.0;
end
if asym_factor ~= 1.0
    fprintf('Asymmetric error factor: %.2f\n', asym_factor);
end

% Debug option: force a 2nd peak for row 53 only
if ~exist('force_row53_2nd_peak', 'var') || isempty(force_row53_2nd_peak)
    force_row53_2nd_peak = true; % default: true to force 2nd peak on row 53
end
if ~exist('row53_forced_peak2_center', 'var') || isempty(row53_forced_peak2_center)
    row53_forced_peak2_center = 56.5; % default forced center for row 53
end
if ~exist('row53_forced_peak2_amp', 'var') || isempty(row53_forced_peak2_amp)
    row53_forced_peak2_amp = 5.0; % default forced amplitude in 1/Z for row 53
end
if force_row53_2nd_peak
    fprintf('Debug mode: Forcing a 2nd peak for row 53 only (initial center = %.2f, Amp = %.3f).\n', ...
        row53_forced_peak2_center, row53_forced_peak2_amp);
end

% -------------------------------------------------------------------------
% 4. Verify Voigt Function & Helpers
% -------------------------------------------------------------------------
if ~exist('voigt', 'file') && ~exist('voigt', 'builtin')
    error('voigt function not found in MATLAB path. Please ensure voigt(x, sigma, gamma) is available.');
end

% Model evaluation helpers:
% Evaluates single normalized Voigt peak profile (peak height = A at center x0)
eval_single_peak = @(A, x0, sig, gam, xi) ...
    A * (reshape(voigt(xi - x0, max(sig, 1e-4), max(gam, 0)), size(xi)) ./ ...
         max(voigt(0, max(sig, 1e-4), max(gam, 0)), 1e-12));

% Evaluates baseline y0 plus single Voigt upward peak (1/Z model)
eval_voigt_peak = @(p, xi) ...
    p(1) + eval_single_peak(p(2), p(3), p(4), p(5), xi);

% Olivero & Longbothum 1977 Voigt FWHM formula
calc_fwhm_voigt = @(sig, gam) ...
    0.5346 * (2 * gam) + sqrt(0.2166 * (2 * gam)^2 + (2 * sqrt(2 * log(2)) * sig)^2);

% Asymmetric error helpers (if asym_factor > 1.0):
% For upward peak: if y_fit > y_exp (fit stronger than data), multiply error by asym_factor
calc_asym_err = @(r, factor) r .* (1.0 + (factor - 1.0) * (r < 0));

has_fmincon = (exist('fmincon', 'file') == 2);
if has_fmincon
    fmin_opts = optimoptions('fmincon', 'Display', 'off', 'MaxIterations', 200, 'MaxFunctionEvaluations', 1500);
else
    fmin_opts = optimset('Display', 'off', 'MaxFunEvals', 2500, 'MaxIter', 1500);
end

% Component color palette for distinct peak plotting
comp_colors = [
    0.85, 0.20, 0.10;  % Crimson
    0.10, 0.60, 0.25;  % Emerald Green
    0.70, 0.15, 0.70;  % Purple
    0.90, 0.50, 0.05;  % Amber
    0.00, 0.65, 0.85   % Cyan
];

% -------------------------------------------------------------------------
% 5. Main Processing Loop for Target Profiles (Fitting 1/Z)
% -------------------------------------------------------------------------
fit_results3 = repmat(struct('row', 0, ...
                             'fig_num', 0, ...
                             'y0', NaN, ...
                             'num_peaks', 0, ...
                             'fit_window_range', [], ...
                             'peaks', [], ...
                             'rmse_init', NaN, ...
                             'rmse_final', NaN, ...
                             'max_abs_err', NaN, ...
                             'r2_final', NaN, ...
                             'em_iterations', 0), num_targets, 1);

for fig_idx = 1:num_targets
    row_num = target_rows(fig_idx);
    fig_num = fig_idx; % figures(1) to figures(6)
    
    z_raw = Z_data(row_num, :);
    valid = ~isnan(z_raw) & ~isinf(z_raw);
    x_val = x(valid);
    z_val = z_raw(valid);
    
    % Transform Z to 1/Z with noise-floor clamping
    y_val = 1 ./ max(z_val, z_min_floor);
    N_pts = length(y_val);
    
    if N_pts < 6
        fprintf('Row %d: Insufficient valid data points (%d pts).\n', row_num, N_pts);
        continue;
    end
    
    fprintf('\n========================================================================\n');
    fprintf('Processing Profile %d on 1/Z (Figure %d / %d)\n', row_num, fig_idx, num_targets);
    fprintf('========================================================================\n');
    
    % ---------------------------------------------------------------------
    % STEP 1: Positive Peak Picking on 1/Z (> 5x noise level)
    % ---------------------------------------------------------------------
    % Baseline estimate: median of lower 60% of data points
    y_sorted = sort(y_val);
    y0_est = median(y_sorted(1:floor(N_pts * 0.6)));
    
    [max_val, max_idx] = max(y_val);
    initial_pk_height = max(0, max_val - y0_est);
    
    % Noise estimate on baseline points (robust high-frequency differencing + baseline pts)
    diff_y = diff(y_val);
    noise_diff = median(abs(diff_y - median(diff_y))) / (0.6745 * sqrt(2));
    base_mask = (y_val <= y0_est + 0.35);
    if sum(base_mask) >= 10
        noise_base = std(y_val(base_mask));
    else
        noise_base = noise_diff;
    end
    noise_est = max([min(noise_base, noise_diff), 1e-4]);
    
    thresh_5x = 5.0 * noise_est;
    fprintf('Step 1: Noise estimate = %.4f | 5x Noise Threshold = %.4f | Baseline est = %.3f\n', ...
        noise_est, thresh_5x, y0_est);
    
    pk_raw = y_val - y0_est;
    [raw_locs, raw_pks] = find_extrema_with_noise(pk_raw, x_val, thresh_5x, 1.5 * noise_est, 2.5);
    
    if isempty(raw_locs)
        if initial_pk_height >= 3 * noise_est
            raw_locs = x_val(max_idx);
            raw_pks  = initial_pk_height;
        else
            fprintf('Row %d: No positive peak detected above noise threshold in 1/Z.\n', row_num);
            continue;
        end
    end
    
    [~, sort_idx] = sort(raw_pks, 'descend');
    primary_x0 = raw_locs(sort_idx(1));
    primary_amp = raw_pks(sort_idx(1));
    fprintf('Step 1: Picked primary positive peak in 1/Z at x0 = %.2f (height = %.2f, %.1f x noise)\n', ...
        primary_x0, primary_amp, primary_amp / noise_est);
    
    % ---------------------------------------------------------------------
    % STEP 2: Voigt Fitting Without Additional Cost (Limited to fit_window)
    % ---------------------------------------------------------------------
    % Restrict data to within fit_window of primary peak center
    mask_step2 = abs(x_val - primary_x0) <= fit_window;
    x_val_step2 = x_val(mask_step2);
    y_val_step2 = y_val(mask_step2);
    
    init_fwhm = 1.2;
    sigma_est = (0.5 * init_fwhm) / 2.355;
    gamma_est = (0.5 * init_fwhm) / 2.0;
    p0 = [y0_est, primary_amp, primary_x0, sigma_est, gamma_est];
    
    lb = [max(0.5, min(y_val_step2) - 0.5), 0, min(x_val_step2), min_fwhm / 5, 0];
    ub = [max(3.5, y0_est + 1.0), max(y_val_step2) * 1.5, max(x_val_step2), max_fwhm / 2.355, max_fwhm / 2.0];
    
    A_ineq = [0, 0, 0,  2.355,  2.0; ...
              0, 0, 0, -2.355, -2.0];
    b_ineq = [max_fwhm; -min_fwhm];
    
    if asym_factor ~= 1.0
        obj_fun_step2 = @(p) mean((calc_asym_err(y_val_step2 - eval_voigt_peak(p, x_val_step2), asym_factor)).^2);
    else
        obj_fun_step2 = @(p) mean((y_val_step2 - eval_voigt_peak(p, x_val_step2)).^2);
    end
    
    try
        if has_fmincon
            p_step2 = fmincon(obj_fun_step2, p0, A_ineq, b_ineq, [], [], lb, ub, [], fmin_opts);
        else
            obj_barrier = @(p) obj_fun_step2(p) + ...
                1e4 * (p(1) < lb(1) || p(1) > ub(1)) + ...
                1e4 * (p(2) < lb(2) || p(2) > ub(2)) + ...
                1e4 * (p(3) < lb(3) || p(3) > ub(3)) + ...
                1e4 * (p(4) < lb(4) || p(4) > ub(4)) + ...
                1e4 * (p(5) < lb(5) || p(5) > ub(5)) + ...
                1e4 * max(0,  2.355 * p(4) + 2.0 * p(5) - max_fwhm)^2 + ...
                1e4 * max(0, -2.355 * p(4) - 2.0 * p(5) + min_fwhm)^2;
            p_step2 = fminsearch(obj_barrier, p0, fmin_opts);
        end
    catch ME
        warning('Step 2 fitting warning: %s. Using initial guess.', ME.message);
        p_step2 = p0;
    end
    
    fwhm_step2 = calc_fwhm_voigt(p_step2(4), p_step2(5));
    fprintf('Step 2: Single Voigt fit on 1/Z (window [%d..%d]): y0 = %.3f, A = %.2f, x0 = %.2f, FWHM = %.2f\n', ...
        min(x_val_step2), max(x_val_step2), p_step2(1), p_step2(2), p_step2(3), fwhm_step2);
    
    % ---------------------------------------------------------------------
    % STEP 3: Peak Picking on Residues within Fitting Area
    % ---------------------------------------------------------------------
    residuals_step2 = y_val_step2 - eval_voigt_peak(p_step2, x_val_step2);
    % In 1/Z, an unmodeled secondary peak leaves a positive residual (data > fit)
    pk_res = residuals_step2;
    
    diff_res = diff(residuals_step2);
    res_noise = median(abs(diff_res - median(diff_res))) / (0.6745 * sqrt(2));
    if isnan(res_noise) || res_noise < 1e-4
        res_noise = noise_est;
    end
    res_thresh = max(3.0 * res_noise, 3.0 * noise_est);
    
    [res_locs, res_pks] = find_extrema_with_noise(pk_res, x_val_step2, res_thresh, 1.5 * res_noise, 2.0);
    
    if ~isempty(res_locs)
        keep = abs(res_locs - p_step2(3)) >= 1.8; % separation >= 1.8 points
        res_locs = res_locs(keep);
        res_pks  = res_pks(keep);
    end
    
    % Also check if Step 1 detected additional peaks within fit_window
    extra_step1_locs = [];
    extra_step1_pks  = [];
    for k = 1:length(raw_locs)
        if abs(raw_locs(k) - p_step2(3)) <= fit_window && abs(raw_locs(k) - p_step2(3)) >= 2.0 && ...
           (isempty(res_locs) || all(abs(raw_locs(k) - res_locs) >= 1.8))
            extra_step1_locs(end + 1) = raw_locs(k); %#ok<AGROW>
            extra_step1_pks(end + 1)  = raw_pks(k);  %#ok<AGROW>
        end
    end
    
    all_extra_locs = [res_locs, extra_step1_locs];
    all_extra_pks  = [res_pks,  extra_step1_pks];
    
    % DEBUG CODE: Force a 2nd peak for row 53 only
    if row_num == 53 && force_row53_2nd_peak && isempty(all_extra_locs)
        if ~isnan(row53_forced_peak2_center)
            forced_x0 = row53_forced_peak2_center;
            forced_amp = row53_forced_peak2_amp;
        else
            forced_x0 = p_step2(3) + 2.0;
            forced_amp = 5.0;
        end
        all_extra_locs = [forced_x0];
        all_extra_pks  = [forced_amp];
        fprintf('Step 3 [DEBUG row 53]: Forcing 2nd peak at x0 = %.2f (Amp = %.2f).\n', ...
            forced_x0, forced_amp);
    end
    
    if ~isempty(all_extra_locs)
        fprintf('Step 3: Detected %d secondary peak(s) in residues: locs = %s, heights = %s\n', ...
            length(all_extra_locs), mat2str(round(all_extra_locs, 2)), mat2str(round(all_extra_pks, 2)));
    else
        fprintf('Step 3: No secondary peaks found in residues. Single peak model confirmed.\n');
    end
    
    all_locs = [p_step2(3), all_extra_locs];
    all_amps = [p_step2(2), all_extra_pks];
    num_peaks = length(all_locs);
    
    peaks_init = zeros(num_peaks, 4);
    for k = 1:num_peaks
        if k == 1
            peaks_init(1, :) = [p_step2(2), p_step2(3), max(p_step2(4), 0.2), max(p_step2(5), 0.05)];
        else
            peaks_init(k, :) = [all_amps(k), all_locs(k), 0.4, 0.3];
        end
    end
    
    % ---------------------------------------------------------------------
    % STEP 4: Multi-Peak EM Optimization on 1/Z (Within fit_window of Peak Centers)
    % ---------------------------------------------------------------------
    fprintf('Step 4: Running EM fitting on %d peak(s) (window: within %d pts of centers)...\n', ...
        num_peaks, fit_window);
    
    % Initialize figure(fig_num)
    h_fig = figure(fig_num);
    clf(h_fig);
    fig_vis = 'on';
    if pause_time < 0
        fig_vis = 'off';
    end
    set(h_fig, 'Name', sprintf('Profile %d (1/Z): ', row_num), ...
               'NumberTitle', 'off', ...
               'Color', 'w', ...
               'Visible', fig_vis, ...
               'Position', [80 + (fig_idx-1)*40, 60 + (num_targets - fig_idx)*30, 920, 680]);
    
    cur_y0 = p_step2(1);
    peaks_curr = peaks_init;
    prev_rmse = Inf;
    em_history = [];
    
    for em_iter = 1:max_em_iter
        % Limit fitting area to points within fit_window of ANY peak center
        fit_mask = false(size(x_val));
        for k = 1:num_peaks
            fit_mask = fit_mask | (abs(x_val - peaks_curr(k, 2)) <= fit_window);
        end
        x_fit = x_val(fit_mask);
        y_fit = y_val(fit_mask);
        N_fit = length(x_fit);
        
        % E-STEP: Calculate individual component peaks and total peak on fitting area
        S_comp = zeros(num_peaks, N_fit);
        for k = 1:num_peaks
            S_comp(k, :) = eval_single_peak(peaks_curr(k,1), peaks_curr(k,2), peaks_curr(k,3), peaks_curr(k,4), x_fit);
        end
        S_tot = sum(S_comp, 1);
        y_fit_curr = cur_y0 + S_tot; % Baseline PLUS peaks in 1/Z
        res_curr = y_fit - y_fit_curr;
        rmse_curr = sqrt(mean(res_curr.^2));
        max_abs_err_curr = max(abs(res_curr));
        
        ss_tot = sum((y_fit - mean(y_fit)).^2);
        ss_res = sum(res_curr.^2);
        r2_curr = max(0, 1 - (ss_res / max(ss_tot, 1e-12)));
        
        em_history(end + 1).iter   = em_iter; %#ok<AGROW>
        em_history(end).y0         = cur_y0;
        em_history(end).peaks      = peaks_curr;
        em_history(end).rmse       = rmse_curr;
        em_history(end).max_abs_err = max_abs_err_curr;
        em_history(end).r2         = r2_curr;
        em_history(end).fit_mask   = fit_mask;
        
        fprintf('  [EM Iter %2d] RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f | y0 = %.3f | Fit range: [%d..%d] (%d pts)\n', ...
            em_iter, rmse_curr, max_abs_err_curr, r2_curr, cur_y0, min(x_fit), max(x_fit), N_fit);
        for k = 1:num_peaks
            fwhm_k = calc_fwhm_voigt(peaks_curr(k,3), peaks_curr(k,4));
            fprintf('    -> Peak %d: Center = %5.2f, Amp = %6.2f, Sigma = %4.2f, Gamma = %4.2f, FWHM = %4.2f\n', ...
                k, peaks_curr(k,2), peaks_curr(k,1), peaks_curr(k,3), peaks_curr(k,4), fwhm_k);
        end
        
        % -----------------------------------------------------------------
        % LIVE PLOTTING AT THIS ITERATION:
        % subplot(2, 1, 1): Iteration 1
        % subplot(2, 1, 2): Current / Final Iteration
        % -----------------------------------------------------------------
        if ishandle(h_fig)
            figure(h_fig);
            x_fit_dense = linspace(min(x_fit), max(x_fit), 400);
            
            % Subplot 1: Draw Iteration 1 (drawn on iteration 1 and frozen)
            if em_iter == 1
                subplot(2, 1, 1);
                cla;
                hold on;
                % Full spectrum (light points)
                plot(x_val, y_val, '.-', 'Color', [0.75, 0.78, 0.85], 'LineWidth', 1.0, ...
                     'MarkerSize', 8, 'DisplayName', 'Exp Spectrum (Full)');
                % Highlighted fitting area points (within fit_window)
                plot(x_fit, y_fit, 'b.-', 'LineWidth', 1.3, 'MarkerSize', 11, ...
                     'DisplayName', sprintf('Fitting Area (\\pm%d pts)', fit_window));
                
                % Individual components and total fit on dense x_fit range
                S_dense_tot = zeros(size(x_fit_dense));
                for k = 1:num_peaks
                    S_k_dense = eval_single_peak(peaks_curr(k,1), peaks_curr(k,2), peaks_curr(k,3), peaks_curr(k,4), x_fit_dense);
                    S_dense_tot = S_dense_tot + S_k_dense;
                    c_col = comp_colors(mod(k - 1, size(comp_colors, 1)) + 1, :);
                    plot(x_fit_dense, cur_y0 + S_k_dense, '--', 'Color', c_col, 'LineWidth', 1.5, ...
                         'DisplayName', sprintf('Peak %d (x_0=%.1f, A=%.1f)', k, peaks_curr(k,2), peaks_curr(k,1)));
                end
                plot(x_fit_dense, cur_y0 + S_dense_tot, 'r-', 'LineWidth', 2.0, 'DisplayName', 'Total Voigt Fit');
                plot([min(x_fit), max(x_fit)], [cur_y0, cur_y0], 'g:', 'LineWidth', 1.2, ...
                     'DisplayName', sprintf('Baseline y_0=%.3f', cur_y0));
                
                yl = [max(0, min(y_fit) - 0.5), max(max(y_fit) * 1.08, max(cur_y0 + S_dense_tot) * 1.05)];
                for k = 1:num_peaks
                    plot([peaks_curr(k,2), peaks_curr(k,2)], yl, 'k:', 'LineWidth', 1.0, 'HandleVisibility', 'off');
                end
                plot([min(x_fit), min(x_fit)], yl, 'k--', 'LineWidth', 1.0, ...
                     'DisplayName', sprintf('Fit Bounds (\\pm%d)', fit_window));
                plot([max(x_fit), max(x_fit)], yl, 'k--', 'LineWidth', 1.0, 'HandleVisibility', 'off');
                
                ylim(yl);
                xlim([max(min(x), min(x_fit) - 6), min(max(x), max(x_fit) + 6)]);
                grid on;
                ylabel('Intensity (1/Z\_A)', 'FontSize', 10, 'FontWeight', 'bold');
                title(sprintf('Profile %d (1/Z): Iteration 1 | %d Peak(s) | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | R^2 = %.4f', ...
                              row_num, num_peaks, min(x_fit), max(x_fit), fit_window, rmse_curr, r2_curr), ...
                      'FontSize', 11, 'FontWeight', 'bold');
                legend('Location', 'best', 'FontSize', 8);
            end
            
            % Subplot 2: Shows fit on yyaxis left and fitting residues on yyaxis right
            ax2 = subplot(2, 1, 2);
            cla(ax2, 'reset');
            
            % Left axis: Spectrum and Fitted Voigt curves
            yyaxis left
            hold on;
            plot(x_val, y_val, '.-', 'Color', [0.75, 0.78, 0.85], 'LineWidth', 1.0, ...
                 'MarkerSize', 8, 'DisplayName', 'Exp Full');
            plot(x_fit, y_fit, 'b.-', 'LineWidth', 1.3, 'MarkerSize', 11, ...
                 'DisplayName', sprintf('Fit Area (\\pm%d pts)', fit_window));
            
            S_dense_tot = zeros(size(x_fit_dense));
            for k = 1:num_peaks
                S_k_dense = eval_single_peak(peaks_curr(k,1), peaks_curr(k,2), peaks_curr(k,3), peaks_curr(k,4), x_fit_dense);
                S_dense_tot = S_dense_tot + S_k_dense;
                c_col = comp_colors(mod(k - 1, size(comp_colors, 1)) + 1, :);
                plot(x_fit_dense, cur_y0 + S_k_dense, '--', 'Color', c_col, 'LineWidth', 1.5, ...
                     'DisplayName', sprintf('Peak %d (x_0=%.2f, A=%.1f)', k, peaks_curr(k,2), peaks_curr(k,1)));
            end
            plot(x_fit_dense, cur_y0 + S_dense_tot, 'r-', 'LineWidth', 2.0, 'DisplayName', 'Total Fit');
            plot([min(x_fit), max(x_fit)], [cur_y0, cur_y0], 'g:', 'LineWidth', 1.2, ...
                 'DisplayName', sprintf('Baseline y_0=%.3f', cur_y0));
            
            yl_left = [max(0, min(y_fit) - 0.5), max(max(y_fit) * 1.08, max(cur_y0 + S_dense_tot) * 1.05)];
            for k = 1:num_peaks
                plot([peaks_curr(k,2), peaks_curr(k,2)], yl_left, 'k:', 'LineWidth', 1.0, 'HandleVisibility', 'off');
            end
            plot([min(x_fit), min(x_fit)], yl_left, 'k--', 'LineWidth', 1.0, ...
                 'DisplayName', sprintf('Fit Bounds (\\pm%d)', fit_window));
            plot([max(x_fit), max(x_fit)], yl_left, 'k--', 'LineWidth', 1.0, 'HandleVisibility', 'off');
            ylim(yl_left);
            ylabel('Intensity (1/Z\_A)', 'FontSize', 10, 'FontWeight', 'bold');
            grid on;
            
            % Right axis: Fitting Residues
            yyaxis right
            hold on;
            stem(x_fit, res_curr, 'Marker', 'o', 'MarkerSize', 4, 'LineWidth', 1.2, ...
                 'Color', [0.75, 0.05, 0.45], 'DisplayName', 'Residues (Exp - Fit)');
            plot([min(x_fit), max(x_fit)], [0, 0], 'k--', 'LineWidth', 1.0, 'HandleVisibility', 'off');
            ylabel('Residues (Exp - Fit)', 'Color', [0.75, 0.05, 0.45], 'FontSize', 10, 'FontWeight', 'bold');
            ax = gca;
            ax.YColor = [0.75, 0.05, 0.45];
            max_r = max(abs(res_curr));
            ylim([-max(2.5 * max_r, 0.2), max(2.5 * max_r, 0.2)]);
            
            xlim([max(min(x), min(x_fit) - 6), min(max(x), max(x_fit) + 6)]);
            xlabel('Offset / Plane Column', 'FontSize', 10, 'FontWeight', 'bold');
            if num_peaks == 1
                title(sprintf('Profile %d (1/Z): Fit & Residues (1 Round) | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                              row_num, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                      'FontSize', 11, 'FontWeight', 'bold');
            else
                title(sprintf('Profile %d (1/Z): Iteration %d & Residues | %d Peaks | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                              row_num, em_iter, num_peaks, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                      'FontSize', 11, 'FontWeight', 'bold');
            end
            legend('Location', 'best', 'FontSize', 8);
            
            drawnow;
            if pause_iter > 0 && pause_time >= 0
                pause(pause_iter);
            end
        end
        
        % Check convergence
        if abs(prev_rmse - rmse_curr) < conv_tol
            fprintf('  -> EM converged at iteration %d (delta RMSE < %.1e)\n', em_iter, conv_tol);
            break;
        end
        prev_rmse = rmse_curr;
        
        % If there is only one peak: no iterations needed, 1 round is good enough
        if num_peaks == 1
            fprintf('  -> Single peak detected: 1 round complete, skipping iterations.\n');
            break;
        end
        
        % M-STEP: Maximize each component independently on decoupled data within fit_window
        D_exp = y_fit - cur_y0; % Positive height above baseline in 1/Z
        for k = 1:num_peaks
            mask_k = abs(x_fit - peaks_curr(k, 2)) <= fit_window;
            y_k_target = D_exp - (S_tot - S_comp(k, :));
            
            p0_k = peaks_curr(k, :);
            lb_k = [0, p0_k(2) - 3.5, min_fwhm / 5, 0];
            ub_k = [max(y_fit) * 1.5, p0_k(2) + 3.5, max_fwhm / 2.355, max_fwhm / 2.0];
            A_ineq_k = [0, 0,  2.355,  2.0; ...
                        0, 0, -2.355, -2.0];
            b_ineq_k = [max_fwhm; -min_fwhm];
            
            obj_k = @(p) mean((y_k_target(mask_k) - eval_single_peak(p(1), p(2), p(3), p(4), x_fit(mask_k))).^2);
            try
                if has_fmincon
                    p_opt_k = fmincon(obj_k, p0_k, A_ineq_k, b_ineq_k, [], [], lb_k, ub_k, [], fmin_opts);
                else
                    barrier_k = @(p) obj_k(p) + ...
                        1e4 * (p(1) < lb_k(1) || p(1) > ub_k(1)) + ...
                        1e4 * (p(2) < lb_k(2) || p(2) > ub_k(2)) + ...
                        1e4 * (p(3) < lb_k(3) || p(3) > ub_k(3)) + ...
                        1e4 * (p(4) < lb_k(4) || p(4) > ub_k(4)) + ...
                        1e4 * max(0,  2.355*p(3) + 2.0*p(4) - max_fwhm)^2 + ...
                        1e4 * max(0, -2.355*p(3) - 2.0*p(4) + min_fwhm)^2;
                    p_opt_k = fminsearch(barrier_k, p0_k, fmin_opts);
                end
                peaks_curr(k, :) = p_opt_k;
            catch ME
                % Retain current values if sub-optimization fails
            end
        end
        
        % Update baseline y0 using wing points of the fitting area
        S_tot_recalc = zeros(1, N_fit);
        for k = 1:num_peaks
            S_tot_recalc = S_tot_recalc + eval_single_peak(peaks_curr(k,1), peaks_curr(k,2), peaks_curr(k,3), peaks_curr(k,4), x_fit);
        end
        wing_mask = S_tot_recalc < 0.10 * max(S_tot_recalc);
        if sum(wing_mask) >= 3
            cur_y0 = median(y_fit(wing_mask) - S_tot_recalc(wing_mask));
        else
            cur_y0 = median(y_fit - S_tot_recalc);
        end
        cur_y0 = max(0.5, min(3.0, cur_y0));
    end
    
    % Update final subplot title to clearly state "Final Iteration & Residues"
    if ishandle(h_fig)
        subplot(2, 1, 2);
        if num_peaks == 1
            title(sprintf('Profile %d (1/Z): Fit & Fitting Residues (1 Round) | Area: [%d..%d] (\\pm%d pts) | Final RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                          row_num, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                  'FontSize', 11, 'FontWeight', 'bold');
        else
            title(sprintf('Profile %d (1/Z): Final Iteration (Iter %d) & Fitting Residues | %d Peaks | Area: [%d..%d] (\\pm%d pts) | Final RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                          row_num, em_iter, num_peaks, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                  'FontSize', 11, 'FontWeight', 'bold');
        end
        drawnow;
    end
    
    % Store results
    fit_results3(fig_idx).row              = row_num;
    fit_results3(fig_idx).fig_num          = fig_num;
    fit_results3(fig_idx).y0               = cur_y0;
    fit_results3(fig_idx).num_peaks        = num_peaks;
    fit_results3(fig_idx).fit_window_range = [min(x_fit), max(x_fit)];
    fit_results3(fig_idx).peaks            = peaks_curr;
    fit_results3(fig_idx).rmse_init        = em_history(1).rmse;
    fit_results3(fig_idx).rmse_final       = rmse_curr;
    fit_results3(fig_idx).max_abs_err      = max_abs_err_curr;
    fit_results3(fig_idx).r2_final         = r2_curr;
    fit_results3(fig_idx).em_iterations    = em_iter;
    
    fprintf('Finished Profile %d (1/Z, Figure %d): Final RMSE = %.4f, Max |Err| = %.4f, R^2 = %.4f after %d iterations.\n', ...
        row_num, fig_num, rmse_curr, max_abs_err_curr, r2_curr, em_iter);
    
    if pause_time == 0 && fig_idx < num_targets
        fprintf('Press [Enter] or any key to proceed to Figure %d (Profile %d)... ', ...
            fig_idx + 1, target_rows(fig_idx + 1));
        pause;
        fprintf('\n');
    elseif pause_time > 0
        pause(pause_time);
    end
end

% -------------------------------------------------------------------------
% 6. Display Summary Table & Save Outputs
% -------------------------------------------------------------------------
fprintf('\n========================================================================================\n');
fprintf('                           SUMMARY OF 1/Z EM FIT RESULTS                                \n');
fprintf('========================================================================================\n');
fprintf('Fig  Row  Peaks   y0     Fit Window   Init RMSE  Final RMSE  Max |Err|  Final R^2  Iter  Peak Centers\n');
fprintf('----------------------------------------------------------------------------------------\n');
for i = 1:num_targets
    r = fit_results3(i).row;
    if fit_results3(i).num_peaks > 0
        p_centers = fit_results3(i).peaks(:, 2)';
        w_range = sprintf('[%d..%d]', fit_results3(i).fit_window_range(1), fit_results3(i).fit_window_range(2));
        fprintf(' %d   %2d     %d    %.3f   %-10s    %.4f      %.4f     %.4f    %.4f      %2d    %s\n', ...
            fit_results3(i).fig_num, r, fit_results3(i).num_peaks, fit_results3(i).y0, ...
            w_range, fit_results3(i).rmse_init, fit_results3(i).rmse_final, fit_results3(i).max_abs_err, ...
            fit_results3(i).r2_final, fit_results3(i).em_iterations, mat2str(round(p_centers, 2)));
    end
end
fprintf('========================================================================================\n');

% Save output mat file
script_dir = fileparts(mfilename('fullpath'));
if isempty(script_dir)
    script_dir = pwd;
end
out_mat = fullfile(script_dir, 'cest_fit_results_inv_z_em.mat');
try
    save(out_mat, 'fit_results3', 'target_rows', 'Z_data', 'x', 'fit_window', 'z_min_floor');
    fprintf('Results saved to: %s\n', out_mat);
catch ME
    warning('Could not save %s: %s', out_mat, ME.message);
end

% -------------------------------------------------------------------------
% HELPER FUNCTION: find_extrema_with_noise
% Identifies local maxima above min_height with prominence >= min_prom,
% taking into account noise fluctuations and physical peak separation.
% -------------------------------------------------------------------------
function [locs, pks] = find_extrema_with_noise(signal, x_coords, min_height, min_prom, min_dist)
    locs = [];
    pks  = [];
    
    if length(signal) < 3
        return;
    end
    
    if ~isempty(min_height) && ~isnan(min_height) && max(signal) < min_height
        return;
    end
    
    has_findpeaks = (exist('findpeaks', 'file') == 2);
    if has_findpeaks
        try
            opts = {};
            if ~isempty(min_height) && ~isnan(min_height)
                opts = [opts, {'MinPeakHeight', min_height}];
            end
            if ~isempty(min_prom) && ~isnan(min_prom)
                opts = [opts, {'MinPeakProminence', min_prom}];
            end
            if ~isempty(min_dist) && ~isnan(min_dist) && min_dist > 0
                opts = [opts, {'MinPeakDistance', min_dist}];
            end
            
            [pks_raw, locs_raw] = findpeaks(signal, x_coords, opts{:});
            locs = locs_raw(:)';
            pks  = pks_raw(:)';
            return;
        catch
            % Fall back to manual local maxima detection if findpeaks fails
        end
    end
    
    % Fallback: Manual discrete peak picker with prominence checking
    N = length(signal);
    for idx = 2:(N - 1)
        if signal(idx) > signal(idx - 1) && signal(idx) >= signal(idx + 1)
            val = signal(idx);
            if ~isempty(min_height) && val < min_height
                continue;
            end
            
            % Compute local prominence
            left_min = min(signal(1:idx));
            right_min = min(signal(idx:end));
            prom = val - max(left_min, right_min);
            if ~isempty(min_prom) && prom < min_prom
                continue;
            end
            
            x_pos = x_coords(idx);
            if ~isempty(min_dist) && ~isempty(locs)
                dist_to_existing = abs(locs - x_pos);
                if any(dist_to_existing < min_dist)
                    [min_d, close_idx] = min(dist_to_existing);
                    if min_d < min_dist && val > pks(close_idx)
                        locs(close_idx) = x_pos;
                        pks(close_idx)  = val;
                    end
                    continue;
                end
            end
            
            locs(end + 1) = x_pos; %#ok<AGROW>
            pks(end + 1)  = val;   %#ok<AGROW>
        end
    end
end
