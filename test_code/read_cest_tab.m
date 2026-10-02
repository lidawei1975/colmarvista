function [Z_data, peak_info, col_names] = read_cest_tab(filename)
% READ_CEST_TAB Reads an NMRPipe CEST peak table (.tab) and extracts Z_A0 ... Z_A99.
%
% Usage:
%   read_cest_tab;                                  % Run as script, loads cest.tab & plots profiles
%   Z_data = read_cest_tab();                       % Defaults to 'cest.tab' in script or current dir
%   [Z_data, peak_info] = read_cest_tab('cest.tab');
%   [Z_data, peak_info, col_names] = read_cest_tab('path/to/cest.tab');
%
% Outputs:
%   Z_data     - [N_peaks x 100] double matrix containing columns Z_A0, Z_A1, ..., Z_A99
%   peak_info  - Struct array with metadata for each peak:
%                  .Index     - Peak index number [N_peaks x 1]
%                  .X_PPM     - Direct dimension chemical shift (ppm) [N_peaks x 1]
%                  .Y_PPM     - Indirect dimension chemical shift (ppm) [N_peaks x 1]
%                  .Height    - Peak height / intensity [N_peaks x 1]
%                  .ClusterID - Cluster ID [N_peaks x 1]
%                  .Ass       - Peak assignment string (cell array)
%   col_names  - Cell array of strings {'Z_A0', 'Z_A1', ..., 'Z_A99'}

    % 1. Determine input file path
    if nargin < 1 || isempty(filename)
        % First check current directory
        if exist('cest.tab', 'file')
            filename = 'cest.tab';
        else
            % Check directory of this m-file
            script_dir = fileparts(mfilename('fullpath'));
            cand = fullfile(script_dir, 'cest.tab');
            if exist(cand, 'file')
                filename = cand;
            else
                error('Could not find cest.tab in current directory or script directory.');
            end
        end
    end

    if ~exist(filename, 'file')
        error('File not found: %s', filename);
    end

    % 2. Open and parse file
    fid = fopen(filename, 'r');
    if fid == -1
        error('Failed to open file: %s', filename);
    end

    header_cols = {};
    data_tokens = {};

    tline = fgetl(fid);
    while ischar(tline)
        line_trimmed = strtrim(tline);

        if isempty(line_trimmed)
            tline = fgetl(fid);
            continue;
        end

        % Check for VARS header line defining column names
        if strncmp(line_trimmed, 'VARS', 4)
            tokens = regexp(line_trimmed, '\s+', 'split');
            header_cols = tokens(2:end); % omit 'VARS' token
        elseif strncmp(line_trimmed, 'DATA', 4) || ...
               strncmp(line_trimmed, 'FORMAT', 6) || ...
               strncmp(line_trimmed, '#', 1)
            % Skip format / comment lines
        else
            % Peak data line
            tokens = regexp(line_trimmed, '\s+', 'split');
            data_tokens{end + 1} = tokens; %#ok<AGROW>
        end

        tline = fgetl(fid);
    end
    fclose(fid);

    if isempty(header_cols)
        error('No VARS header line found in %s', filename);
    end

    num_peaks = length(data_tokens);
    if num_peaks == 0
        warning('No peak data rows found in %s', filename);
        Z_data = [];
        peak_info = struct();
        col_names = {};
        return;
    end

    % 3. Identify column indices for Z_A0 ... Z_A99 in exact numerical order (0 to 99)
    num_planes = 100;
    col_names = arrayfun(@(k) sprintf('Z_A%d', k), 0:(num_planes - 1), 'UniformOutput', false);
    za_indices = zeros(1, num_planes);

    for k = 1:num_planes
        target_name = col_names{k};
        idx = find(strcmp(header_cols, target_name), 1);
        if isempty(idx)
            error('Column "%s" not found in VARS header.', target_name);
        end
        za_indices(k) = idx;
    end

    % 4. Extract numeric matrix for Z_A0 ... Z_A99
    Z_data = zeros(num_peaks, num_planes);
    for i = 1:num_peaks
        toks = data_tokens{i};
        for j = 1:num_planes
            col_idx = za_indices(j);
            if col_idx <= length(toks)
                Z_data(i, j) = str2double(toks{col_idx});
            else
                Z_data(i, j) = NaN;
            end
        end
    end

    % 5. Extract peak metadata
    peak_info = struct();
    idx_index  = find(strcmp(header_cols, 'INDEX'), 1);
    idx_xppm   = find(strcmp(header_cols, 'X_PPM'), 1);
    idx_yppm   = find(strcmp(header_cols, 'Y_PPM'), 1);
    idx_height = find(strcmp(header_cols, 'HEIGHT'), 1);
    idx_clust  = find(strcmp(header_cols, 'CLUSTID'), 1);
    idx_ass    = find(strcmp(header_cols, 'ASS'), 1);

    if ~isempty(idx_index)
        peak_info.Index = cellfun(@(x) str2double(x{idx_index}), data_tokens)';
    else
        peak_info.Index = (1:num_peaks)';
    end

    if ~isempty(idx_xppm)
        peak_info.X_PPM = cellfun(@(x) str2double(x{idx_xppm}), data_tokens)';
    end

    if ~isempty(idx_yppm)
        peak_info.Y_PPM = cellfun(@(x) str2double(x{idx_yppm}), data_tokens)';
    end

    if ~isempty(idx_height)
        peak_info.Height = cellfun(@(x) str2double(x{idx_height}), data_tokens)';
    end

    if ~isempty(idx_clust)
        peak_info.ClusterID = cellfun(@(x) str2double(x{idx_clust}), data_tokens)';
    end

    if ~isempty(idx_ass)
        peak_info.Ass = cellfun(@(x) x{idx_ass}, data_tokens, 'UniformOutput', false)';
    end

    % 6. Display summary and plot if run with no output arguments
    fprintf('Successfully read %s:\n', filename);
    fprintf('  - Extracted %d peaks across %d planes (Z_A0 to Z_A99)\n', num_peaks, num_planes);
    fprintf('  - Matrix size of Z_data: [%d x %d]\n', size(Z_data, 1), size(Z_data, 2));

    if nargout == 0
        % Assign variables to MATLAB base workspace for convenience
        assignin('base', 'Z_data', Z_data);
        assignin('base', 'peak_info', peak_info);
        assignin('base', 'col_names', col_names);
        fprintf('  - Variables Z_data, peak_info, and col_names assigned to base workspace.\n');

        % Plot CEST profiles
        figure('Name', 'CEST Profiles', 'NumberTitle', 'off', 'Color', 'w');
        planes = 0:(num_planes - 1);
        plot(planes, Z_data', 'LineWidth', 1.1);
        grid on;
        xlabel('Plane Index (0 to 99)', 'FontSize', 12);
        ylabel('Intensity / Normalized Ratio (Z\_A)', 'FontSize', 12);
        title(sprintf('CEST Profiles (%d Peaks across %d Planes)', num_peaks, num_planes), 'FontSize', 13);
        xlim([0, num_planes - 1]);
    end

    Z_data(:,[1 43 83])=[];
end



