
/**
 * SimpleTutorial Class
 * Manages an interactive step-by-step tutorial.
 */
class SimpleTutorial {
    /**
     * @param {Array} steps - Array of step objects 
     * { 
     *   elementId, 
     *   innerText,
     *   message, 
     *   triggerEvent (string|Array), 
     *   triggerTarget (string|Element, optional),
     *   validate (function, optional), 
     *   hideNext (boolean, optional),
     *   position (string, optional: 'top'|'bottom'|'inside-top'|'center')
     * }
     * @param {Function} onComplete - Callback when tutorial ends
     */
    constructor(steps, onComplete) {
        this.steps = steps;
        this.onComplete = onComplete;
        this.currentStepIndex = -1;
        this.tooltip = null;
        this.overlay = null;
        this._currentListeners = [];
        this._advancing = false;
    }

    start() {
        if (!this.steps || this.steps.length === 0) return;
        this.currentStepIndex = 0;
        this.showStep(this.currentStepIndex);
    }

    showStep(index) {
        // Clear previous step styles
        this.clearHighlight();
        this.removeTooltip();
        this.removeListeners();

        if (index >= this.steps.length) {
            this.end(true);
            return;
        }

        const step = this.steps[index];
        let element = null;
        if (step.elementId) {
            element = document.getElementById(step.elementId);
        }

        // Search by innerText if provided (and element not found by ID)
        if (!element && step.innerText) {
            const buttons = Array.from(document.getElementsByTagName('button'));
            element = buttons.find(b => b.innerText.trim() === step.innerText);
        }

        if (!element && (step.elementId || step.innerText)) {
            console.warn(`Tutorial: Element ${step.elementId || step.innerText} not found.`);
            // If hideNext is true and no element exists, skip to avoid getting stuck
            if (step.hideNext) {
                this.next();
                return;
            }
        }

        // Highlight element if exists
        if (element) {
            element.classList.add('tutorial-highlight');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Check if validation is already satisfied
        let alreadyValid = false;
        if (typeof step.validate === 'function') {
            try {
                alreadyValid = !!step.validate(null);
            } catch (err) {
                alreadyValid = false;
            }
        }

        // If already satisfied, do not hide Next button
        const hideNextButton = step.hideNext && !alreadyValid;

        // Show tooltip
        this.createTooltip(element, step.message, hideNextButton, step);

        // Attach auto-advance triggers if defined
        if (step.triggerEvent) {
            const events = Array.isArray(step.triggerEvent) ? step.triggerEvent : [step.triggerEvent];
            const targetEl = (typeof step.triggerTarget === 'string'
                ? document.querySelector(step.triggerTarget)
                : (step.triggerTarget || element));

            this.stepStartTime = null; // Reset start time for new step

            const handler = (e) => {
                // Ensure we are active
                if (this.currentStepIndex === index) {
                    // Validation check
                    if (step.validate && !step.validate(e)) {
                        return;
                    }

                    // Duration Check
                    if (step.minDuration) {
                        if (!this.stepStartTime) {
                            this.stepStartTime = Date.now();
                        }

                        const elapsed = Date.now() - this.stepStartTime;
                        const remaining = Math.max(0, Math.ceil((step.minDuration - elapsed) / 1000));

                        this.updateTooltipProgress(remaining);

                        if (elapsed < step.minDuration) {
                            return; // Not yet
                        }
                    }

                    // Small delay to allow the user to see the action effect
                    if (this._advancing) return;
                    this._advancing = true;
                    setTimeout(() => {
                        this.next();
                        this._advancing = false;
                    }, 500);
                }
            };

            if (targetEl && typeof targetEl.addEventListener === 'function') {
                events.forEach(evt => {
                    targetEl.addEventListener(evt, handler);
                    this._currentListeners.push({ element: targetEl, evt, handler });
                });
            }
        }
    }

    updateTooltipProgress(secondsLeft) {
        if (!this.tooltip) return;

        let progressDiv = this.tooltip.querySelector('.tutorial-progress');
        if (!progressDiv) {
            progressDiv = document.createElement('div');
            progressDiv.className = 'tutorial-progress';
            progressDiv.style.marginTop = '5px';
            progressDiv.style.fontWeight = 'bold';
            progressDiv.style.color = '#ffff00'; // Yellow for visibility
            this.tooltip.appendChild(progressDiv);
        }

        if (secondsLeft > 0) {
            progressDiv.innerText = `Keep going... ${secondsLeft}s`;
        } else {
            progressDiv.innerText = "Done!";
            progressDiv.style.color = '#00ff00'; // Green
        }
    }

    next() {
        this.removeListeners();

        this.currentStepIndex++;
        if (this.currentStepIndex < this.steps.length) {
            this.showStep(this.currentStepIndex);
        } else {
            this.end(true);
        }
    }

    cancel() {
        this.clearHighlight();
        this.removeTooltip();
        this.removeListeners();
        this.currentStepIndex = -1;
    }

    end(completed = true) {
        this.clearHighlight();
        this.removeTooltip();
        this.removeListeners();
        this.currentStepIndex = -1;
        if (completed) {
            alert("Tutorial Completed!");
            if (this.onComplete) {
                this.onComplete();
            }
        }
    }

    removeListeners() {
        this._currentListeners.forEach(l => {
            if (l.element && typeof l.element.removeEventListener === 'function') {
                l.element.removeEventListener(l.evt, l.handler);
            }
        });
        this._currentListeners = [];
    }

    clearHighlight() {
        const highlighted = document.querySelectorAll('.tutorial-highlight');
        highlighted.forEach(el => el.classList.remove('tutorial-highlight'));
    }

    createTooltip(targetElement, text, hideNext, step = null) {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tutorial-tooltip';

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.className = 'tutorial-close';
        closeBtn.title = 'Close tutorial';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.cancel();
        };
        this.tooltip.appendChild(closeBtn);

        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = text;
        this.tooltip.appendChild(contentDiv);

        if (!hideNext) {
            const nextBtn = document.createElement('button');
            nextBtn.innerText = 'Next >>';
            nextBtn.style.marginTop = '8px';
            nextBtn.style.fontSize = '0.8em';
            nextBtn.style.cursor = 'pointer';
            nextBtn.onclick = () => this.next();
            this.tooltip.appendChild(nextBtn);
        }

        document.body.appendChild(this.tooltip);

        // Position tooltip
        if (targetElement) {
            const rect = targetElement.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

            let top;
            let left = rect.left + scrollLeft + (rect.width / 2) - 125; // Center 250px tooltip

            const pos = step && step.position ? step.position : (rect.height > 300 ? 'inside-top' : 'bottom');

            if (pos === 'top') {
                top = rect.top + scrollTop - 90;
            } else if (pos === 'inside-top') {
                this.tooltip.classList.add('no-arrow');
                top = rect.top + scrollTop + 20;
                left = rect.left + scrollLeft + 30;
            } else if (pos === 'center') {
                this.tooltip.classList.add('no-arrow');
                top = rect.top + scrollTop + (rect.height / 2) - 50;
            } else {
                top = rect.bottom + scrollTop + 10;
            }

            const maxLeft = (window.innerWidth || document.documentElement.clientWidth) - 280;
            if (left < 10) left = 10;
            if (left > maxLeft && maxLeft > 10) left = maxLeft;
            if (top < 10) top = 10;

            this.tooltip.style.top = top + 'px';
            this.tooltip.style.left = left + 'px';
        } else {
            this.tooltip.classList.add('no-arrow');
            this.tooltip.style.position = 'fixed';
            this.tooltip.style.top = '50%';
            this.tooltip.style.left = '50%';
            this.tooltip.style.transform = 'translate(-50%, -50%)';
            this.tooltip.style.border = '2px solid #4CAF50';
        }
    }

    removeTooltip() {
        if (this.tooltip && this.tooltip.parentNode) {
            this.tooltip.parentNode.removeChild(this.tooltip);
        }
        this.tooltip = null;
    }
}
