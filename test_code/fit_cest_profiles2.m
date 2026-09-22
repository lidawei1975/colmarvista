% FIT_CEST_PROFILES2
% Fits CEST profiles using a 4-step multi-peak Voigt algorithm with
% Expectation-Maximization (EM) optimization and per-iteration visualization.
%
% Algorithm:
%   Step 1: Negative peak picking on raw profile above 5x noise level,
%           considering noise fluctuations (prominence and line-width separation).
%   Step 2: Single-peak Voigt fitting without additional cost (pure least-squares MSE),
%           limited to within fit_window (10 points) of primary peak center.
%   Step 3: Peak picking on residues within the fitting area to detect
%           unmodeled secondary dips (doublets/shoulders).
%   Step 4: Fit all detected peaks using Expectation-Maximization (EM)
%           limited strictly to within fit_window (10 points) of peak centers,
%           plotting fitted vs. input spectra at each iteration.
%
% Display:
%   Focuses on target profiles [51, 52, 53, 56, 61, 66] across figure(1) to figure(6).
%   - subplot(2, 1, 1): Shows Iteration 1 (initial EM step)
%   - subplot(2, 1, 2): Shows Final Iteration (converged EM step)

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
% fit_window: maximum distance in points from peak center(s) included in fitting (default: 10)
if ~exist('fit_window', 'var') || isempty(fit_window)
    fit_window = 20;
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
    max_em_iter =60;
end
if ~exist('conv_tol', 'var') || isempty(conv_tol)
    conv_tol = 1e-5;
end

% Physical width bounds: CEST FWHM typically in [1.6, 4.5]
if ~exist('max_fwhm', 'var') || isempty(max_fwhm)
    max_fwhm = 6.5;
end
if ~exist('min_fwhm', 'var') || isempty(min_fwhm)
    min_fwhm = 1.0;
end

% Asymmetric error factor:
% Multiplies error when fit is lower than data (dip too deep) by asym_factor (default: 2.0)
% to encourage the fitting to stay higher (less strong) than experimental negative peaks.
if ~exist('asym_factor', 'var') || isempty(asym_factor)
    asym_factor = 2.0;
end
fprintf('Asymmetric error factor: %.2f (encouraging fit to be higher / less strong than negative peaks)\n', asym_factor);

% -------------------------------------------------------------------------
% 4. Verify Voigt Function
% -------------------------------------------------------------------------
if ~exist('voigt', 'file') && ~exist('voigt', 'builtin')
    error('voigt function not found in MATLAB path. Please ensure voigt(x, sigma, gamma) is available.');
end

% Model evaluation helpers:
% Evaluates single normalized Voigt peak profile (peak height = A at center x0)
eval_single_peak = @(A, x0, sig, gam, xi) ...
    A * (reshape(voigt(xi - x0, max(sig, 1e-4), max(gam, 0)), size(xi)) ./ ...
         max(voigt(0, max(sig, 1e-4), max(gam, 0)), 1e-12));

% Evaluates baseline y0 minus single Voigt dip
eval_voigt_dip = @(p, xi) ...
    p(1) - eval_single_peak(p(2), p(3), p(4), p(5), xi);

% Olivero & Longbothum 1977 Voigt FWHM formula
calc_fwhm_voigt = @(sig, gam) ...
    0.5346 * (2 * gam) + sqrt(0.2166 * (2 * gam)^2 + (2 * sqrt(2 * log(2)) * sig)^2);

% Asymmetric error helpers:
% For intensity error r = y_exp - y_fit:
% r > 0 means y_exp > y_fit (fit is lower than data / dip too deep) -> multiply error by asym_factor
calc_asym_err = @(r, factor) r .* (1.0 + (factor - 1.0) * (r > 0));

% For dip error r_dip = y_target_dip - S_model_dip:
% r_dip < 0 means S_model_dip > y_target_dip (model dip is deeper than target) -> multiply error by asym_factor
calc_asym_dip_err = @(r_dip, factor) r_dip .* (1.0 + (factor - 1.0) * (r_dip < 0));

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
% 5. Main Processing Loop for Target Profiles
% -------------------------------------------------------------------------
fit_results2 = repmat(struct('row', 0, ...
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
    
    y_raw = Z_data(row_num, :);
    valid = ~isnan(y_raw) & ~isinf(y_raw);
    x_val = x(valid);
    y_val = y_raw(valid);
    N_pts = length(y_val);
    
    if N_pts < 6
        fprintf('Row %d: Not enough valid data points. Skipping.\n', row_num);
        continue;
    end
    
    fprintf('\n========================================================================\n');
    fprintf('Processing Profile %d (Figure %d / %d)\n', row_num, fig_num, num_targets);
    fprintf('========================================================================\n');
    
    % ---------------------------------------------------------------------
    % STEP 1: Negative Peak Picking on Raw Profile (> 5x noise level)
    % ---------------------------------------------------------------------
    y_sorted = sort(y_val);
    y0_est = median(y_sorted(ceil(N_pts * 0.4):end));
    
    [min_val, min_idx] = min(y_val);
    initial_dip_depth = max(0, y0_est - min_val);
    
    baseline_pts = y_val(y_val >= y0_est - 0.25 * initial_dip_depth);
    if length(baseline_pts) >= 4
        noise_base = std(baseline_pts);
    else
        noise_base = std(y_val);
    end
    diff_y = diff(y_val);
    noise_diff = median(abs(diff_y - median(diff_y))) / (0.6745 * sqrt(2));
    noise_est = max([noise_base, noise_diff, 1e-4]);
    
    thresh_5x = 4.0 * noise_est;
    fprintf('Step 1: Noise estimate = %.4f | 5x Noise Threshold = %.4f | Baseline est = %.3f\n', ...
        noise_est, thresh_5x, y0_est);
    
    dip_raw = y0_est - y_val;
    [raw_locs, raw_pks] = find_extrema_with_noise(dip_raw, x_val, thresh_5x, 1.5 * noise_est, 3);
    
    if isempty(raw_locs)
        if initial_dip_depth >= 3 * noise_est
            raw_locs = x_val(min_idx);
            raw_pks  = initial_dip_depth;
        else
            fprintf('Row %d: No negative peak detected above noise threshold.\n', row_num);
            continue;
        end
    end
    
    [~, sort_idx] = sort(raw_pks, 'descend');
    primary_x0 = raw_locs(sort_idx(1));
    primary_amp = raw_pks(sort_idx(1));
    fprintf('Step 1: Picked primary negative peak at x0 = %.2f (depth = %.3f, %.1f x noise)\n', ...
        primary_x0, primary_amp, primary_amp / noise_est);
    
    % ---------------------------------------------------------------------
    % STEP 2: Voigt Fitting Without Additional Cost (Limited to fit_window)
    % ---------------------------------------------------------------------
    % Restrict data to within fit_window (10 points) of primary peak center
    mask_step2 = abs(x_val - primary_x0) <= fit_window;
    x_val_step2 = x_val(mask_step2);
    y_val_step2 = y_val(mask_step2);
    
    init_fwhm = 2.4;
    sigma_est = (0.5 * init_fwhm) / 2.355;
    gamma_est = (0.5 * init_fwhm) / 2.0;
    p0 = [y0_est, primary_amp, primary_x0, sigma_est, gamma_est];
    
    lb = [min(y_val_step2) - 0.1, 0, min(x_val_step2), min_fwhm / 5, 0];
    ub = [max(y_val_step2) + 0.1, y0_est - min(y_val_step2) + 0.1, max(x_val_step2), max_fwhm / 2.355, max_fwhm / 2.0];
    
    A_ineq = [0, 0, 0,  2.355,  2.0; ...
              0, 0, 0, -2.355, -2.0];
    b_ineq = [max_fwhm; -min_fwhm];
    
    % Asymmetric MSE over points within fit_window of peak center:
    % Encourages fit to be higher (less strong dip) than experimental negative peaks
    obj_fun_step2 = @(p) mean((calc_asym_err(y_val_step2 - eval_voigt_dip(p, x_val_step2), asym_factor)).^2);
    
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
    fprintf('Step 2: Single Voigt fit (window [%d..%d]): y0 = %.3f, A = %.3f, x0 = %.2f, FWHM = %.2f\n', ...
        min(x_val_step2), max(x_val_step2), p_step2(1), p_step2(2), p_step2(3), fwhm_step2);
    
    % ---------------------------------------------------------------------
    % STEP 3: Peak Picking on Residues within Fitting Area
    % ---------------------------------------------------------------------
    residuals_step2 = y_val_step2 - eval_voigt_dip(p_step2, x_val_step2);
    dip_res = -residuals_step2;
    
    res_noise = std(residuals_step2(abs(residuals_step2) < 3.0 * noise_est));
    if isnan(res_noise) || res_noise < 1e-4
        res_noise = noise_est;
    end
    res_thresh = max(4.0 * res_noise, 4.0 * noise_est);
    
    [res_locs, res_pks] = find_extrema_with_noise(dip_res, x_val_step2, res_thresh, 1.5 * res_noise, 2.5);
    
    if ~isempty(res_locs)
        keep = abs(res_locs - p_step2(3)) >= 2.0; % separation >= 2 points
        res_locs = res_locs(keep);
        res_pks  = res_pks(keep);
    end
    
    % Also check if Step 1 detected additional peaks within fit_window
    extra_step1_locs = [];
    extra_step1_pks  = [];
    for k = 1:length(raw_locs)
        if abs(raw_locs(k) - p_step2(3)) <= fit_window && abs(raw_locs(k) - p_step2(3)) >= 2.5 && ...
           (isempty(res_locs) || all(abs(raw_locs(k) - res_locs) >= 2.0))
            extra_step1_locs(end + 1) = raw_locs(k); %#ok<AGROW>
            extra_step1_pks(end + 1)  = raw_pks(k);  %#ok<AGROW>
        end
    end
    
    all_extra_locs = [res_locs, extra_step1_locs];
    all_extra_pks  = [res_pks,  extra_step1_pks];
    
    if ~isempty(all_extra_locs)
        fprintf('Step 3: Detected %d secondary peak(s) in residues: locs = %s, depths = %s\n', ...
            length(all_extra_locs), mat2str(round(all_extra_locs, 2)), mat2str(round(all_extra_pks, 3)));
    else
        fprintf('Step 3: No secondary peaks found in residues. Single peak model confirmed.\n');
    end
    
    all_locs = [p_step2(3), all_extra_locs];
    all_amps = [p_step2(2), all_extra_pks];
    num_peaks = length(all_locs);
    
    peaks_init = zeros(num_peaks, 4);
    for k = 1:num_peaks
        if k == 1
            peaks_init(1, :) = [p_step2(2), p_step2(3), max(p_step2(4), 0.3), max(p_step2(5), 0.1)];
        else
            peaks_init(k, :) = [all_amps(k), all_locs(k), 0.7, 0.5];
        end
    end
    
    % ---------------------------------------------------------------------
    % STEP 4: Multi-Peak EM Optimization (Within 10 Points of Peak Centers)
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
    set(h_fig, 'Name', sprintf('Profile %d: ', row_num), ...
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
        
        % E-STEP: Calculate individual component dips and total dip on fitting area
        S_comp = zeros(num_peaks, N_fit);
        for k = 1:num_peaks
            S_comp(k, :) = eval_single_peak(peaks_curr(k,1), peaks_curr(k,2), peaks_curr(k,3), peaks_curr(k,4), x_fit);
        end
        S_tot = sum(S_comp, 1);
        y_fit_curr = cur_y0 - S_tot;
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
        
        fprintf('  [EM Iter %2d] RMSE = %.5f | Max |Err| = %.5f | R^2 = %.4f | y0 = %.3f | Fit range: [%d..%d] (%d pts)\n', ...
            em_iter, rmse_curr, max_abs_err_curr, r2_curr, cur_y0, min(x_fit), max(x_fit), N_fit);
        for k = 1:num_peaks
            fwhm_k = calc_fwhm_voigt(peaks_curr(k,3), peaks_curr(k,4));
            fprintf('    -> Peak %d: Center = %5.2f, Amp = %5.3f, Sigma = %4.2f, Gamma = %4.2f, FWHM = %4.2f\n', ...
                k, peaks_curr(k,2), peaks_curr(k,1), peaks_curr(k,3), peaks_curr(k,4), fwhm_k);
        end
        
        % -----------------------------------------------------------------
        % LIVE PLOTTING AT THIS ITERATION:
        % subplot(2, 1, 1): Iteration 1
        % subplot(2, 1, 2): Current / Final Iteration
        % -----------------------------------------------------------------
        if ishandle(h_fig)
            figure(h_fig);
            x_fit_dense = linspace(min(x_fit), max(x_fit), 350);
            
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
                    plot(x_fit_dense, cur_y0 - S_k_dense, '--', 'Color', c_col, 'LineWidth', 1.5, ...
                         'DisplayName', sprintf('Peak %d (x_0=%.1f, A=%.2f)', k, peaks_curr(k,2), peaks_curr(k,1)));
                end
                plot(x_fit_dense, cur_y0 - S_dense_tot, 'r-', 'LineWidth', 2.0, 'DisplayName', 'Total Voigt Fit');
                plot([min(x_fit), max(x_fit)], [cur_y0, cur_y0], 'g:', 'LineWidth', 1.2, ...
                     'DisplayName', sprintf('Baseline y_0=%.3f', cur_y0));
                
                yl = [min(min(y_fit) - 0.08, min(cur_y0 - S_dense_tot) - 0.05), max(max(y_fit) + 0.08, cur_y0 + 0.05)];
                for k = 1:num_peaks
                    plot([peaks_curr(k,2), peaks_curr(k,2)], yl, 'k:', 'LineWidth', 1.0, 'HandleVisibility', 'off');
                end
                plot([min(x_fit), min(x_fit)], yl, 'k--', 'LineWidth', 1.0, ...
                     'DisplayName', sprintf('Fit Bounds (\\pm%d)', fit_window));
                plot([max(x_fit), max(x_fit)], yl, 'k--', 'LineWidth', 1.0, 'HandleVisibility', 'off');
                
                ylim(yl);
                xlim([max(min(x), min(x_fit) - 6), min(max(x), max(x_fit) + 6)]);
                grid on;
                ylabel('Intensity (Z\_A)', 'FontSize', 10, 'FontWeight', 'bold');
                title(sprintf('Profile %d: Iteration 1 | %d Peak(s) | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | R^2 = %.4f', ...
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
                plot(x_fit_dense, cur_y0 - S_k_dense, '--', 'Color', c_col, 'LineWidth', 1.5, ...
                     'DisplayName', sprintf('Peak %d (x_0=%.2f, A=%.3f)', k, peaks_curr(k,2), peaks_curr(k,1)));
            end
            plot(x_fit_dense, cur_y0 - S_dense_tot, 'r-', 'LineWidth', 2.0, 'DisplayName', 'Total Fit');
            plot([min(x_fit), max(x_fit)], [cur_y0, cur_y0], 'g:', 'LineWidth', 1.2, ...
                 'DisplayName', sprintf('Baseline y_0=%.3f', cur_y0));
            
            yl_left = [min(min(y_fit) - 0.08, min(cur_y0 - S_dense_tot) - 0.05), max(max(y_fit) + 0.08, cur_y0 + 0.05)];
            for k = 1:num_peaks
                plot([peaks_curr(k,2), peaks_curr(k,2)], yl_left, 'k:', 'LineWidth', 1.0, 'HandleVisibility', 'off');
            end
            plot([min(x_fit), min(x_fit)], yl_left, 'k--', 'LineWidth', 1.0, ...
                 'DisplayName', sprintf('Fit Bounds (\\pm%d)', fit_window));
            plot([max(x_fit), max(x_fit)], yl_left, 'k--', 'LineWidth', 1.0, 'HandleVisibility', 'off');
            ylim(yl_left);
            ylabel('Intensity (Z\_A)', 'FontSize', 10, 'FontWeight', 'bold');
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
            ylim([-max(2.5 * max_r, 0.04), max(2.5 * max_r, 0.04)]);
            
            xlim([max(min(x), min(x_fit) - 6), min(max(x), max(x_fit) + 6)]);
            xlabel('Offset / Plane Column', 'FontSize', 10, 'FontWeight', 'bold');
            if num_peaks == 1
                title(sprintf('Profile %d: Fit & Residues (1 Round) | Asym = %.1f | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                              row_num, asym_factor, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                      'FontSize', 11, 'FontWeight', 'bold');
            else
                title(sprintf('Profile %d: Iteration %d & Residues | %d Peaks | Asym = %.1f | Area: [%d..%d] (\\pm%d pts) | RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                              row_num, em_iter, num_peaks, asym_factor, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
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
        D_exp = cur_y0 - y_fit;
        for k = 1:num_peaks
            mask_k = abs(x_fit - peaks_curr(k, 2)) <= fit_window;
            y_k_target = D_exp - (S_tot - S_comp(k, :));
            
            p0_k = peaks_curr(k, :);
            lb_k = [0, p0_k(2) - 3.5, min_fwhm / 5, 0];
            ub_k = [max(D_exp) + 0.15, p0_k(2) + 3.5, max_fwhm / 2.355, max_fwhm / 2.0];
            A_ineq_k = [0, 0,  2.355,  2.0; ...
                        0, 0, -2.355, -2.0];
            b_ineq_k = [max_fwhm; -min_fwhm];
            
            % Asymmetric MSE: penalizes component dip deeper than target by asym_factor
            obj_k = @(p) mean((calc_asym_dip_err(y_k_target(mask_k) - eval_single_peak(p(1), p(2), p(3), p(4), x_fit(mask_k)), asym_factor)).^2);
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
        wing_mask = S_tot_recalc < 0.15 * max(S_tot_recalc);
        if sum(wing_mask) >= 3
            cur_y0 = median(y_fit(wing_mask) + S_tot_recalc(wing_mask));
        else
            cur_y0 = median(y_fit + S_tot_recalc);
        end
    end
    
    % Update final subplot title to clearly state "Final Iteration & Residues"
    if ishandle(h_fig)
        subplot(2, 1, 2);
        if num_peaks == 1
            title(sprintf('Profile %d: Fit & Fitting Residues (1 Round) | Asym = %.1f | Area: [%d..%d] (\\pm%d pts) | Final RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                          row_num, asym_factor, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                  'FontSize', 11, 'FontWeight', 'bold');
        else
            title(sprintf('Profile %d: Final Iteration (Iter %d) & Fitting Residues | %d Peaks | Asym = %.1f | Area: [%d..%d] (\\pm%d pts) | Final RMSE = %.4f | Max |Err| = %.4f | R^2 = %.4f', ...
                          row_num, em_iter, num_peaks, asym_factor, min(x_fit), max(x_fit), fit_window, rmse_curr, max_abs_err_curr, r2_curr), ...
                  'FontSize', 11, 'FontWeight', 'bold');
        end
        drawnow;
    end
    
    % Store results
    fit_results2(fig_idx).row              = row_num;
    fit_results2(fig_idx).fig_num          = fig_num;
    fit_results2(fig_idx).y0               = cur_y0;
    fit_results2(fig_idx).num_peaks        = num_peaks;
    fit_results2(fig_idx).fit_window_range = [min(x_fit), max(x_fit)];
    fit_results2(fig_idx).peaks            = peaks_curr;
    fit_results2(fig_idx).asym_factor      = asym_factor;
    fit_results2(fig_idx).rmse_init        = em_history(1).rmse;
    fit_results2(fig_idx).rmse_final       = rmse_curr;
    fit_results2(fig_idx).max_abs_err      = max_abs_err_curr;
    fit_results2(fig_idx).r2_final         = r2_curr;
    fit_results2(fig_idx).em_iterations    = em_iter;
    
    fprintf('Finished Profile %d (Figure %d): Final RMSE = %.4f, Max |Err| = %.4f, R^2 = %.4f after %d iterations (Asym = %.1f).\n', ...
        row_num, fig_num, rmse_curr, max_abs_err_curr, r2_curr, em_iter, asym_factor);
    
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
fprintf('                               SUMMARY OF EM FIT RESULTS                                \n');
fprintf('========================================================================================\n');
fprintf('Fig  Row  Peaks   y0     Fit Window   Init RMSE  Final RMSE  Max |Err|  Final R^2  Iter  Peak Centers\n');
fprintf('----------------------------------------------------------------------------------------\n');
for i = 1:num_targets
    r = fit_results2(i).row;
    if fit_results2(i).num_peaks > 0
        p_centers = fit_results2(i).peaks(:, 2)';
        w_range = sprintf('[%d..%d]', fit_results2(i).fit_window_range(1), fit_results2(i).fit_window_range(2));
        fprintf(' %d   %2d     %d    %.3f   %-10s    %.4f      %.4f     %.4f    %.4f      %2d    %s\n', ...
            fit_results2(i).fig_num, r, fit_results2(i).num_peaks, fit_results2(i).y0, ...
            w_range, fit_results2(i).rmse_init, fit_results2(i).rmse_final, fit_results2(i).max_abs_err, ...
            fit_results2(i).r2_final, fit_results2(i).em_iterations, mat2str(round(p_centers, 2)));
    end
end
fprintf('========================================================================================\n');

% Save output mat file
script_dir = fileparts(mfilename('fullpath'));
if isempty(script_dir)
    script_dir = pwd;
end
out_mat = fullfile(script_dir, 'cest_fit_results_em.mat');
try
    save(out_mat, 'fit_results2', 'target_rows', 'Z_data', 'x', 'fit_window');
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
    
    % If findpeaks is available, leverage it
    if exist('findpeaks', 'file') == 2
        try
            [found_pks, found_locs_idx] = findpeaks(signal, ...
                'MinPeakHeight', min_height, ...
                'MinPeakProminence', min_prom, ...
                'MinPeakDistance', min_dist);
            if ~isempty(found_locs_idx)
                locs = x_coords(found_locs_idx);
                pks  = found_pks;
                return;
            end
        catch
            % Fall back to built-in routine below
        end
    end
    
    % Built-in noise-aware local extrema finder (no toolbox dependency)
    N = length(signal);
    % Light 3-point smoothing filter ([0.25, 0.5, 0.25]) to evaluate candidates
    sm_signal = signal;
    for i = 2:N-1
        sm_signal(i) = 0.25 * signal(i-1) + 0.5 * signal(i) + 0.25 * signal(i+1);
    end
    
    cand_idx = [];
    for i = 2:N-1
        if sm_signal(i) > sm_signal(i-1) && sm_signal(i) >= sm_signal(i+1) && signal(i) >= min_height
            cand_idx(end + 1) = i; %#ok<AGROW>
        end
    end
    
    if isempty(cand_idx)
        return;
    end
    
    % Evaluate prominence relative to surrounding valleys
    valid_idx = [];
    for k = 1:length(cand_idx)
        idx = cand_idx(k);
        % Left valley
        v_left = min(signal(max(1, idx - 8):idx));
        % Right valley
        v_right = min(signal(idx:min(N, idx + 8)));
        prom = signal(idx) - max(v_left, v_right);
        if prom >= min_prom
            valid_idx(end + 1) = idx; %#ok<AGROW>
        end
    end
    
    if isempty(valid_idx)
        return;
    end
    
    % Merge peaks separated by less than min_dist
    merged_idx = valid_idx(1);
    for k = 2:length(valid_idx)
        cur = valid_idx(k);
        prev = merged_idx(end);
        if abs(x_coords(cur) - x_coords(prev)) < min_dist
            if signal(cur) > signal(prev)
                merged_idx(end) = cur;
            end
        else
            merged_idx(end + 1) = cur; %#ok<AGROW>
        end
    end
    
    locs = x_coords(merged_idx);
    pks  = signal(merged_idx);
end
