/**
 * Sync main XY and YZ plots when XZ plot is zoomed/panned
 */
function sync_from_xz_plot() {
    if (!main_plot_xz || !main_plot || !main_plot_yz) return;

    // Get XZ plot's current X domain (Direct dimension)
    let x_domain = main_plot_xz.xRange.domain();

    // Sync main plot X-axis
    main_plot.xscale = [x_domain[0], x_domain[1]];
    main_plot.xRange.domain(main_plot.xscale);
    main_plot.reset_axis();

    if (main_plot.contour_plot) {
        let y_dom = main_plot.yRange.domain();
        main_plot.contour_plot.setCamera_ppm(
            main_plot.xscale[0], main_plot.xscale[1],
            y_dom[0], y_dom[1]
        );
        main_plot.contour_plot.drawScene();
    }

    // Sync YZ plot Y-axis (shares Direct dimension with XZ X-axis)
    main_plot_yz.yscale = [x_domain[0], x_domain[1]];
    main_plot_yz.yRange.domain(main_plot_yz.yscale);
    main_plot_yz.reset_axis();

    if (main_plot_yz.contour_plot) {
        let x_dom_yz = main_plot_yz.xRange.domain();
        main_plot_yz.contour_plot.setCamera_ppm(
            x_dom_yz[0], x_dom_yz[1],
            main_plot_yz.yscale[0], main_plot_yz.yscale[1]
        );
        main_plot_yz.contour_plot.drawScene();
    }
}

/**
 * Sync main XY and XZ plots when YZ plot is zoomed/panned
 */
function sync_from_yz_plot() {
    if (!main_plot_yz || !main_plot || !main_plot_xz) return;

    // Get YZ plot's current Y domain (Indirect dimension)
    let y_domain = main_plot_yz.yRange.domain();

    // Sync main plot Y-axis
    main_plot.yscale = [y_domain[0], y_domain[1]];
    main_plot.yRange.domain(main_plot.yscale);
    main_plot.reset_axis();

    if (main_plot.contour_plot) {
        let x_dom = main_plot.xRange.domain();
        main_plot.contour_plot.setCamera_ppm(
            x_dom[0], x_dom[1],
            main_plot.yscale[0], main_plot.yscale[1]
        );
        main_plot.contour_plot.drawScene();
    }

    // Sync XZ plot X-axis (shares Indirect dimension with YZ Y-axis)
    main_plot_xz.xscale = [y_domain[0], y_domain[1]];
    main_plot_xz.xRange.domain(main_plot_xz.xscale);
    main_plot_xz.reset_axis();

    if (main_plot_xz.contour_plot) {
        let y_dom_xz = main_plot_xz.yRange.domain();
        main_plot_xz.contour_plot.setCamera_ppm(
            main_plot_xz.xscale[0], main_plot_xz.xscale[1],
            y_dom_xz[0], y_dom_xz[1]
        );
        main_plot_xz.contour_plot.drawScene();
    }
}
