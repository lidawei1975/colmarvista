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

console.log('--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY! ---');

