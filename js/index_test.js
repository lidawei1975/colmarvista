// Controller for ChemEx Web Worker, Floating Console UI, and Interactive NH Profile Simulation

let worker = null;
let isReady = false;
let isRunning = false;
let isInteractiveFitting = false;
let currentVirtualFiles = [];
let currentSelectedFile = null;
let currentResidueDefaults = null;
let simDebounceTimer = null;

// DOM Elements: Status & Filesystem
const statusBar = document.getElementById("statusBar");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");

const fsStatusBadge = document.getElementById("fsStatusBadge");
const btnWriteFs = document.getElementById("btnWriteFs");
const virtualFilesList = document.getElementById("virtualFilesList");

// DOM Elements: ChemEx Run Controls
const btnRunFit = document.getElementById("btnRunFit");
const btnRunSim = document.getElementById("btnRunSim");
const btnToggleConsole = document.getElementById("btnToggleConsole");
const residueSelect = document.getElementById("residueSelect");
const commandDisplay = document.getElementById("commandDisplay");

// DOM Elements: Output Files
const outputFilesCard = document.getElementById("outputFilesCard");
const outputFilesBadges = document.getElementById("outputFilesBadges");
const fileViewerContainer = document.getElementById("fileViewerContainer");
const fileViewerTitle = document.getElementById("fileViewerTitle");
const fileViewerContent = document.getElementById("fileViewerContent");
const fileViewerPre = document.getElementById("fileViewerPre");
const fileViewerPdf = document.getElementById("fileViewerPdf");
const btnOpenPdfNewTab = document.getElementById("btnOpenPdfNewTab");
const btnDownloadFile = document.getElementById("btnDownloadFile");

const errorAlert = document.getElementById("errorAlert");

// Floating Console Elements
const consoleWindow = document.getElementById("chemex_console_window");
const consoleHeader = document.getElementById("chemex_console_header");
const consoleBody = document.getElementById("chemex_console_body");
const pythonStdout = document.getElementById("pythonStdout");
const buttonMinimizeConsole = document.getElementById("button_minimize_console");
const buttonClearConsole = document.getElementById("button_clear_console");

// Interactive Profile Simulation Elements
const interactiveResidueSelect = document.getElementById("interactiveResidueSelect");
const btnReloadResidue = document.getElementById("btnReloadResidue");
const interactiveProfilePlotDiv = document.getElementById("interactiveProfilePlot");
const btnResetPlotZoom = document.getElementById("btnResetPlotZoom");
const d3PlotTooltip = document.getElementById("d3PlotTooltip");
const simLiveBadge = document.getElementById("simLiveBadge");
const paramStatusTag = document.getElementById("paramStatusTag");
const fitResultNotice = document.getElementById("fitResultNotice");

const num_PB = document.getElementById("num_PB");
const slider_PB = document.getElementById("slider_PB");
const num_KEX = document.getElementById("num_KEX");
const slider_KEX = document.getElementById("slider_KEX");
const num_CS = document.getElementById("num_CS");
const slider_CS = document.getElementById("slider_CS");
const num_DW = document.getElementById("num_DW");
const slider_DW = document.getElementById("slider_DW");
const num_TAUC = document.getElementById("num_TAUC");

const btnFitFromParams = document.getElementById("btnFitFromParams");
const btnResetParams = document.getElementById("btnResetParams");

// Update command display
function updateCommandDisplay() {
  if (commandDisplay) {
    commandDisplay.textContent = "chemex fit -e Experiments/*.toml -p Parameters/parameters.toml -o Output";
  }
}

// -------------------------------------------------------------
// Floating Console Window Controller (Drag, Minimize, Clear)
// -------------------------------------------------------------

function appendConsole(text) {
  if (!pythonStdout) return;
  pythonStdout.textContent += text;
  pythonStdout.scrollTop = pythonStdout.scrollHeight;
}

function clear_console() {
  if (pythonStdout) {
    pythonStdout.textContent = "";
  }
}

function toggle_console_minimize() {
  if (!consoleWindow || !consoleBody || !buttonMinimizeConsole) return;

  if (consoleBody.style.display === "none") {
    // Restore
    consoleBody.style.display = "flex";
    consoleWindow.style.height = consoleWindow.dataset.lastHeight || "360px";
    consoleWindow.style.width = consoleWindow.dataset.lastWidth || "580px";
    consoleWindow.style.resize = "both";
    buttonMinimizeConsole.innerText = "—";
    buttonMinimizeConsole.title = "Minimize console window";
  } else {
    // Minimize
    consoleWindow.dataset.lastHeight = consoleWindow.offsetHeight + "px";
    consoleWindow.dataset.lastWidth = consoleWindow.offsetWidth + "px";
    consoleBody.style.display = "none";
    consoleWindow.style.height = "auto";
    consoleWindow.style.width = "300px";
    consoleWindow.style.resize = "none";
    buttonMinimizeConsole.innerText = "□";
    buttonMinimizeConsole.title = "Restore console window";
  }
}

function show_console() {
  if (!consoleWindow) return;
  consoleWindow.style.display = "flex";
  if (consoleBody && consoleBody.style.display === "none") {
    toggle_console_minimize();
  }
}

function make_console_movable() {
  if (!consoleWindow || !consoleHeader) return;

  let startX, startY, initialLeft, initialTop;

  consoleHeader.onmousedown = function (e) {
    e = e || window.event;
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();

    startX = e.clientX;
    startY = e.clientY;

    const rect = consoleWindow.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    consoleWindow.style.right = "auto";
    consoleWindow.style.bottom = "auto";
    consoleWindow.style.left = initialLeft + "px";
    consoleWindow.style.top = initialTop + "px";

    document.onmouseup = function () {
      document.onmouseup = null;
      document.onmousemove = null;
    };

    document.onmousemove = function (ev) {
      ev = ev || window.event;
      ev.preventDefault();

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      const newLeft = Math.max(0, Math.min(window.innerWidth - 120, initialLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, initialTop + dy));

      consoleWindow.style.left = newLeft + "px";
      consoleWindow.style.top = newTop + "px";
    };
  };
}

// -------------------------------------------------------------
// Interactive NH Profile D3 Plot & Simulation Controls
// -------------------------------------------------------------

let d3PlotData = {
  exp13: [],
  calc13: [],
  exp26: [],
  calc26: []
};

let d3PlotObj = {
  svg: null,
  gPlot: null,
  zoomBehavior: null,
  xOrig: null,
  yOrig: null,
  currentXScale: null,
  currentYScale: null,
  xAxisGroup: null,
  yAxisGroup: null,
  xGridGroup: null,
  yGridGroup: null,
  line13Path: null,
  line26Path: null,
  err13Path: null,
  err26Path: null,
  dots13Group: null,
  dots26Group: null,
  innerWidth: 0,
  innerHeight: 0,
  currentTransform: null
};

function positionPlotTooltip(event) {
  if (!d3PlotTooltip) return;
  const container = document.getElementById("interactiveProfilePlotContainer");
  if (!container) return;
  const rect = container.getBoundingClientRect();
  let x = event.clientX - rect.left + 12;
  let y = event.clientY - rect.top - 28;

  const tipWidth = d3PlotTooltip.offsetWidth || 140;
  const tipHeight = d3PlotTooltip.offsetHeight || 50;

  if (x + tipWidth > rect.width - 8) {
    x = event.clientX - rect.left - tipWidth - 12;
  }
  if (y < 8) {
    y = event.clientY - rect.top + 16;
  }
  if (y + tipHeight > rect.height - 8) {
    y = rect.height - tipHeight - 8;
  }

  d3PlotTooltip.style.left = `${Math.max(6, x)}px`;
  d3PlotTooltip.style.top = `${Math.max(6, y)}px`;
}

function showPlotTooltip(event, d, label) {
  if (!d3PlotTooltip) return;
  d3PlotTooltip.style.display = "block";
  const errText = (d.err !== undefined && d.err !== null && !isNaN(d.err))
    ? ` ± ${Number(d.err).toFixed(3)}`
    : "";
  d3PlotTooltip.innerHTML = `<strong>${label}</strong><br/>Offset: <b>${Number(d.x).toFixed(2)} ppm</b><br/>I/I₀: <b>${Number(d.y).toFixed(3)}</b>${errText}`;
  positionPlotTooltip(event);
}

function hidePlotTooltip() {
  if (d3PlotTooltip) d3PlotTooltip.style.display = "none";
}

function resetProfileZoom() {
  if (!d3PlotObj.xOrig || !d3PlotObj.yOrig || !d3PlotObj.currentXScale || !d3PlotObj.currentYScale) return;

  const startXDomain = [...d3PlotObj.currentXScale.domain()];
  const endXDomain = [...d3PlotObj.xOrig.domain()];
  const startYDomain = [...d3PlotObj.currentYScale.domain()];
  const endYDomain = [...d3PlotObj.yOrig.domain()];

  if (d3PlotObj.svg) {
    d3PlotObj.svg.transition("resetZoom")
      .duration(300)
      .tween("resetScales", () => {
        return function(t) {
          d3PlotObj.currentXScale.domain([
            startXDomain[0] + (endXDomain[0] - startXDomain[0]) * t,
            startXDomain[1] + (endXDomain[1] - startXDomain[1]) * t
          ]);
          d3PlotObj.currentYScale.domain([
            startYDomain[0] + (endYDomain[0] - startYDomain[0]) * t,
            startYDomain[1] + (endYDomain[1] - startYDomain[1]) * t
          ]);
          updateD3PlotElements();
        };
      });
  } else {
    d3PlotObj.currentXScale = d3PlotObj.xOrig.copy();
    d3PlotObj.currentYScale = d3PlotObj.yOrig.copy();
    updateD3PlotElements();
  }
}

function zoomScale(scale, origScale, pointerPos, factor) {
  if (!scale || !origScale) return false;
  const [v1, v2] = scale.domain();
  const origSpan = Math.abs(origScale.domain()[1] - origScale.domain()[0]);
  const currentSpan = Math.abs(v2 - v1);
  const newSpan = currentSpan / factor;

  // Zoom bounds: 0.5x to 50x
  if (factor > 1 && newSpan < origSpan / 50) return false;
  if (factor < 1 && newSpan > origSpan * 2.5) return false;

  const v0 = scale.invert(pointerPos);
  const newV1 = v0 + (v1 - v0) / factor;
  const newV2 = v0 + (v2 - v0) / factor;
  scale.domain([newV1, newV2]);
  return true;
}

function panScale(scale, pixelDelta) {
  if (!scale || !pixelDelta) return;
  const dDomain = scale.invert(0) - scale.invert(pixelDelta);
  const [v1, v2] = scale.domain();
  scale.domain([v1 + dDomain, v2 + dDomain]);
}

function renderProfileChart(exp13, calc13, exp26, calc26) {
  d3PlotData = {
    exp13: exp13 || [],
    calc13: calc13 || [],
    exp26: exp26 || [],
    calc26: calc26 || []
  };
  drawD3ProfilePlot(false);
}

function drawD3ProfilePlot(preserveTransform = false) {
  if (!interactiveProfilePlotDiv || typeof d3 === "undefined") return;

  const container = document.getElementById("interactiveProfilePlotContainer") || interactiveProfilePlotDiv;
  const containerWidth = container.clientWidth || 550;
  const containerHeight = container.clientHeight || 380;

  const margin = { top: 15, right: 25, bottom: 45, left: 55 };
  const innerWidth = Math.max(50, containerWidth - margin.left - margin.right);
  const innerHeight = Math.max(50, containerHeight - margin.top - margin.bottom);

  d3PlotObj.innerWidth = innerWidth;
  d3PlotObj.innerHeight = innerHeight;

  // Calculate scale domains
  const allPts = [
    ...d3PlotData.exp13,
    ...d3PlotData.calc13,
    ...d3PlotData.exp26,
    ...d3PlotData.calc26
  ];

  let xDomain;
  if (allPts.length > 0) {
    const minX = d3.min(allPts, d => d.x);
    const maxX = d3.max(allPts, d => d.x);
    const span = maxX - minX;
    const pad = span > 0 ? span * 0.05 : 2;
    // NMR standard: ppm descending (high ppm on left, low ppm on right)
    xDomain = [maxX + pad, minX - pad];
  } else {
    xDomain = [130, 90];
  }

  let yDomain;
  if (allPts.length > 0) {
    const minYVal = d3.min(allPts, d => (d.err ? d.y - d.err : d.y));
    const maxYVal = d3.max(allPts, d => (d.err ? d.y + d.err : d.y));
    yDomain = [
      Math.min(0, minYVal < 0 ? minYVal * 1.05 : 0),
      Math.max(1.15, (maxYVal || 1.0) * 1.08)
    ];
  } else {
    yDomain = [0, 1.15];
  }

  const xOrig = d3.scaleLinear().domain(xDomain).range([0, innerWidth]);
  const yOrig = d3.scaleLinear().domain(yDomain).range([innerHeight, 0]);

  d3PlotObj.xOrig = xOrig;
  d3PlotObj.yOrig = yOrig;

  if (preserveTransform && d3PlotObj.currentXScale && d3PlotObj.currentYScale) {
    d3PlotObj.currentXScale.range([0, innerWidth]);
    d3PlotObj.currentYScale.range([innerHeight, 0]);
  } else {
    d3PlotObj.currentXScale = xOrig.copy();
    d3PlotObj.currentYScale = yOrig.copy();
  }

  // Clear previous SVG
  d3.select(interactiveProfilePlotDiv).selectAll("svg").remove();

  const svg = d3.select(interactiveProfilePlotDiv)
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${containerWidth} ${containerHeight}`)
    .style("display", "block")
    .style("user-select", "none");

  d3PlotObj.svg = svg;

  // Clip-path for plotted data (prevents data from overflowing outside margins on zoom/pan)
  const clipId = "cest-profile-clip";
  const defs = svg.append("defs");
  defs.append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerWidth)
    .attr("height", innerHeight);

  const gPlot = svg.append("g")
    .attr("transform", `translate(${margin.left}, ${margin.top})`);
  d3PlotObj.gPlot = gPlot;

  // Interactive Background Rect
  gPlot.append("rect")
    .attr("class", "plot-bg")
    .attr("width", innerWidth)
    .attr("height", innerHeight)
    .attr("fill", "#ffffff");

  // Subtle grid lines
  d3PlotObj.xGridGroup = gPlot.append("g")
    .attr("class", "x-grid")
    .attr("transform", `translate(0, ${innerHeight})`)
    .style("color", "#f1f5f9");

  d3PlotObj.yGridGroup = gPlot.append("g")
    .attr("class", "y-grid")
    .style("color", "#f1f5f9");

  // Clipped layer for data elements
  const clippedLayer = gPlot.append("g")
    .attr("clip-path", `url(#${clipId})`)
    .style("cursor", "crosshair");

  // Error bars (paths)
  d3PlotObj.err13Path = clippedLayer.append("path")
    .attr("class", "err-bar-13")
    .attr("stroke", "#2563eb")
    .attr("stroke-width", 1.2)
    .attr("fill", "none")
    .attr("opacity", 0.65);

  d3PlotObj.err26Path = clippedLayer.append("path")
    .attr("class", "err-bar-26")
    .attr("stroke", "#dc2626")
    .attr("stroke-width", 1.2)
    .attr("fill", "none")
    .attr("opacity", 0.65);

  // Simulation curves (lines)
  d3PlotObj.line13Path = clippedLayer.append("path")
    .attr("class", "line-13")
    .attr("fill", "none")
    .attr("stroke", "#2563eb")
    .attr("stroke-width", 2);

  d3PlotObj.line26Path = clippedLayer.append("path")
    .attr("class", "line-26")
    .attr("fill", "none")
    .attr("stroke", "#dc2626")
    .attr("stroke-width", 2);

  // Scatter dots groups
  d3PlotObj.dots13Group = clippedLayer.append("g").attr("class", "dots-13");
  d3PlotObj.dots26Group = clippedLayer.append("g").attr("class", "dots-26");

  // Axes
  d3PlotObj.xAxisGroup = gPlot.append("g")
    .attr("class", "x-axis")
    .attr("transform", `translate(0, ${innerHeight})`);

  d3PlotObj.yAxisGroup = gPlot.append("g")
    .attr("class", "y-axis");

  // Axis Labels
  gPlot.append("text")
    .attr("class", "x-axis-label")
    .attr("text-anchor", "middle")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 36)
    .attr("fill", "#475569")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .text("B1 Offset (ppm)");

  gPlot.append("text")
    .attr("class", "y-axis-label")
    .attr("text-anchor", "middle")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -40)
    .attr("fill", "#475569")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .text("Intensity (I/I₀)");

  // -----------------------------------------------------------
  // Multi-Region Interaction Overlays:
  // 1. Plot Area: crosshair cursor, 2D zoom (wheel) & 2D pan (drag)
  // 2. Below X-Axis: ew-resize cursor, X-only zoom (wheel) & X-only pan (drag)
  // 3. Left of Y-Axis: ns-resize cursor, Y-only zoom (wheel) & Y-only pan (drag)
  // -----------------------------------------------------------

  const plotBox = gPlot.append("rect")
    .attr("class", "zoom-plot-box")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerWidth)
    .attr("height", innerHeight)
    .attr("fill", "transparent")
    .style("cursor", "crosshair")
    .style("pointer-events", "all");

  const xAxisBox = gPlot.append("rect")
    .attr("class", "zoom-x-box")
    .attr("x", 0)
    .attr("y", innerHeight)
    .attr("width", innerWidth)
    .attr("height", margin.bottom)
    .attr("fill", "transparent")
    .style("cursor", "ew-resize")
    .style("pointer-events", "all");

  const yAxisBox = gPlot.append("rect")
    .attr("class", "zoom-y-box")
    .attr("x", -margin.left)
    .attr("y", 0)
    .attr("width", margin.left)
    .attr("height", innerHeight)
    .attr("fill", "transparent")
    .style("cursor", "ns-resize")
    .style("pointer-events", "all");

  // Drag behaviors
  const dragPlot = d3.drag()
    .on("drag", function (event) {
      panScale(d3PlotObj.currentXScale, event.dx);
      panScale(d3PlotObj.currentYScale, event.dy);
      updateD3PlotElements();
    });
  plotBox.call(dragPlot);
  clippedLayer.call(dragPlot);

  const dragX = d3.drag()
    .on("drag", function (event) {
      panScale(d3PlotObj.currentXScale, event.dx);
      updateD3PlotElements();
    });
  xAxisBox.call(dragX);

  const dragY = d3.drag()
    .on("drag", function (event) {
      panScale(d3PlotObj.currentYScale, event.dy);
      updateD3PlotElements();
    });
  yAxisBox.call(dragY);

  // Wheel zoom handler across entire SVG (determines region from cursor position)
  svg.on("wheel", function (event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : (1 / 1.15);
    const [px, py] = d3.pointer(event, gPlot.node());

    const w = d3PlotObj.innerWidth;
    const h = d3PlotObj.innerHeight;

    let changed = false;
    if (py >= h) {
      // Cursor is below X axis: Zoom X ONLY
      changed = zoomScale(d3PlotObj.currentXScale, d3PlotObj.xOrig, px, factor);
    } else if (px <= 0) {
      // Cursor is on the left of Y axis: Zoom Y ONLY
      changed = zoomScale(d3PlotObj.currentYScale, d3PlotObj.yOrig, py, factor);
    } else if (px > 0 && px < w && py > 0 && py < h) {
      // Cursor is inside plot area: Zoom BOTH X and Y
      const zx = zoomScale(d3PlotObj.currentXScale, d3PlotObj.xOrig, px, factor);
      const zy = zoomScale(d3PlotObj.currentYScale, d3PlotObj.yOrig, py, factor);
      changed = zx || zy;
    }

    if (changed) {
      updateD3PlotElements();
    }
  }, { passive: false });

  // Double click anywhere resets zoom to full view
  svg.on("dblclick", function (event) {
    event.preventDefault();
    resetProfileZoom();
  });

  updateD3PlotElements();
}

function updateD3PlotElements() {
  if (!d3PlotObj.gPlot) return;

  const x = d3PlotObj.currentXScale || d3PlotObj.xOrig;
  const y = d3PlotObj.currentYScale || d3PlotObj.yOrig;
  const innerWidth = d3PlotObj.innerWidth;
  const innerHeight = d3PlotObj.innerHeight;

  // Update Axes
  if (d3PlotObj.xAxisGroup) {
    d3PlotObj.xAxisGroup.call(d3.axisBottom(x).ticks(8));
    d3PlotObj.xAxisGroup.select(".domain").attr("stroke", "#cbd5e1");
    d3PlotObj.xAxisGroup.selectAll(".tick line").attr("stroke", "#cbd5e1");
    d3PlotObj.xAxisGroup.selectAll("text").style("font-size", "10px").style("fill", "#475569");
  }
  if (d3PlotObj.yAxisGroup) {
    d3PlotObj.yAxisGroup.call(d3.axisLeft(y).ticks(6));
    d3PlotObj.yAxisGroup.select(".domain").attr("stroke", "#cbd5e1");
    d3PlotObj.yAxisGroup.selectAll(".tick line").attr("stroke", "#cbd5e1");
    d3PlotObj.yAxisGroup.selectAll("text").style("font-size", "10px").style("fill", "#475569");
  }

  // Update Grid lines
  if (d3PlotObj.xGridGroup) {
    d3PlotObj.xGridGroup.call(
      d3.axisBottom(x)
        .ticks(8)
        .tickSize(-innerHeight)
        .tickFormat("")
    );
    d3PlotObj.xGridGroup.select(".domain").remove();
    d3PlotObj.xGridGroup.selectAll("line").attr("stroke", "#f1f5f9").attr("stroke-dasharray", "3,3");
  }
  if (d3PlotObj.yGridGroup) {
    d3PlotObj.yGridGroup.call(
      d3.axisLeft(y)
        .ticks(6)
        .tickSize(-innerWidth)
        .tickFormat("")
    );
    d3PlotObj.yGridGroup.select(".domain").remove();
    d3PlotObj.yGridGroup.selectAll("line").attr("stroke", "#f1f5f9").attr("stroke-dasharray", "3,3");
  }

  // Line Generator
  const lineGen = d3.line()
    .defined(d => d && !isNaN(d.x) && !isNaN(d.y))
    .x(d => x(d.x))
    .y(d => y(d.y))
    .curve(d3.curveLinear);

  if (d3PlotObj.line13Path) {
    d3PlotObj.line13Path.datum(d3PlotData.calc13).attr("d", lineGen);
  }
  if (d3PlotObj.line26Path) {
    d3PlotObj.line26Path.datum(d3PlotData.calc26).attr("d", lineGen);
  }

  // Error Bar Path Generator
  const capW = 3;
  const buildErrPath = (pts) => {
    if (!pts || !pts.length) return "";
    return pts
      .filter(d => d.err !== undefined && d.err !== null && d.err > 0 && !isNaN(d.err))
      .map(d => {
        const px = x(d.x);
        const yTop = y(d.y + d.err);
        const yBot = y(d.y - d.err);
        return `M ${px} ${yTop} L ${px} ${yBot} M ${px - capW} ${yTop} L ${px + capW} ${yTop} M ${px - capW} ${yBot} L ${px + capW} ${yBot}`;
      })
      .join(" ");
  };

  if (d3PlotObj.err13Path) {
    d3PlotObj.err13Path.attr("d", buildErrPath(d3PlotData.exp13));
  }
  if (d3PlotObj.err26Path) {
    d3PlotObj.err26Path.attr("d", buildErrPath(d3PlotData.exp26));
  }

  // Scatter points 13 Hz
  if (d3PlotObj.dots13Group) {
    const dots13 = d3PlotObj.dots13Group.selectAll("circle.dot-13")
      .data(d3PlotData.exp13, d => d.x);

    dots13.enter()
      .append("circle")
      .attr("class", "dot-13")
      .attr("r", 3.5)
      .attr("fill", "#2563eb")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 1)
      .on("mouseenter", function (e, d) {
        d3.select(this).attr("r", 5.5);
        showPlotTooltip(e, d, "13 Hz Data");
      })
      .on("mousemove", (e) => positionPlotTooltip(e))
      .on("mouseleave", function () {
        d3.select(this).attr("r", 3.5);
        hidePlotTooltip();
      })
      .merge(dots13)
      .attr("cx", d => x(d.x))
      .attr("cy", d => y(d.y));

    dots13.exit().remove();
  }

  // Scatter points 26 Hz
  if (d3PlotObj.dots26Group) {
    const dots26 = d3PlotObj.dots26Group.selectAll("circle.dot-26")
      .data(d3PlotData.exp26, d => d.x);

    dots26.enter()
      .append("circle")
      .attr("class", "dot-26")
      .attr("r", 3.5)
      .attr("fill", "#dc2626")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 1)
      .on("mouseenter", function (e, d) {
        d3.select(this).attr("r", 5.5);
        showPlotTooltip(e, d, "26 Hz Data");
      })
      .on("mousemove", (e) => positionPlotTooltip(e))
      .on("mouseleave", function () {
        d3.select(this).attr("r", 3.5);
        hidePlotTooltip();
      })
      .merge(dots26)
      .attr("cx", d => x(d.x))
      .attr("cy", d => y(d.y));

    dots26.exit().remove();
  }
}

function updateProfileChartLines(calc13, calc26) {
  d3PlotData.calc13 = calc13 || [];
  d3PlotData.calc26 = calc26 || [];

  if (!d3PlotObj.line13Path || !d3PlotObj.line26Path) {
    drawD3ProfilePlot(true);
    return;
  }

  const x = d3PlotObj.currentXScale || d3PlotObj.xOrig;
  const y = d3PlotObj.currentYScale || d3PlotObj.yOrig;
  if (!x || !y) return;

  const lineGen = d3.line()
    .defined(d => d && !isNaN(d.x) && !isNaN(d.y))
    .x(d => x(d.x))
    .y(d => y(d.y))
    .curve(d3.curveLinear);

  d3PlotObj.line13Path.datum(d3PlotData.calc13).attr("d", lineGen);
  d3PlotObj.line26Path.datum(d3PlotData.calc26).attr("d", lineGen);
}

function getParamValuesFromUI() {
  return {
    PB: parseFloat(num_PB ? num_PB.value : 0.015) || 0.015,
    KEX_AB: parseFloat(num_KEX ? num_KEX.value : 70.0) || 70.0,
    CS_A: parseFloat(num_CS ? num_CS.value : 108.0) || 108.0,
    DW_AB: parseFloat(num_DW ? num_DW.value : 4.0) || 4.0,
    TAUC_A: parseFloat(num_TAUC ? num_TAUC.value : 10.0) || 10.0
  };
}

function setParamValuesToUI(params) {
  if (!params) return;
  if (params.PB !== undefined && num_PB && slider_PB) {
    num_PB.value = Number(params.PB).toFixed(3);
    slider_PB.value = params.PB;
  }
  if (params.KEX_AB !== undefined && num_KEX && slider_KEX) {
    num_KEX.value = Math.round(params.KEX_AB);
    slider_KEX.value = params.KEX_AB;
  }
  if (params.CS_A !== undefined && num_CS && slider_CS) {
    const csVal = parseFloat(params.CS_A);
    num_CS.value = csVal.toFixed(2);
    slider_CS.min = (csVal - 4.0).toFixed(2);
    slider_CS.max = (csVal + 4.0).toFixed(2);
    slider_CS.value = csVal.toFixed(2);
  }
  if (params.DW_AB !== undefined && num_DW && slider_DW) {
    const dwVal = parseFloat(params.DW_AB);
    num_DW.value = dwVal.toFixed(1);
    slider_DW.value = dwVal;
  }
  if (params.TAUC_A !== undefined && num_TAUC) {
    num_TAUC.value = parseFloat(params.TAUC_A).toFixed(1);
  }
}

function triggerInteractiveSimulation() {
  if (!worker || !isReady || isRunning || isInteractiveFitting) return;
  if (simDebounceTimer) clearTimeout(simDebounceTimer);

  if (simLiveBadge) {
    simLiveBadge.textContent = "Calculating...";
    simLiveBadge.style.background = "#fef3c7";
    simLiveBadge.style.color = "#92400e";
  }

  simDebounceTimer = setTimeout(() => {
    const residue = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
    const params = getParamValuesFromUI();
    worker.postMessage({
      type: "simulate_residue",
      residue: residue,
      params: params
    });
  }, 35);
}

function bindSliderAndInput(slider, numInput) {
  if (!slider || !numInput) return;
  slider.addEventListener("input", () => {
    numInput.value = slider.value;
    if (paramStatusTag) paramStatusTag.textContent = "Modified by user";
    triggerInteractiveSimulation();
  });
  numInput.addEventListener("input", () => {
    slider.value = numInput.value;
    if (paramStatusTag) paramStatusTag.textContent = "Modified by user";
    triggerInteractiveSimulation();
  });
}

function loadInteractiveResidue(residue) {
  if (!worker || !isReady) return;
  if (fitResultNotice) fitResultNotice.style.display = "none";
  if (paramStatusTag) paramStatusTag.textContent = "Loading...";
  if (btnFitFromParams) btnFitFromParams.disabled = true;

  worker.postMessage({
    type: "get_residue_data",
    residue: residue
  });
}

function fitFromCurrentParams() {
  if (!worker || !isReady || isRunning || isInteractiveFitting) return;

  const residue = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
  const params = getParamValuesFromUI();

  isInteractiveFitting = true;
  setRunningState(true);

  if (btnFitFromParams) {
    btnFitFromParams.disabled = true;
    btnFitFromParams.textContent = `⏳ Fitting ${residue}...`;
  }
  if (fitResultNotice) {
    fitResultNotice.style.display = "block";
    fitResultNotice.style.background = "#eff6ff";
    fitResultNotice.style.borderColor = "#bfdbfe";
    fitResultNotice.style.color = "#1e40af";
    fitResultNotice.textContent = `Running ChemEx fit for ${residue} starting from your custom parameters... (see console for details)`;
  }

  appendConsole(`\n========================================================\n> Fitting residue ${residue} starting from user parameters:\n> PB = ${params.PB}, KEX_AB = ${params.KEX_AB}, CS_A = ${params.CS_A}, DW_AB = ${params.DW_AB}\n========================================================\n`);
  show_console();

  worker.postMessage({
    type: "fit_from_user_params",
    residue: residue,
    params: params,
    outputDir: "Output"
  });
}

// -------------------------------------------------------------
// Web Worker Initialization and Communication
// -------------------------------------------------------------

function initChemexWorker() {
  if (!window.Worker) {
    showError("Your browser does not support Web Workers.");
    if (statusText) statusText.textContent = "❌ Error: Web Workers unsupported.";
    return;
  }

  if (pythonStdout) {
    pythonStdout.textContent = "Spawning ChemEx Web Worker (js/chemex_worker.js)...\n";
  }

  try {
    worker = new Worker("js/chemex_worker.js?t=" + Date.now());
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerError;

    // Tell worker to initialize Pyodide runtime & packages
    worker.postMessage({ type: "init" });
  } catch (err) {
    console.error("Worker spawn error:", err);
    showError("Could not start Web Worker: " + err.message);
  }
}

function handleWorkerMessage(e) {
  const data = e.data || {};

  switch (data.type) {
    case "status":
      if (statusText) statusText.textContent = data.text;
      break;

    case "stdout":
      appendConsole(data.text);
      break;

    case "stderr":
      appendConsole(data.text);
      break;

    case "ready":
      isReady = true;
      if (statusBar) statusBar.className = "status-bar ready";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = `✅ Ready! Python ${data.pythonVersion} | ChemEx v${data.chemexVersion} | MEMFS populated with CEST_15N`;
      }
      if (btnRunFit) btnRunFit.disabled = false;
      if (btnRunSim) btnRunSim.disabled = false;
      if (btnWriteFs) btnWriteFs.disabled = false;

      if (fsStatusBadge) {
        fsStatusBadge.className = "status-bar ready";
        fsStatusBadge.textContent = `✅ ${data.filesWritten} files loaded in MEMFS (CEST_15N/)`;
      }

      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);

      // Automatically load the initial residue for interactive simulation
      const initialRes = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
      loadInteractiveResidue(initialRes);
      break;

    case "residue_data_result":
      if (data.data && data.data.status === "success") {
        const res = data.data;
        currentResidueDefaults = { ...res.params };
        setParamValuesToUI(res.params);
        renderProfileChart(res.exp_13hz, res.calc_13hz, res.exp_26hz, res.calc_26hz);

        if (btnFitFromParams) btnFitFromParams.disabled = false;
        if (paramStatusTag) paramStatusTag.textContent = "Initial guess (Parameters.toml)";
        if (simLiveBadge) {
          simLiveBadge.textContent = "Simulating on-the-fly";
          simLiveBadge.style.background = "#e0f2fe";
          simLiveBadge.style.color = "#0369a1";
        }
      }
      break;

    case "simulation_update_result":
      if (data.data && data.data.status === "success") {
        updateProfileChartLines(data.data.calc_13hz, data.data.calc_26hz);
        if (simLiveBadge) {
          simLiveBadge.textContent = "Updated on-the-fly";
          simLiveBadge.style.background = "#dcfce7";
          simLiveBadge.style.color = "#166534";
        }
      }
      break;

    case "fit_complete_with_params":
      isInteractiveFitting = false;
      setRunningState(false);
      if (btnFitFromParams) {
        btnFitFromParams.disabled = false;
        btnFitFromParams.textContent = "⚡ Fit from Current Parameters";
      }

      if (data.data) {
        const res = data.data;
        // Update chart lines with newly fitted curves
        updateProfileChartLines(res.calc_13hz, res.calc_26hz);

        // Update parameters if fitted results found
        if (res.fitted_params) {
          const fp = res.fitted_params;
          const updated = {};
          if (fp.PB) updated.PB = fp.PB.value;
          if (fp.KEX_AB) updated.KEX_AB = fp.KEX_AB.value;
          if (fp.CS_A) updated.CS_A = fp.CS_A.value;
          if (fp.DW_AB) updated.DW_AB = fp.DW_AB.value;
          setParamValuesToUI(updated);
        }

        if (paramStatusTag) paramStatusTag.textContent = "✅ Fitted Result";
        if (fitResultNotice) {
          fitResultNotice.style.display = "block";
          fitResultNotice.style.background = "#ecfdf5";
          fitResultNotice.style.borderColor = "#a7f3d0";
          fitResultNotice.style.color = "#065f46";

          let noticeText = `✅ Fit completed successfully for ${data.residue}!`;
          if (res.fitted_params) {
            const parts = [];
            if (res.fitted_params.PB) parts.push(`pB = ${res.fitted_params.PB.value.toFixed(4)}`);
            if (res.fitted_params.KEX_AB) parts.push(`kex = ${res.fitted_params.KEX_AB.value.toFixed(1)} s⁻¹`);
            if (res.fitted_params.DW_AB) parts.push(`Δϖ = ${res.fitted_params.DW_AB.value.toFixed(2)} ppm`);
            if (parts.length > 0) noticeText += " (" + parts.join(", ") + ")";
          }
          fitResultNotice.textContent = noticeText;
        }

        if (res.virtual_files) {
          currentVirtualFiles = res.virtual_files;
          renderVirtualFilesList(currentVirtualFiles);
        }
        if (res.run_result && res.run_result.output_files) {
          displayOutputFiles(data.outputDir, res.run_result.output_files);
        }
      }
      break;

    case "user_fit_error":
      isInteractiveFitting = false;
      setRunningState(false);
      if (btnFitFromParams) {
        btnFitFromParams.disabled = false;
        btnFitFromParams.textContent = "⚡ Fit from Current Parameters";
      }
      showError(`Fit error: ${data.error}`);
      if (fitResultNotice) {
        fitResultNotice.style.display = "block";
        fitResultNotice.style.background = "#fee2e2";
        fitResultNotice.style.borderColor = "#fecaca";
        fitResultNotice.style.color = "#991b1b";
        fitResultNotice.textContent = `❌ Error during fit: ${data.error}`;
      }
      break;

    case "residue_data_error":
      console.warn("Could not load residue data:", data.error);
      if (paramStatusTag) paramStatusTag.textContent = "Error loading";
      break;

    case "dataset_synced":
      if (fsStatusBadge) {
        fsStatusBadge.className = "status-bar ready";
        fsStatusBadge.textContent = `✅ ${data.count} files synced to MEMFS (CEST_15N/)`;
      }
      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);
      break;

    case "run_complete":
      isRunning = false;
      setRunningState(false);
      if (statusBar) statusBar.className = "status-bar ready";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = `✅ Full ChemEx fit completed! Output saved to '${data.outputDir}/'`;
      }
      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);
      displayOutputFiles(data.outputDir, data.result ? data.result.output_files || [] : []);

      // Reload initial guesses and simulation profile for the currently selected residue from updated Parameters.toml
      const currentRes = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
      loadInteractiveResidue(currentRes);
      if (paramStatusTag) {
        paramStatusTag.textContent = "✅ Updated from Full Fit";
      }
      if (fitResultNotice) {
        fitResultNotice.style.display = "block";
        fitResultNotice.style.background = "#ecfdf5";
        fitResultNotice.style.borderColor = "#a7f3d0";
        fitResultNotice.style.color = "#065f46";
        fitResultNotice.textContent = `✅ Full ChemEx fit completed across all residues! Optimized parameters have been saved to Parameters.toml and applied to the initial guesses.`;
      }
      break;

    case "run_error":
      isRunning = false;
      setRunningState(false);
      if (statusBar) statusBar.className = "status-bar error";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = "❌ ChemEx execution error (see console output)";
      }
      showError(data.error);
      appendConsole(`\n❌ Error: ${data.error}\n`);
      show_console();
      break;

    case "file_content":
      handleFileContentResponse(data);
      break;

    case "file_error":
      showError(`Could not read file ${data.filename}: ${data.error}`);
      break;

    case "init_error":
      if (statusBar) statusBar.className = "status-bar error";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) statusText.textContent = "❌ Initialization failed: " + data.error;
      showError(data.error);
      break;

    default:
      console.log("Worker message received:", data);
  }
}

function handleWorkerError(err) {
  console.error("Worker error:", err);
  if (statusBar) statusBar.className = "status-bar error";
  if (statusSpinner) statusSpinner.style.display = "none";
  if (statusText) statusText.textContent = "❌ Worker error: " + (err.message || "Unknown error");
  showError("Worker encountered an error: " + (err.message || err));
}

// -------------------------------------------------------------
// Virtual Filesystem & File Viewer Helpers
// -------------------------------------------------------------

function renderVirtualFilesList(files) {
  if (!virtualFilesList) return;
  if (!files || files.length === 0) {
    virtualFilesList.innerHTML = `<span style="color: var(--text-muted); font-style: italic;">No files in virtual filesystem yet</span>`;
    return;
  }

  const items = files.map(f => {
    const isOut = f.startsWith("Output/") || f.startsWith("OutputSim/");
    const color = isOut ? "#16a34a" : "#2563eb";
    return `<div style="padding: 2px 0;"><span style="color: ${color};">📄 ${f}</span></div>`;
  });
  virtualFilesList.innerHTML = items.join("");
}

function displayOutputFiles(outputDir, fileList) {
  if (!outputFilesCard || !outputFilesBadges) return;

  outputFilesCard.style.display = "block";
  outputFilesBadges.innerHTML = "";

  if (!fileList || fileList.length === 0) {
    outputFilesBadges.innerHTML = `<span style="color: var(--text-muted);">No output files detected in ${outputDir}</span>`;
    return;
  }

  fileList.forEach(filename => {
    const isPdf = filename.toLowerCase().endsWith(".pdf");
    const badge = document.createElement("button");
    badge.className = "btn-secondary file-badge";
    badge.textContent = `${isPdf ? "📊" : "📄"} ${filename}`;
    badge.style.fontSize = "0.85rem";
    badge.style.padding = "6px 12px";

    badge.addEventListener("click", () => {
      requestVirtualFile(outputDir, filename);
    });

    outputFilesBadges.appendChild(badge);
  });

  // Automatically request view of parameters.fit or the first output file
  const defaultFile = fileList.find(f => f.endsWith("parameters.fit") || f.endsWith(".fit") || f.endsWith(".toml")) || fileList[0];
  if (defaultFile) {
    requestVirtualFile(outputDir, defaultFile);
  }
}

function requestVirtualFile(outputDir, filename) {
  if (!worker) return;
  if (fileViewerContainer && fileViewerTitle) {
    fileViewerContainer.style.display = "block";
    fileViewerTitle.textContent = `Loading CEST_15N/${outputDir}/${filename}...`;
  }
  worker.postMessage({
    type: "read_file",
    outputDir: outputDir,
    filename: filename
  });
}

function handleFileContentResponse(data) {
  const { outputDir, filename, isBinary, content } = data;
  const fullRelPath = `${outputDir}/${filename}`;

  if (currentSelectedFile && currentSelectedFile.blobUrl) {
    URL.revokeObjectURL(currentSelectedFile.blobUrl);
  }

  if (isBinary) {
    const binStr = atob(content);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);

    currentSelectedFile = {
      path: fullRelPath,
      filename: filename,
      isBinary: true,
      bytes: bytes,
      blob: blob,
      blobUrl: blobUrl,
      mimeType: "application/pdf"
    };

    if (fileViewerContainer && fileViewerTitle) {
      fileViewerContainer.style.display = "block";
      fileViewerTitle.textContent = `CEST_15N/${fullRelPath} (PDF Document, ${(bytes.length / 1024).toFixed(1)} KB)`;
    }

    if (fileViewerPre) fileViewerPre.style.display = "none";
    if (fileViewerPdf) {
      fileViewerPdf.style.display = "block";
      fileViewerPdf.src = blobUrl;
    }
    if (btnOpenPdfNewTab) {
      btnOpenPdfNewTab.style.display = "inline-flex";
      btnOpenPdfNewTab.href = blobUrl;
    }
    if (btnDownloadFile) {
      btnDownloadFile.textContent = "⬇ Download PDF";
    }
  } else {
    currentSelectedFile = {
      path: fullRelPath,
      filename: filename,
      isBinary: false,
      content: content,
      mimeType: "text/plain;charset=utf-8"
    };

    if (fileViewerContainer && fileViewerTitle && fileViewerContent) {
      fileViewerContainer.style.display = "block";
      fileViewerTitle.textContent = `CEST_15N/${fullRelPath} (Virtual MEMFS)`;
      fileViewerContent.textContent = content;
    }

    if (fileViewerPdf) {
      fileViewerPdf.style.display = "none";
      fileViewerPdf.src = "";
    }
    if (btnOpenPdfNewTab) {
      btnOpenPdfNewTab.style.display = "none";
    }
    if (fileViewerPre) {
      fileViewerPre.style.display = "block";
    }
    if (btnDownloadFile) {
      btnDownloadFile.textContent = "⬇ Download File";
    }
  }
}

function downloadSelectedFile() {
  if (!currentSelectedFile) return;

  const downloadFilename = currentSelectedFile.filename.split("/").pop() || "download";
  let blob;
  if (currentSelectedFile.isBinary) {
    blob = currentSelectedFile.blob || new Blob([currentSelectedFile.bytes], { type: currentSelectedFile.mimeType });
  } else {
    blob = new Blob([currentSelectedFile.content], { type: currentSelectedFile.mimeType || "text/plain;charset=utf-8" });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------
// Execution & UI Controls
// -------------------------------------------------------------

function setRunningState(running) {
  if (btnRunFit) btnRunFit.disabled = running;
  if (btnWriteFs) btnWriteFs.disabled = running;
  if (btnFitFromParams) btnFitFromParams.disabled = running;
  if (interactiveResidueSelect) interactiveResidueSelect.disabled = running;
}

function executeChemex(command = "fit") {
  if (!isReady || !worker || isRunning) return;

  hideError();
  isRunning = true;
  setRunningState(true);

  const outputDir = "Output";

  if (statusBar) statusBar.className = "status-bar loading";
  if (statusSpinner) statusSpinner.style.display = "inline-block";
  if (statusText) {
    statusText.textContent = "Running full ChemEx fit across all 16 residues... Output streaming to console.";
  }

  appendConsole("\n========================================================\n> Executing Full Global ChemEx Fit across all 16 residues (run.sh)\n========================================================\n");
  show_console();

  worker.postMessage({
    type: "run_chemex",
    command: "fit",
    includeResidue: null,
    outputDir: outputDir
  });
}

function syncCestDataset() {
  if (!worker || isRunning) return;
  if (fsStatusBadge) {
    fsStatusBadge.className = "status-bar loading";
    fsStatusBadge.textContent = "Syncing dataset to MEMFS...";
  }
  worker.postMessage({ type: "sync_dataset" });
}

function showError(msg) {
  if (errorAlert) {
    errorAlert.textContent = "Error: " + msg;
    errorAlert.style.display = "block";
  }
}

function hideError() {
  if (errorAlert) {
    errorAlert.style.display = "none";
    errorAlert.textContent = "";
  }
}

// -------------------------------------------------------------
// Event Listeners & Startup
// -------------------------------------------------------------

// Sliders and Number Inputs bindings
bindSliderAndInput(slider_PB, num_PB);
bindSliderAndInput(slider_KEX, num_KEX);
bindSliderAndInput(slider_CS, num_CS);
bindSliderAndInput(slider_DW, num_DW);
if (num_TAUC) num_TAUC.addEventListener("input", triggerInteractiveSimulation);

// Interactive Residue Select change
if (interactiveResidueSelect) {
  interactiveResidueSelect.addEventListener("change", (e) => {
    const res = e.target.value;
    loadInteractiveResidue(res);
  });
}

if (btnReloadResidue) {
  btnReloadResidue.addEventListener("click", () => {
    const res = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
    loadInteractiveResidue(res);
  });
}

if (btnFitFromParams) {
  btnFitFromParams.addEventListener("click", fitFromCurrentParams);
}

if (btnResetParams) {
  btnResetParams.addEventListener("click", () => {
    if (currentResidueDefaults) {
      setParamValuesToUI(currentResidueDefaults);
      if (paramStatusTag) paramStatusTag.textContent = "Reset to defaults";
      triggerInteractiveSimulation();
    }
  });
}

if (btnRunFit) btnRunFit.addEventListener("click", () => executeChemex("fit"));
if (btnWriteFs) btnWriteFs.addEventListener("click", syncCestDataset);
if (btnDownloadFile) btnDownloadFile.addEventListener("click", downloadSelectedFile);
if (btnToggleConsole) btnToggleConsole.addEventListener("click", toggle_console_minimize);
if (btnResetPlotZoom) btnResetPlotZoom.addEventListener("click", resetProfileZoom);

// Observe container resizing to keep SVG responsive
if (typeof ResizeObserver !== "undefined" && interactiveProfilePlotDiv) {
  const resizeObserver = new ResizeObserver(entries => {
    for (let entry of entries) {
      if (entry.contentRect.width > 0 && d3PlotData.exp13.length > 0) {
        drawD3ProfilePlot(true);
      }
    }
  });
  resizeObserver.observe(interactiveProfilePlotDiv);
}

window.addEventListener("DOMContentLoaded", () => {
  updateCommandDisplay();
  make_console_movable();
  initChemexWorker();

  fetch("navbar.html")
    .then(res => (res.ok ? res.text() : ""))
    .then(html => {
      const el = document.getElementById("navbar-placeholder");
      if (el) el.innerHTML = html;
    })
    .catch(() => {});
});
