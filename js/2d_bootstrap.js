(function () {
    const bootstrapScript = document.currentScript;
    const controller = bootstrapScript.dataset.controller || "legacy";
    const root = document.getElementById("app-view-root");
    const scriptUrls = [
        "https://ajax.googleapis.com/ajax/libs/jquery/1.8.2/jquery.min.js",
        "js/webgl-utils.js",
        "js/d3.7.min.js",
        "js/ldwmath.js",
        "js/m3.js",
        "js/shared/myplot_webgl_2d.js?v=20261027_1",
        "js/myplot/cross_section_plot.js",
        "js/shared/myplot_2d.js?v=20261027_1",
        "js/shared/nmr_pipeline_2d.js?v=20261027_1",
        "js/myplot/myplot_fitting.js",
        "js/peak_profile.js?v=20260928_6",
        "js/myplot/pseudo3d_profile_plot.js?v=20260929_9",
        "js/peaks.js?v=20260929_1",
        "js/spectrum.js",
        "js/spectrum_fit.js",
        "js/file_drop.js?v=20261127_1",
        "js/make_table.js?v=20260926_1",
        "js/simple_peak_picker.js",
        "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
        "js/2d_tfjs_infer_full_pipeline.js?v=20261029_2",
        "js/tools/HuangarianInt32.js",
        "js/tutorial.js",
        "js/tooltips.js?v=20261014_1",
        "js/wasm_runner.js?v=20261127_2",
        "js/2d_common.js?v=20261127_6",
        "js/2d.js?v=20261127_11"
    ];

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.body.appendChild(script);
        });
    }

    async function start() {
        if (!root) throw new Error("Missing app view mount point.");
        const response = await fetch("2d_app_view.html?v=20261127_6");
        if (!response.ok) throw new Error(`Failed to load app view (${response.status}).`);
        root.innerHTML = await response.text();

        await loadScript(scriptUrls[0]);
        const jquery = window.jQuery;
        if (jquery && typeof jquery.holdReady === "function") jquery.holdReady(true);
        try {
            for (const url of scriptUrls.slice(1)) {
                await loadScript(url);
            }
            document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
            if (controller === "windows") {
                await loadScript("js/2d_windows_ui.js?v=20261127_30");
            }
        } finally {
            if (jquery && typeof jquery.holdReady === "function") jquery.holdReady(false);
        }
        root.dataset.appReady = "true";
        document.dispatchEvent(new CustomEvent("colmar:app-ready", { bubbles: true }));
    }

    start().catch(error => {
        console.error("COLMARvista failed to start.", error);
        const message = document.getElementById("app-start-error");
        if (message) message.textContent = error.message;
    });
})();
