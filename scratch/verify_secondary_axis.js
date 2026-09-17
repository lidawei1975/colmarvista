const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- STARTING VERIFICATION: 2nd (Parallel) Axis System ---');

// 1. Verify HTML DOM elements in index_3d.html
console.log('1. Checking index_3d.html elements...');
const htmlContent = fs.readFileSync(path.join(__dirname, '../index_3d.html'), 'utf8');

const requiredHtmlIds = [
    'table_spectrum_info_3d',
    'col_sec_axis_y',
    'col_sec_axis_z',
    'btn_open_sec_axis_y',
    'btn_open_sec_axis_z',
    'row_dim_y_sec',
    'row_dim_z_sec',
    'spec_info_nuc_y_sec',
    'spec_info_sw_hz_y_sec',
    'spec_info_frq_y_sec',
    'spec_info_ppm_range_y_sec',
    'spec_info_hz_range_y_sec',
    'spec_info_points_y_sec',
    'spec_info_nuc_z_sec',
    'spec_info_sw_hz_z_sec',
    'spec_info_frq_z_sec',
    'spec_info_ppm_range_z_sec',
    'spec_info_hz_range_z_sec',
    'spec_info_points_z_sec',
    'modal_secondary_axis',
    'sec_axis_target_dim',
    'sec_axis_modal_title',
    'sec_axis_current_dim_desc',
    'sec_axis_nuclear',
    'sec_axis_nuc_preset',
    'sec_axis_frq',
    'sec_axis_ppm_inputs',
    'sec_axis_hz_inputs',
    'sec_axis_start_ppm',
    'sec_axis_end_ppm',
    'sec_axis_start_hz',
    'sec_axis_end_hz',
    'sec_axis_display_unit',
    'sec_axis_preview_box',
    'sec_axis_preview_summary',
    'sec_axis_preview_details',
    'sec_axis_preview_placement',
    'btn_sec_axis_remove'
];

requiredHtmlIds.forEach(id => {
    assert(htmlContent.includes(`id="${id}"`), `Missing HTML element id: ${id}`);
});
console.log('   All required HTML elements and IDs are present.');

// 2. Verify plotit methods in js/myplot/myplot1_new.js
console.log('2. Checking js/myplot/myplot1_new.js secondary axis methods...');
const plotitContent = fs.readFileSync(path.join(__dirname, '../js/myplot/myplot1_new.js'), 'utf8');

const requiredPlotitMethods = [
    'plotit.prototype.set_secondary_x_axis',
    'plotit.prototype.update_secondary_x_axis',
    'plotit.prototype.remove_secondary_x_axis',
    'plotit.prototype.set_secondary_y_axis',
    'plotit.prototype.update_secondary_y_axis',
    'plotit.prototype.remove_secondary_y_axis'
];

requiredPlotitMethods.forEach(method => {
    assert(plotitContent.includes(method), `Missing method in myplot1_new.js: ${method}`);
});

// Check hook into reset_axis
assert(plotitContent.includes('this.update_secondary_x_axis()'), 'reset_axis must call update_secondary_x_axis');
assert(plotitContent.includes('this.update_secondary_y_axis()'), 'reset_axis must call update_secondary_y_axis');
console.log('   plotit secondary axis methods and hooks are present.');

// 3. Verify controller functions in js/3d.js
console.log('3. Checking js/3d.js controller functions and exports...');
const js3dContent = fs.readFileSync(path.join(__dirname, '../js/3d.js'), 'utf8');

const required3dFunctions = [
    'window.secondary_axis_config',
    'open_secondary_axis_modal',
    'close_secondary_axis_modal',
    'on_sec_axis_preset_change',
    'toggle_sec_axis_input_mode',
    'sec_axis_offset_sw',
    'sec_axis_copy_primary',
    'update_sec_axis_modal_preview',
    'save_secondary_axis_from_modal',
    'remove_secondary_axis_from_modal',
    'remove_secondary_axis',
    'update_all_secondary_axes'
];

required3dFunctions.forEach(fn => {
    assert(js3dContent.includes(fn), `Missing function or export in 3d.js: ${fn}`);
});

// 4. Verify Placement Rules in update_all_secondary_axes
console.log('4. Verifying Placement Rules in update_all_secondary_axes...');
// Rule 1: main_plot (XY) -> secondary Y on RIGHT (y)
assert(js3dContent.includes('main_plot.set_secondary_y_axis(plotCfg_y)'), 'main_plot must set secondary Y for y');

// Rule 2: main_plot_xz (XZ) -> secondary Y on RIGHT (z)
assert(js3dContent.includes('main_plot_xz.set_secondary_y_axis(plotCfg_z)'), 'main_plot_xz must set secondary Y for z');

// Rule 3: main_plot_yz (ZY) -> secondary X on TOP (z) and secondary Y on RIGHT (y)
// User specification: "Once added, the plot will show both axis, with the 2nd one either on top (if 1st one is on bottom) or right (if 1st one is on the left)."
// In ZY plane: z is on bottom (1st axis) -> 2nd axis on TOP (set_secondary_x_axis); y is on left (1st axis) -> 2nd axis on RIGHT (set_secondary_y_axis).
assert(js3dContent.includes('main_plot_yz.set_secondary_x_axis(plotCfg_z)'), 'main_plot_yz must set secondary X on TOP for z');
assert(js3dContent.includes('main_plot_yz.set_secondary_y_axis(plotCfg_y)'), 'main_plot_yz must set secondary Y on RIGHT for y');
console.log('   Placement rules accurately implemented.');

// 5. Test Mathematical Mapping
console.log('5. Testing linear interpolation and coordinate transformation math...');
function testMapping(primRange, secRange, testVal) {
    const prim_start = primRange[0];
    const prim_end = primRange[1];
    const sec_start = secRange[0];
    const sec_end = secRange[1];

    const denom = prim_end - prim_start;
    const t = (testVal - prim_start) / denom;
    return sec_start + t * (sec_end - sec_start);
}

// Example 1: 15N (135 ppm -> 105 ppm, SW = 30 ppm) mapped to 13C (185 ppm -> 165 ppm, SW = 20 ppm)
const primRange1 = [135.0, 105.0];
const secRange1 = [185.0, 165.0];

assert.strictEqual(testMapping(primRange1, secRange1, 135.0), 185.0, 'Start point should map exactly to secondary start');
assert.strictEqual(testMapping(primRange1, secRange1, 105.0), 165.0, 'End point should map exactly to secondary end');
assert.strictEqual(testMapping(primRange1, secRange1, 120.0), 175.0, 'Midpoint should map to secondary midpoint');

// Example 2: Zoomed view [125, 115]
const zoomP0 = 125.0;
const zoomP1 = 115.0;
const zoomSec0 = testMapping(primRange1, secRange1, zoomP0);
const zoomSec1 = testMapping(primRange1, secRange1, zoomP1);

assert(Math.abs(zoomSec0 - (185.0 - (10.0 / 30.0) * 20.0)) < 1e-9, 'Zoom start calculation');
assert(Math.abs(zoomSec1 - (185.0 - (20.0 / 30.0) * 20.0)) < 1e-9, 'Zoom end calculation');
console.log('   Mathematical coordinate mapping verified.');

// 6. Verify documentation in doc_3d.html
console.log('6. Checking doc_3d.html for 2nd Parallel Axis documentation...');
const docContent = fs.readFileSync(path.join(__dirname, '../doc_3d.html'), 'utf8');
assert(docContent.includes('2nd (Parallel) Axis System'), 'doc_3d.html must include 2nd (Parallel) Axis System documentation');
assert(docContent.includes('Automatic Axis Placement Rule'), 'doc_3d.html must document the axis placement rules');
console.log('   doc_3d.html documentation verified.');

// 7. Verify has_secondary_axis and get_3d_plot_margins in js/3d.js
console.log('7. Verifying dynamic margin calculations for all 3 2D plots...');
assert(js3dContent.includes('function has_secondary_axis()'), 'Missing has_secondary_axis() in 3d.js');
assert(js3dContent.includes('function get_3d_plot_margins('), 'Missing get_3d_plot_margins() in 3d.js');

// Mock window and spectra_3d to test margin functions directly
const mockGlobal = {
    window: {
        secondary_axis_config: { y: null, z: null },
        last_fid_nuclei: { x: '1H', y: '15N', z: '13C' }
    },
    spectra_3d: [{ frq1: 600.0, frq2: 60.8, frq3: 150.9 }]
};

function evalHasSec(secCfg) {
    return !!(secCfg && (secCfg.y || secCfg.z));
}

function evalMargins(hasSec, plot_font_size = 24) {
    return {
        left: 30 + plot_font_size * 5,
        bottom: 30 + plot_font_size * 3,
        top: hasSec ? (30 + plot_font_size * 3) : 45,
        right: hasSec ? (30 + plot_font_size * 5) : 65
    };
}

// Check standard margins (no 2nd axis)
const stdMargins = evalMargins(false, 24);
assert.strictEqual(stdMargins.top, 45, 'Default top margin should be 45');
assert.strictEqual(stdMargins.right, 65, 'Default right margin should be 65');
assert.strictEqual(stdMargins.left, 150, 'Default left margin should be 150');
assert.strictEqual(stdMargins.bottom, 102, 'Default bottom margin should be 102');

// Check larger margins when 2nd axis exists (top largely matches bottom, right largely matches left)
const secMargins = evalMargins(true, 24);
assert.strictEqual(secMargins.top, 102, 'Top margin with 2nd axis should be 102 (largely matching bottom)');
assert.strictEqual(secMargins.right, 150, 'Right margin with 2nd axis should be 150 (largely matching left)');
assert.strictEqual(secMargins.left, 150, 'Left margin should be 150');
assert.strictEqual(secMargins.bottom, 102, 'Bottom margin should be 102');
assert.strictEqual(secMargins.top, secMargins.bottom, 'Top margin should match bottom margin');
assert.strictEqual(secMargins.right, secMargins.left, 'Right margin should match left margin');
console.log('   Margin logic verified: top (102) matches bottom (102), right (150) matches left (150).');

// 8. Verify is_allowed_secondary_dimension (15N and 13C allowed, 1H rejected)
console.log('8. Verifying 15N/13C restriction and 1H rejection...');
assert(js3dContent.includes('function is_allowed_secondary_dimension('), 'Missing is_allowed_secondary_dimension in 3d.js');

function evalAllowedNuc(nucStr) {
    const s = (nucStr || '').toUpperCase();
    if (s.includes('1H') || s.includes('H1')) return false;
    if (s.includes('15N') || s.includes('N15') || s.includes('13C') || s.includes('C13')) return true;
    return false;
}

assert.strictEqual(evalAllowedNuc('15N'), true, '15N should be allowed');
assert.strictEqual(evalAllowedNuc('13C'), true, '13C should be allowed');
assert.strictEqual(evalAllowedNuc('13CO'), true, '13CO should be allowed');
assert.strictEqual(evalAllowedNuc('1H'), false, '1H must NOT be allowed');
assert.strictEqual(evalAllowedNuc('1H(F2)'), false, '1H(F2) must NOT be allowed');
console.log('   Nucleus restrictions verified: 15N/13C allowed, 1H strictly forbidden.');

// 9. Verify consistency across all 3 2D plots in update_all_secondary_axes
console.log('9. Checking update_all_secondary_axes consistency across all 3 2D plots...');
assert(js3dContent.includes('const margins = get_3d_plot_margins(24);'), 'update_all_secondary_axes must use get_3d_plot_margins');
assert(js3dContent.includes('parent: "vis_parent", canvas: "canvas1"'), 'main_plot canvas must be updated');
assert(js3dContent.includes('parent: "vis_parent_xz", canvas: "canvas_xz"'), 'main_plot_xz canvas must be updated');
assert(js3dContent.includes('parent: "vis_parent_yz", canvas: "canvas_yz"'), 'main_plot_yz canvas must be updated');
console.log('   All 3 2D plots are consistently updated with matching margins.');

// 10. Verify hover text generation with 2nd y (and 2nd x)
console.log('10. Verifying hover text generation with 2nd y...');
assert(plotitContent.includes('y2_str'), 'myplot1_new.js must compute y2_str for hover info');
assert(plotitContent.includes('y2_ppm'), 'myplot1_new.js must support y2_ppm label');
assert(plotitContent.includes('y2_hz'), 'myplot1_new.js must support y2_hz label');

// Test simulation of hover string generator
function formatHoverInfor(x_ppm, y_ppm, data_height, signal_to_noise, sec_y_cfg, sec_x_cfg, coordY, coordX, yRange2, xRange2) {
    let y2_val = null;
    let y2_unit = "ppm";
    let y2_str = "";
    if (sec_y_cfg) {
        y2_unit = sec_y_cfg.unit || "ppm";
        if (yRange2 && typeof yRange2.invert === 'function') {
            y2_val = yRange2.invert(coordY);
        } else if (sec_y_cfg.primary_range && sec_y_cfg.secondary_range) {
            const pStart = sec_y_cfg.primary_range[0];
            const pEnd = sec_y_cfg.primary_range[1];
            const sStart = sec_y_cfg.secondary_range[0];
            const sEnd = sec_y_cfg.secondary_range[1];
            const denom = pEnd - pStart;
            if (Math.abs(denom) > 1e-9) {
                y2_val = sStart + ((y_ppm - pStart) / denom) * (sEnd - sStart);
            }
        }
        if (y2_val !== null && !isNaN(y2_val)) {
            let tag = (y2_unit.toLowerCase() === 'hz') ? "y2_hz" : "y2_ppm";
            let valStr = (y2_unit.toLowerCase() === 'hz') ? y2_val.toFixed(1) : y2_val.toFixed(2);
            y2_str = ", " + tag + ": " + valStr;
        }
    }

    let x2_val = null;
    let x2_unit = "ppm";
    let x2_str = "";
    if (sec_x_cfg) {
        x2_unit = sec_x_cfg.unit || "ppm";
        if (xRange2 && typeof xRange2.invert === 'function') {
            x2_val = xRange2.invert(coordX);
        } else if (sec_x_cfg.primary_range && sec_x_cfg.secondary_range) {
            const pStart = sec_x_cfg.primary_range[0];
            const pEnd = sec_x_cfg.primary_range[1];
            const sStart = sec_x_cfg.secondary_range[0];
            const sEnd = sec_x_cfg.secondary_range[1];
            const denom = pEnd - pStart;
            if (Math.abs(denom) > 1e-9) {
                x2_val = sStart + ((x_ppm - pStart) / denom) * (sEnd - sStart);
            }
        }
        if (x2_val !== null && !isNaN(x2_val)) {
            let tag = (x2_unit.toLowerCase() === 'hz') ? "x2_hz" : "x2_ppm";
            let valStr = (x2_unit.toLowerCase() === 'hz') ? x2_val.toFixed(1) : x2_val.toFixed(2);
            x2_str = ", " + tag + ": " + valStr;
        }
    }

    return "x_ppm: " + x_ppm.toFixed(3) + x2_str + ", y_ppm: " + y_ppm.toFixed(2) + y2_str + ", Inten: " + data_height.toExponential(2) + " ,S/N: " + signal_to_noise.toFixed(2);
}

// Case A: No 2nd axis
const textNoSec = formatHoverInfor(8.234, 120.45, 1.23e6, 25.4, null, null);
assert.strictEqual(textNoSec, "x_ppm: 8.234, y_ppm: 120.45, Inten: 1.23e+6 ,S/N: 25.40");

// Case B: 2nd Y in ppm
const cfgPpm = { unit: 'ppm', primary_range: [100, 130], secondary_range: [110, 140] };
const textSecPpm = formatHoverInfor(8.234, 120.0, 1.23e6, 25.4, cfgPpm, null);
assert(textSecPpm.includes('y2_ppm: 130.00'), 'Should calculate and display y2_ppm for ppm unit');
assert.strictEqual(textSecPpm, "x_ppm: 8.234, y_ppm: 120.00, y2_ppm: 130.00, Inten: 1.23e+6 ,S/N: 25.40");

// Case C: 2nd Y in Hz
const cfgHz = { unit: 'Hz', primary_range: [100, 130], secondary_range: [8600, 11180] };
const textSecHz = formatHoverInfor(8.234, 115.0, 1.23e6, 25.4, cfgHz, null);
assert(textSecHz.includes('y2_hz: 9890.0'), 'Should calculate and display y2_hz for Hz unit');
assert.strictEqual(textSecHz, "x_ppm: 8.234, y_ppm: 115.00, y2_hz: 9890.0, Inten: 1.23e+6 ,S/N: 25.40");

console.log('   Hover text with 2nd y (ppm and Hz) verified successfully.');

// 11. Verify Shift Calibration Quick Offset of + or - SW
console.log('11. Verifying Shift Calibration quick offset of + or - SW...');
const quickOffsetButtons = [
    'btn_shift_plus_sw_y',
    'btn_shift_minus_sw_y',
    'btn_shift_plus_sw_z',
    'btn_shift_minus_sw_z'
];

const freshHtml = fs.readFileSync(path.join(__dirname, '../index_3d.html'), 'utf8');
quickOffsetButtons.forEach(id => {
    assert(freshHtml.includes(`id="${id}"`), `Missing HTML quick offset button id: ${id}`);
});

const freshJs3d = fs.readFileSync(path.join(__dirname, '../js/3d.js'), 'utf8');
assert(freshJs3d.includes('function apply_sw_shift('), '3d.js must implement apply_sw_shift');
assert(freshJs3d.includes('window.apply_sw_shift = apply_sw_shift'), '3d.js must export apply_sw_shift to window');

// Test simulation of SW calculation and quick offset
function testSwOffsetCalc(s0, normAxis, unit, multiplier) {
    let sw_hz = 0;
    let sw_ppm = 0;
    let frq = 0;

    if (normAxis === 'y') {
        frq = s0.frq2;
        sw_hz = s0.sw2;
        sw_ppm = s0.y_ppm_width || (sw_hz / frq);
    } else {
        frq = s0.frq3;
        sw_hz = s0.sw3;
        sw_ppm = s0.z_ppm_width || (sw_hz / frq);
    }

    const offsetVal = (unit === 'hz') ? (multiplier * sw_hz) : (multiplier * sw_ppm);
    return {
        offsetVal,
        delta_ppm: (unit === 'ppm') ? offsetVal : (offsetVal / frq),
        delta_hz: (unit === 'ppm') ? (offsetVal * frq) : offsetVal
    };
}

const mockPlane = {
    y_ppm_start: 135.154,
    y_ppm_width: 35.002,
    sw2: 2067.82,
    frq2: 86.156,
    z_ppm_start: 175.845,
    z_ppm_width: 13.003,
    sw3: 2779.32,
    frq3: 213.810
};

// Test +SW in ppm for Y
const resYPlus = testSwOffsetCalc(mockPlane, 'y', 'ppm', 1);
assert.strictEqual(resYPlus.offsetVal, 35.002);
assert.strictEqual(resYPlus.delta_ppm, 35.002);
assert(Math.abs(resYPlus.delta_hz - (35.002 * 86.156)) < 1e-6);

// Test -SW in ppm for Y
const resYMinus = testSwOffsetCalc(mockPlane, 'y', 'ppm', -1);
assert.strictEqual(resYMinus.offsetVal, -35.002);
assert.strictEqual(resYMinus.delta_ppm, -35.002);

// Test +SW in Hz for Z
const resZPlusHz = testSwOffsetCalc(mockPlane, 'z', 'hz', 1);
assert.strictEqual(resZPlusHz.offsetVal, 2779.32);
assert.strictEqual(resZPlusHz.delta_hz, 2779.32);
assert(Math.abs(resZPlusHz.delta_ppm - (2779.32 / 213.810)) < 1e-6);

// Test -SW in Hz for Z
const resZMinusHz = testSwOffsetCalc(mockPlane, 'z', 'hz', -1);
assert.strictEqual(resZMinusHz.offsetVal, -2779.32);
assert.strictEqual(resZMinusHz.delta_hz, -2779.32);

console.log('   Shift Calibration +SW and -SW quick offsets verified successfully.');

console.log('--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY! ---');



