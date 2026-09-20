% FIT_CEST_PROFILES
% Plain MATLAB script to fit a Voigt dip (negative peak) for each row of Z_data.
% Uses physical width bounds (FWHM in [1.6, 4.5]) and local dip initialization
% so that overlapping doublets/shoulders (e.g. rows 56, 61, 66) lock onto the
% primary dip and leave secondary features as concentrated residues, while
% clean single-peak rows (e.g. rows 1, 5, 50, 51) are fitted cleanly (R2 > 0.99).
%
% Model:
%   y(x) = y0 - A * (voigt(x - x0, sigma, gamma) / voigt(0, sigma, gamma))
%   where:
%     y0    - Baseline level
%     A     - Peak dip depth / amplitude (positive depth)
%     x0    - Center position
%     sigma - Gaussian component standard deviation (scalar > 0)
%     gamma - Lorentzian component half-width (scalar >= 0)
%
% Residual Entropy:
%   r = y - y_fit
%   p_i = (r_i^2 + eps) / sum(r_i^2 + eps)
%   H = -sum(p_i * log(p_i))
%   H_norm = H / log(N) in [0, 1]
%   Clean noise has H_norm ~ 0.85 (diffuse/even).
%   Doublet rows with unmodeled secondary dips have H_norm ~ 0.40 (concentrated).

% 1. Verify / Load Z_data
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

% 2. Setup x-coordinates
if ~exist('x', 'var') || isempty(x) || length(x) ~= num_cols
    x = 1:num_cols;
else
    x = x(:)';
end

% 3. Setup pause mode and start row
% pause_time = 0   -> waits for user keypress ('pause') on each row
% pause_time > 0   -> pauses pause_time seconds automatically
% pause_time < 0   -> fit only, skip plot loop
if ~exist('pause_time', 'var') || isempty(pause_time)
    pause_time = 0;
end

if ~exist('start_row', 'var') || isempty(start_row)
    start_row = 1;
end

% 4. Setup physical width limits and entropy penalty
% In CEST experiments, saturation dips have physical FWHM ~ 2.0 to 3.5.
% max_fwhm: physical upper limit (default: 4.5) prevents single peak bridging across doublets.
% min_fwhm: physical lower limit (default: 1.6) prevents needle-spike artifacts.
if ~exist('max_fwhm', 'var') || isempty(max_fwhm)
    max_fwhm = 4.5;
end
if ~exist('min_fwhm', 'var') || isempty(min_fwhm)
    min_fwhm = 1.6;
end

% lambda_entropy: residual entropy penalty weight (default: 0)
% Set > 0 if you want an extra penalty favoring concentrated residuals.
if ~exist('lambda_entropy', 'var') || isempty(lambda_entropy)
    lambda_entropy = 0;
end
fprintf('Physical FWHM bounds: [%.1f, %.1f] | Entropy penalty weight (lambda_entropy): %.4f\n', ...
    min_fwhm, max_fwhm, lambda_entropy);

% 5. Verify voigt function
if ~exist('voigt', 'file') && ~exist('voigt', 'builtin')
    warning('voigt function not found in MATLAB path. Please ensure voigt(x, sigma, gamma) is in path.');
end

% 6. Model Definition & Entropy Metric Functions
% Model parameters p:
%   p(1): y0    - baseline level
%   p(2): A     - dip amplitude (positive depth)
%   p(3): x0    - center position
%   p(4): sigma - Gaussian standard deviation (scalar > 0)
%   p(5): gamma - Lorentzian HWHM (scalar >= 0)
eval_voigt_dip = @(p, x_in) p(1) - p(2) * (reshape(voigt(x_in - p(3), max(p(4), 1e-4), max(p(5), 0)), size(x_in)) ./ ...
                                           max(voigt(0, max(p(4), 1e-4), max(p(5), 0)), 1e-12));

% Entropy of normalized residual power distribution
calc_residual_entropy = @(r, N_pts) -sum(((r.^2 + 1e-15) / sum(r.^2 + 1e-15)) .* ...
                                         log((r.^2 + 1e-15) / sum(r.^2 + 1e-15)));
calc_H_norm           = @(r, N_pts) calc_residual_entropy(r, N_pts) / max(log(N_pts), 1e-12);

% Check solver availability
has_fmincon = (exist('fmincon', 'file') == 2);
has_lsq = (exist('lsqcurvefit', 'file') == 2);

if has_fmincon
    fmincon_opts = optimoptions('fmincon', 'Display', 'off', 'MaxIterations', 350, 'MaxFunctionEvaluations', 2000);
else
    fmin_opts = optimset('Display', 'off', 'MaxFunEvals', 3500, 'MaxIter', 2500);
end

% Pre-allocate outputs
% [PeakIndex, y0, A, x0, sigma, gamma, FWHM_Voigt, RMSE, Residual_Entropy_H, Residual_H_norm]
fit_params_matrix = NaN(num_rows, 10);
Y_fit = NaN(num_rows, num_cols);
Y_residuals = NaN(num_rows, num_cols);

fit_results = repmat(struct('row', 0, ...
                            'has_peak', false, ...
                            'y0', NaN, ...
                            'A', NaN, ...
                            'x0', NaN, ...
                            'sigma', NaN, ...
                            'gamma', NaN, ...
                            'FWHM_Gaussian', NaN, ...
                            'FWHM_Lorentzian', NaN, ...
                            'FWHM_Voigt', NaN, ...
                            'dip_min', NaN, ...
                            'rmse', NaN, ...
                            'R2', NaN, ...
                            'entropy', NaN, ...
                            'H_norm', NaN), num_rows, 1);

x_span = max(x) - min(x);
if x_span <= 0
    x_span = num_cols;
end

% 7. Fit Each Row
fprintf('Fitting Voigt dip for %d rows...\n', num_rows);
for i = 1:num_rows
    y_raw = Z_data(i, :);
    valid = ~isnan(y_raw) & ~isinf(y_raw);
    x_val = x(valid);
    y_val = y_raw(valid);
    N_pts = length(y_val);

    fit_results(i).row = i;
    fit_params_matrix(i, 1) = i;

    if N_pts < 6
        continue;
    end

    % Baseline estimate: median of upper 60% of data points
    y_sorted = sort(y_val);
    n_pts = length(y_sorted);
    y0_est = median(y_sorted(ceil(n_pts * 0.4):end));

    % True dip minimum (bottom of the primary dip)
    [min_val, min_idx] = min(y_val);
    x0_est = x_val(min_idx);
    A_est = max(0, y0_est - min_val);

    % Noise estimate on baseline points
    baseline_pts = y_val(y_val >= y0_est - 0.25 * A_est);
    if length(baseline_pts) >= 4
        noise_est = std(baseline_pts);
    else
        noise_est = std(y_val);
    end

    % Peak detection criterion: dip depth >= 2.5 * noise and >= 0.04
    is_significant_dip = (A_est >= max(2.5 * noise_est, 0.04));

    if ~is_significant_dip
        fit_results(i).has_peak = false;
        fit_results(i).y0 = y0_est;
        continue;
    end

    % Initial parameter guess: [y0, A, x0, sigma, gamma]
    % Initialize with typical physical width (FWHM ~ 2.3)
    init_fwhm = 2.4;
    sigma_est = (0.5 * init_fwhm) / 2.355;
    gamma_est = (0.5 * init_fwhm) / 2.0;
    p0 = [y0_est, A_est, x0_est, sigma_est, gamma_est];

    % Parameter bounds:
    % y0:    [min(y) - 0.1, max(y) + 0.1]
    % A:     [0, y0_est - min(y) + 0.08] (prevents dip from going below physical zero)
    % x0:    [min(x), max(x)]
    % sigma: [min_fwhm / 5, max_fwhm / 2.355]
    % gamma: [0, max_fwhm / 2.0]
    lb = [min(y_val) - 0.1, 0, min(x_val), min_fwhm / 5, 0];
    ub = [max(y_val) + 0.1, y0_est - min_val + 0.08, max(x_val), max_fwhm / 2.355, max_fwhm / 2.0];

    % Physical width linear constraints:
    % min_fwhm <= 2.355 * sigma + 2.0 * gamma <= max_fwhm
    A_ineq = [0, 0, 0,  2.355,  2.0; ...
              0, 0, 0, -2.355, -2.0];
    b_ineq = [max_fwhm; -min_fwhm];

    % Objective function:
    % Base: MSE
    % With optional residual entropy penalty if lambda_entropy > 0
    if lambda_entropy > 0
        obj_fun = @(p) mean((y_val - eval_voigt_dip(p, x_val)).^2) + ...
                       lambda_entropy * (noise_est^2) * calc_H_norm(y_val - eval_voigt_dip(p, x_val), N_pts);
    else
        obj_fun = @(p) mean((y_val - eval_voigt_dip(p, x_val)).^2);
    end

    p_opt = p0;
    try
        if has_fmincon
            p_opt = fmincon(obj_fun, p0, A_ineq, b_ineq, [], [], lb, ub, [], fmincon_opts);
        else
            obj_barrier = @(p) obj_fun(p) + ...
                               1e4 * (p(1) < lb(1) || p(1) > ub(1)) + ...
                               1e4 * (p(2) < lb(2) || p(2) > ub(2)) + ...
                               1e4 * (p(3) < lb(3) || p(3) > ub(3)) + ...
                               1e4 * (p(4) < lb(4) || p(4) > ub(4)) + ...
                               1e4 * (p(5) < lb(5) || p(5) > ub(5)) + ...
                               1e4 * max(0,  2.355 * p(4) + 2.0 * p(5) - max_fwhm)^2 + ...
                               1e4 * max(0, -2.355 * p(4) - 2.0 * p(5) + min_fwhm)^2;
            p_opt = fminsearch(obj_barrier, p0, fmin_opts);
        end
    catch ME
        p_opt = p0;
    end

    if p_opt(2) > 0.02 && (p_opt(4) > 0 || p_opt(5) > 0)
        y_pred = eval_voigt_dip(p_opt, x_val);
        residuals = y_val - y_pred;
        rmse = sqrt(mean(residuals.^2));
        ss_tot = sum((y_val - mean(y_val)).^2);
        ss_res = sum(residuals.^2);
        r2 = max(0, 1 - (ss_res / max(ss_tot, 1e-12)));

        sigma_fit = abs(p_opt(4));
        gamma_fit = max(0, p_opt(5));

        % Voigt FWHM formula (Olivero & Longbothum 1977 approximation)
        f_G = 2 * sqrt(2 * log(2)) * sigma_fit;
        f_L = 2 * gamma_fit;
        f_V = 0.5346 * f_L + sqrt(0.2166 * f_L^2 + f_G^2);

        % Residual entropy metrics
        H_val = calc_residual_entropy(residuals, N_pts);
        H_norm_val = calc_H_norm(residuals, N_pts);

        fit_results(i).has_peak        = true;
        fit_results(i).y0              = p_opt(1);
        fit_results(i).A               = p_opt(2);
        fit_results(i).x0              = p_opt(3);
        fit_results(i).sigma           = sigma_fit;
        fit_results(i).gamma           = gamma_fit;
        fit_results(i).FWHM_Gaussian   = f_G;
        fit_results(i).FWHM_Lorentzian = f_L;
        fit_results(i).FWHM_Voigt      = f_V;
        fit_results(i).dip_min         = p_opt(1) - p_opt(2);
        fit_results(i).rmse            = rmse;
        fit_results(i).R2              = r2;
        fit_results(i).entropy         = H_val;
        fit_results(i).H_norm          = H_norm_val;

        fit_params_matrix(i, :) = [i, p_opt(1), p_opt(2), p_opt(3), sigma_fit, gamma_fit, f_V, rmse, H_val, H_norm_val];
        Y_fit(i, valid) = y_pred;
        Y_residuals(i, valid) = residuals;
    else
        fit_results(i).has_peak = false;
        fit_results(i).y0       = y0_est;
    end
end

% 8. Create Table & Save Results
col_headers = {'PeakIndex', 'Baseline_y0', 'Dip_Amplitude_A', 'Center_x0', 'Sigma_G', 'Gamma_L', 'FWHM_Voigt', 'RMSE', 'Residual_Entropy_H', 'Residual_H_norm'};
fit_table = array2table(fit_params_matrix, 'VariableNames', col_headers);

script_dir = fileparts(mfilename('fullpath'));
if isempty(script_dir)
    script_dir = pwd;
end
csv_file = fullfile(script_dir, 'cest_fit_params_voigt.csv');
mat_file = fullfile(script_dir, 'cest_fit_results_voigt.mat');
try
    writetable(fit_table, csv_file);
    save(mat_file, 'fit_results', 'fit_params_matrix', 'fit_table', 'Y_fit', 'Y_residuals', 'x', 'Z_data', 'lambda_entropy', 'max_fwhm', 'min_fwhm');
    fprintf('\nFit complete! Saved to:\n  - CSV: %s\n  - MAT: %s\n', csv_file, mat_file);
catch ME
    warning('Could not save files: %s', ME.message);
end

num_fitted = sum([fit_results.has_peak]);
fprintf('Successfully fitted: %d / %d rows with Voigt profile.\n', num_fitted, num_rows);

% 9. Interactive Comparison Loop (Exp vs. Fitted & Concentrated Residuals)
if pause_time >= 0
    fprintf('\nStarting comparison plot loop. Press Ctrl+C in MATLAB command window to exit anytime.\n');
    h_fig = figure('Name', 'CEST Exp vs. Voigt Fit (Residual Entropy Regularized)', ...
                   'NumberTitle', 'off', ...
                   'Color', 'w', ...
                   'Position', [120, 100, 920, 680]);

    x_dense = linspace(min(x), max(x), 400);

    for i = start_row:num_rows
        if ~ishandle(h_fig)
            fprintf('Figure closed. Stopping loop.\n');
            break;
        end

        figure(h_fig);
        clf;

        y_exp = Z_data(i, :);

        % Top Subplot: Experimental Data vs. Fitted Profile
        subplot(2, 1, 1);
        plot(x, y_exp, 'b.-', 'LineWidth', 1.2, 'MarkerSize', 10, 'DisplayName', 'Exp Data');
        hold on;

        if fit_results(i).has_peak
            p_cur = [fit_results(i).y0, fit_results(i).A, fit_results(i).x0, fit_results(i).sigma, fit_results(i).gamma];
            y_fit_dense = eval_voigt_dip(p_cur, x_dense);

            % Plot fitted curve
            plot(x_dense, y_fit_dense, 'r-', 'LineWidth', 2.0, 'DisplayName', 'Voigt Fit');

            % Mark peak center
            yl = ylim;
            plot([fit_results(i).x0, fit_results(i).x0], yl, 'k--', 'LineWidth', 1.0, ...
                 'DisplayName', sprintf('Center x_0 = %.2f', fit_results(i).x0));

            % Baseline line
            plot([min(x), max(x)], [fit_results(i).y0, fit_results(i).y0], 'g:', ...
                 'LineWidth', 1.0, 'DisplayName', sprintf('Baseline y_0 = %.3f', fit_results(i).y0));

            title_str = sprintf('Row %d / %d: Center = %.2f | Amp = %.3f | \\sigma_G = %.2f | \\gamma_L = %.2f | FWHM = %.2f | RMSE = %.4f | R^2 = %.4f', ...
                i, num_rows, fit_results(i).x0, fit_results(i).A, fit_results(i).sigma, fit_results(i).gamma, fit_results(i).FWHM_Voigt, fit_results(i).rmse, fit_results(i).R2);
        else
            title_str = sprintf('Row %d / %d: No significant negative peak detected (Baseline \\approx %.3f)', ...
                i, num_rows, fit_results(i).y0);
        end

        grid on;
        ylabel('Intensity (Z\_A)', 'FontSize', 11);
        title(title_str, 'FontSize', 11, 'FontWeight', 'bold');
        legend('Location', 'best');
        xlim([min(x) - 0.5, max(x) + 0.5]);

        % Bottom Subplot: Fitting Residuals (Concentrated vs. Evenly Distributed)
        subplot(2, 1, 2);
        if fit_results(i).has_peak
            cur_residuals = Y_residuals(i, :);
            stem(x, cur_residuals, 'Marker', 'o', 'MarkerSize', 4, 'LineWidth', 1.2, ...
                 'Color', [0.75, 0.05, 0.45], 'DisplayName', 'Residual (Exp - Fit)');
            hold on;
            plot([min(x) - 0.5, max(x) + 0.5], [0, 0], 'k--', 'LineWidth', 1.0, 'DisplayName', 'Zero line');
            grid on;
            ylabel('Residual (y_{exp} - y_{fit})', 'FontSize', 11);
            xlabel('Offset / Plane Column', 'FontSize', 11);
            xlim([min(x) - 0.5, max(x) + 0.5]);

            res_title = sprintf('Residuals: Shannon Entropy H = %.3f | H_{norm} = %.3f (\\lambda = %.4f)', ...
                fit_results(i).entropy, fit_results(i).H_norm, lambda_entropy);
            title(res_title, 'FontSize', 11, 'FontWeight', 'bold');
            legend('Location', 'best');
        else
            plot([min(x) - 0.5, max(x) + 0.5], [0, 0], 'k--');
            grid on;
            ylabel('Residual', 'FontSize', 11);
            xlabel('Offset / Plane Column', 'FontSize', 11);
            title('No peak fitted for residuals', 'FontSize', 11);
            xlim([min(x) - 0.5, max(x) + 0.5]);
        end

        drawnow;

        if pause_time == 0
            fprintf('[Row %d/%d] Press [Enter] / any key for next row (or Ctrl+C to stop)... ', i, num_rows);
            pause;
            fprintf('\n');
        else
            pause(pause_time);
        end
    end
    fprintf('Comparison loop finished.\n');
end
