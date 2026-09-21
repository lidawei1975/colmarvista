

/**
 * Create a table from a cpeaks object
 * @param {*} peak: a cpeaks object (defined in peaks.js)  
 * @param {*} table: the HTML table elements to be filled

 * @returns 
 */
function createTable_from_peak(peak, table) {
   
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const thead_row = document.createElement("tr");

    if (peak.columns.length === 0 || peak.columns[0].length === 0) return; // Handle empty data

    /**
     * Create table headers from the peak.column_headers array
     * 1. Keep the index of the column_headers of "ASS"
     * 2. Keep an array of all selected column headers (exclude X1,X3,Y1,Y3,POINTER)
     * 3. Group all headers starting with "Z_A" into a scrollable container limited to 5 columns
     */
    const excluded_headers = ["X1", "X3", "Y1", "Y3", "POINTER", 'DHEIGHT', 'X_AXIS', 'Y_AXIS', 'CLUSTID'];
    let selected_headers = [];
    let za_headers = [];
    const headers = peak.column_headers;
    let ass_index;

    headers.forEach((headerText, ndx) => {
        if (excluded_headers.includes(headerText) === false) {
            if (headerText.startsWith("Z_A")) {
                za_headers.push({ headerText: headerText, index: ndx });
            } else {
                const header = document.createElement("th");
                header.textContent = headerText;
                thead_row.appendChild(header);
                if (headerText === "ASS") {
                    ass_index = ndx;
                }
                selected_headers.push(ndx);
            }
        }
    });

    let headerScroll = null;
    const za_col_width = 80;

    // If there are Z_A headers, create the grouped scrollable Z_A header cell
    if (za_headers.length > 0) {
        const za_th = document.createElement("th");
        za_th.setAttribute("data-sort-method", "none");
        za_th.style.padding = "0";
        za_th.style.verticalAlign = "top";
        za_th.style.backgroundColor = "rgb(228, 240, 245)";
        za_th.style.border = "1px solid rgb(160, 160, 160)";

        const visible_count = Math.min(5, za_headers.length);
        const container_width = visible_count * za_col_width;

        const za_top_bar = document.createElement("div");
        za_top_bar.style.display = "flex";
        za_top_bar.style.justifyContent = "space-between";
        za_top_bar.style.alignItems = "center";
        za_top_bar.style.padding = "3px 6px";
        za_top_bar.style.backgroundColor = "rgb(210, 225, 235)";
        za_top_bar.style.borderBottom = "1px solid rgb(160, 160, 160)";
        za_top_bar.style.fontSize = "11px";
        za_top_bar.style.fontWeight = "bold";

        const infoSpan = document.createElement("span");
        infoSpan.className = "za_scroll_info";
        infoSpan.style.whiteSpace = "nowrap";
        infoSpan.textContent = "Z_A Planes (1–" + visible_count + " of " + za_headers.length + ")";

        const prevBtn = document.createElement("button");
        prevBtn.type = "button";
        prevBtn.textContent = "◀";
        prevBtn.title = "Previous 5 planes";
        prevBtn.style.cursor = "pointer";
        prevBtn.style.padding = "1px 6px";
        prevBtn.style.fontSize = "10px";
        prevBtn.style.lineHeight = "14px";
        prevBtn.style.borderRadius = "3px";
        prevBtn.style.border = "1px solid #999";

        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.textContent = "▶";
        nextBtn.title = "Next 5 planes";
        nextBtn.style.cursor = "pointer";
        nextBtn.style.padding = "1px 6px";
        nextBtn.style.fontSize = "10px";
        nextBtn.style.lineHeight = "14px";
        nextBtn.style.borderRadius = "3px";
        nextBtn.style.border = "1px solid #999";

        if (za_headers.length > 5) {
            za_top_bar.appendChild(prevBtn);
            za_top_bar.appendChild(infoSpan);
            za_top_bar.appendChild(nextBtn);
        } else {
            infoSpan.textContent = "Z_A Planes (" + za_headers.length + ")";
            za_top_bar.style.justifyContent = "center";
            za_top_bar.appendChild(infoSpan);
        }

        headerScroll = document.createElement("div");
        headerScroll.className = "za_header_scroll";
        headerScroll.style.display = "flex";
        headerScroll.style.overflowX = za_headers.length > 5 ? "auto" : "hidden";
        headerScroll.style.overflowY = "hidden";
        headerScroll.style.width = container_width + "px";
        headerScroll.style.maxWidth = container_width + "px";
        headerScroll.style.boxSizing = "border-box";
        headerScroll.style.scrollbarWidth = "thin";

        const headerTrack = document.createElement("div");
        headerTrack.style.display = "flex";
        headerTrack.style.width = (za_headers.length * za_col_width) + "px";

        za_headers.forEach((h, idx) => {
            const headCell = document.createElement("div");
            headCell.textContent = h.headerText;
            headCell.title = "Click to sort by " + h.headerText;
            headCell.style.width = za_col_width + "px";
            headCell.style.minWidth = za_col_width + "px";
            headCell.style.flexShrink = "0";
            headCell.style.textAlign = "center";
            headCell.style.padding = "6px 2px";
            headCell.style.fontWeight = "bold";
            headCell.style.borderRight = idx < za_headers.length - 1 ? "1px solid rgb(180, 180, 180)" : "none";
            headCell.style.boxSizing = "border-box";
            headCell.style.cursor = "pointer";
            headCell.style.userSelect = "none";

            headCell.addEventListener("click", (e) => {
                e.stopPropagation();
                sortRowsByZaIndex(table, h.index, idx);
            });
            headerTrack.appendChild(headCell);
        });

        headerScroll.appendChild(headerTrack);

        const za_header_wrapper = document.createElement("div");
        za_header_wrapper.style.width = container_width + "px";
        za_header_wrapper.style.maxWidth = container_width + "px";
        za_header_wrapper.style.boxSizing = "border-box";
        za_header_wrapper.appendChild(za_top_bar);
        za_header_wrapper.appendChild(headerScroll);
        za_th.appendChild(za_header_wrapper);
        thead_row.appendChild(za_th);

        if (za_headers.length > 5) {
            prevBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                headerScroll.scrollBy({ left: -za_col_width * 5, behavior: "smooth" });
            });

            nextBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                headerScroll.scrollBy({ left: za_col_width * 5, behavior: "smooth" });
            });

            headerScroll.addEventListener("scroll", () => {
                const scrollLeft = headerScroll.scrollLeft;
                const rows = tbody.querySelectorAll(".za_row_scroll");
                for (let k = 0; k < rows.length; k++) {
                    rows[k].scrollLeft = scrollLeft;
                }
                const start = Math.floor(scrollLeft / za_col_width) + 1;
                const end = Math.min(start + 4, za_headers.length);
                infoSpan.textContent = "Z_A Planes (" + start + "–" + end + " of " + za_headers.length + ")";
            }, { passive: true });
        }
    }

    thead.appendChild(thead_row);

    /**
     * Create table rows from the peak.columns array
     */
    const num_rows = peak.columns[0].length;
    const visible_count = Math.min(5, za_headers.length);
    const container_width = visible_count * za_col_width;

    for (let i = 0; i < num_rows; i++) {
        const row = document.createElement("tr");

        // Standard non-Z_A columns
        for (let j = 0; j < selected_headers.length; j++) {
            const cell = document.createElement("td");
            let text = peak.format_value(peak.columns[selected_headers[j]][i], peak.column_formats[selected_headers[j]]);
            cell.textContent = text;
            if (selected_headers[j] === ass_index) {
                cell.classList.add("editable_cell");
            }
            row.appendChild(cell);
        }

        // Z_A grouped columns
        if (za_headers.length > 0) {
            const za_td = document.createElement("td");
            za_td.style.padding = "0";
            za_td.style.verticalAlign = "middle";
            za_td.style.border = "1px solid rgb(160, 160, 160)";

            const rowScroll = document.createElement("div");
            rowScroll.className = "za_row_scroll";
            rowScroll.style.display = "flex";
            rowScroll.style.overflowX = "hidden";
            rowScroll.style.overflowY = "hidden";
            rowScroll.style.width = container_width + "px";
            rowScroll.style.maxWidth = container_width + "px";
            rowScroll.style.boxSizing = "border-box";

            const rowTrack = document.createElement("div");
            rowTrack.style.display = "flex";
            rowTrack.style.width = (za_headers.length * za_col_width) + "px";

            za_headers.forEach((h, idx) => {
                const valCell = document.createElement("div");
                const valText = peak.format_value(peak.columns[h.index][i], peak.column_formats[h.index]);
                valCell.textContent = valText;
                valCell.style.width = za_col_width + "px";
                valCell.style.minWidth = za_col_width + "px";
                valCell.style.flexShrink = "0";
                valCell.style.textAlign = "right";
                valCell.style.padding = "8px 8px";
                valCell.style.borderRight = idx < za_headers.length - 1 ? "1px solid rgb(220, 220, 220)" : "none";
                valCell.style.boxSizing = "border-box";
                valCell.style.whiteSpace = "nowrap";
                valCell.style.overflow = "hidden";
                valCell.style.textOverflow = "ellipsis";
                rowTrack.appendChild(valCell);
            });

            rowScroll.appendChild(rowTrack);
            za_td.appendChild(rowScroll);
            row.appendChild(za_td);
        }

        tbody.appendChild(row);
    }

    table.appendChild(thead);
    table.appendChild(tbody);

    // Keep horizontal scroll synchronized when Tablesort or other mechanisms reorder rows
    if (za_headers.length > 5 && headerScroll) {
        table.addEventListener("afterSort", () => {
            const scrollLeft = headerScroll.scrollLeft;
            const rows = tbody.querySelectorAll(".za_row_scroll");
            for (let k = 0; k < rows.length; k++) {
                rows[k].scrollLeft = scrollLeft;
            }
        });

        // Also allow horizontal mouse wheel scrolling over tbody rows
        tbody.addEventListener("wheel", (e) => {
            if (e.target && e.target.closest && e.target.closest(".za_row_scroll")) {
                if (e.deltaX !== 0 || e.shiftKey) {
                    e.preventDefault();
                    const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
                    headerScroll.scrollLeft += delta;
                }
            }
        }, { passive: false });
    }
}

function sortRowsByZaIndex(table, colIndex, zaSubIndex) {
    const tbody = table.getElementsByTagName("tbody")[0];
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll("tr"));
    if (rows.length < 2) return;

    const currentOrder = table.getAttribute("data-za-sort-" + colIndex);
    const newOrder = currentOrder === "asc" ? "desc" : "asc";
    table.setAttribute("data-za-sort-" + colIndex, newOrder);

    rows.sort((a, b) => {
        const valCellA = a.querySelector(".za_row_scroll > div > div:nth-child(" + (zaSubIndex + 1) + ")");
        const valCellB = b.querySelector(".za_row_scroll > div > div:nth-child(" + (zaSubIndex + 1) + ")");
        const valA = parseFloat(valCellA ? valCellA.textContent : "0") || 0;
        const valB = parseFloat(valCellB ? valCellB.textContent : "0") || 0;
        return newOrder === "asc" ? valA - valB : valB - valA;
    });

    rows.forEach(r => tbody.appendChild(r));

    const headerScroll = table.querySelector(".za_header_scroll");
    if (headerScroll) {
        const scrollLeft = headerScroll.scrollLeft;
        const rowScrolls = tbody.querySelectorAll(".za_row_scroll");
        for (let k = 0; k < rowScrolls.length; k++) {
            rowScrolls[k].scrollLeft = scrollLeft;
        }
    }
}

function scrollToTableRow(tableId, rowIndex) {
    const table = document.getElementById(tableId);
    if (!table) {
        console.error("Table not found.");
        return;
    }

    const rows = table.querySelectorAll("tbody tr"); // Select rows within the tbody
    if (rowIndex >= 0 && rowIndex < rows.length) {
        const row = rows[rowIndex];
        row.scrollIntoView({
            behavior: 'smooth', // Optional: smooth scrolling animation
            block: 'center' // Optional: align the row to the center of the viewport
        });
    } else {
        console.error("Row index out of bounds.");
    }
};



;(function() {
    function Tablesort(el, options) {
      if (!(this instanceof Tablesort)) return new Tablesort(el, options);
  
      if (!el || el.tagName !== 'TABLE') {
        throw new Error('Element must be a table');
      }
      this.init(el, options || {});
    }
  
    var sortOptions = [];
  
    var createEvent = function(name) {
      var evt;
  
      if (!window.CustomEvent || typeof window.CustomEvent !== 'function') {
        evt = document.createEvent('CustomEvent');
        evt.initCustomEvent(name, false, false, undefined);
      } else {
        evt = new CustomEvent(name);
      }
  
      return evt;
    };
  
    var getInnerText = function(el,options) {
      return el.getAttribute(options.sortAttribute || 'data-sort') || el.textContent || el.innerText || '';
    };
  
    // Default sort method if no better sort method is found
    var caseInsensitiveSort = function(a, b) {
      a = a.trim().toLowerCase();
      b = b.trim().toLowerCase();
  
      if (a === b) return 0;
      if (a < b) return 1;
  
      return -1;
    };
  
    var getCellByKey = function(cells, key) {
      return [].slice.call(cells).find(function(cell) {
        return cell.getAttribute('data-sort-column-key') === key;
      });
    };
  
    // Stable sort function
    // If two elements are equal under the original sort function,
    // then there relative order is reversed
    var stabilize = function(sort, antiStabilize) {
      return function(a, b) {
        var unstableResult = sort(a.td, b.td);
  
        if (unstableResult === 0) {
          if (antiStabilize) return b.index - a.index;
          return a.index - b.index;
        }
  
        return unstableResult;
      };
    };
  
    Tablesort.extend = function(name, pattern, sort) {
      if (typeof pattern !== 'function' || typeof sort !== 'function') {
        throw new Error('Pattern and sort must be a function');
      }
  
      sortOptions.push({
        name: name,
        pattern: pattern,
        sort: sort
      });
    };
  
    Tablesort.prototype = {
  
      init: function(el, options) {
        var that = this,
            firstRow,
            defaultSort,
            i,
            cell;
  
        that.table = el;
        that.thead = false;
        that.options = options;
  
        if (el.rows && el.rows.length > 0) {
          if (el.tHead && el.tHead.rows.length > 0) {
            for (i = 0; i < el.tHead.rows.length; i++) {
              if (el.tHead.rows[i].getAttribute('data-sort-method') === 'thead') {
                firstRow = el.tHead.rows[i];
                break;
              }
            }
            if (!firstRow) {
              firstRow = el.tHead.rows[el.tHead.rows.length - 1];
            }
            that.thead = true;
          } else {
            firstRow = el.rows[0];
          }
        }
  
        if (!firstRow) return;
  
        var onClick = function() {
          if (that.current && that.current !== this) {
            that.current.removeAttribute('aria-sort');
          }
  
          that.current = this;
          that.sortTable(this);
        };
  
        // Assume first row is the header and attach a click handler to each.
        for (i = 0; i < firstRow.cells.length; i++) {
          cell = firstRow.cells[i];
          cell.setAttribute('role','columnheader');
          if (cell.getAttribute('data-sort-method') !== 'none') {
            cell.tabindex = 0;
            cell.addEventListener('click', onClick, false);
  
            if (cell.getAttribute('data-sort-default') !== null) {
              defaultSort = cell;
            }
          }
        }
  
        if (defaultSort) {
          that.current = defaultSort;
          that.sortTable(defaultSort);
        }
      },
  
      sortTable: function(header, update) {
        var that = this,
            columnKey = header.getAttribute('data-sort-column-key'),
            column = header.cellIndex,
            sortFunction = caseInsensitiveSort,
            item = '',
            items = [],
            i = that.thead ? 0 : 1,
            sortMethod = header.getAttribute('data-sort-method'),
            sortRevers = header.hasAttribute('data-sort-reverse'),
            sortOrder = header.getAttribute('aria-sort');
  
        that.table.dispatchEvent(createEvent('beforeSort'));
  
        // If updating an existing sort, direction should remain unchanged.
        if (!update) {
          if (sortOrder === 'ascending') {
            sortOrder = 'descending';
          } else if (sortOrder === 'descending') {
            sortOrder = 'ascending';
          } else {
            sortOrder = that.options.descending ? 'descending' : 'ascending';
          }
  
          header.setAttribute('aria-sort', sortOrder);
        }
  
        if (that.table.rows.length < 2) return;
  
        // If we force a sort method, it is not necessary to check rows
        if (!sortMethod) {
          var cell;
          while (items.length < 3 && i < that.table.tBodies[0].rows.length) {
            if(columnKey) {
              cell = getCellByKey(that.table.tBodies[0].rows[i].cells, columnKey);
            } else {
              cell = that.table.tBodies[0].rows[i].cells[column];
            }
  
            // Treat missing cells as empty cells
            item = cell ? getInnerText(cell,that.options) : "";
  
            item = item.trim();
  
            if (item.length > 0) {
              items.push(item);
            }
  
            i++;
          }
  
          if (!items) return;
        }
  
        for (i = 0; i < sortOptions.length; i++) {
          item = sortOptions[i];
  
          if (sortMethod) {
            if (item.name === sortMethod) {
              sortFunction = item.sort;
              break;
            }
          } else if (items.every(item.pattern)) {
            sortFunction = item.sort;
            break;
          }
        }
  
        that.col = column;
  
        for (i = 0; i < that.table.tBodies.length; i++) {
          var newRows = [],
              noSorts = {},
              j,
              totalRows = 0,
              noSortsSoFar = 0;
  
          if (that.table.tBodies[i].rows.length < 2) continue;
  
          for (j = 0; j < that.table.tBodies[i].rows.length; j++) {
            var cell;
  
            item = that.table.tBodies[i].rows[j];
            if (item.getAttribute('data-sort-method') === 'none') {
              // keep no-sorts in separate list to be able to insert
              // them back at their original position later
              noSorts[totalRows] = item;
            } else {
              if (columnKey) {
                cell = getCellByKey(item.cells, columnKey);
              } else {
                cell = item.cells[that.col];
              }
              // Save the index for stable sorting
              newRows.push({
                tr: item,
                td: cell ? getInnerText(cell,that.options) : '',
                index: totalRows
              });
            }
            totalRows++;
          }
          // Before we append should we reverse the new array or not?
          // If we reverse, the sort needs to be `anti-stable` so that
          // the double negatives cancel out
          if ((sortOrder === 'descending' && !sortRevers) || (sortOrder === 'ascending' && sortRevers)) {
            newRows.sort(stabilize(sortFunction, true));
          } else {
            newRows.sort(stabilize(sortFunction, false));
            newRows.reverse();
          }
  
          // append rows that already exist rather than creating new ones
          for (j = 0; j < totalRows; j++) {
            if (noSorts[j]) {
              // We have a no-sort row for this position, insert it here.
              item = noSorts[j];
              noSortsSoFar++;
            } else {
              item = newRows[j - noSortsSoFar].tr;
            }
  
            // appendChild(x) moves x if already present somewhere else in the DOM
            that.table.tBodies[i].appendChild(item);
          }
        }
  
        that.table.dispatchEvent(createEvent('afterSort'));
      },
  
      refresh: function() {
        if (this.current !== undefined) {
          this.sortTable(this.current, true);
        }
      }
    };
  
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = Tablesort;
    } else {
      window.Tablesort = Tablesort;
    }
  })();


  ;(function(){
    var cleanNumber = function(i) {
      return i.replace(/[^\-?0-9,e.]/g, '');
    },
  
    compareNumber = function(a, b) {
      a = parseFloat(a);
      b = parseFloat(b);
  
      a = isNaN(a) ? 0 : a;
      b = isNaN(b) ? 0 : b;
  
      return a - b;
    };
  
    Tablesort.extend('number', function(item) {
      return item.match(/^[+-]?(?=\.?\d)\d*(\.\d+)?([Ee][+-]?\d+)?$/) || // Number with exponent
        item.match(/^[-+]?[£\x24Û¢´€]?\d+\s*([,\.]\d{0,2})/) || // Prefixed currency
        item.match(/^[-+]?\d+\s*([,\.]\d{0,2})?[£\x24Û¢´€]/) || // Suffixed currency
        item.match(/^[-+]?(\d)*-?([,\.]){0,1}-?(\d)+([E,e][\-+][\d]+)?%?$/); // Number
    }, function(a, b) {
      a = cleanNumber(a);
      b = cleanNumber(b);
  
      return compareNumber(b, a);
    });
  }());