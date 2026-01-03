
/**
 * SimpleTutorial Class
 * Manages an interactive step-by-step tutorial.
 */
class SimpleTutorial {
    /**
     * @param {Array} steps - Array of step objects 
     * { 
     *   elementId, 
     *   message, 
     *   triggerEvent (string|Array), 
     *   validate (function, optional), 
     *   hideNext (boolean, optional) 
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
    }

    start() {
        if (this.steps.length === 0) return;
        this.currentStepIndex = 0;
        this.showStep(this.currentStepIndex);
    }

    showStep(index) {
        // Clear previous step styles
        this.clearHighlight();
        this.removeTooltip();
        this.removeListeners();

        if (index >= this.steps.length) {
            this.end();
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

        if (!element && step.elementId) {
            console.warn(`Tutorial: Element ${step.elementId} not found. Skipping step.`);
            this.next();
            return;
        }

        // Highlight element if exists
        if (element) {
            element.classList.add('tutorial-highlight');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Show tooltip
        this.createTooltip(element, step.message, step.hideNext);

        // Attach auto-advance triggers if defined
        if (step.triggerEvent) {
            const events = Array.isArray(step.triggerEvent) ? step.triggerEvent : [step.triggerEvent];

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

            events.forEach(evt => {
                element.addEventListener(evt, handler);
                this._currentListeners.push({ element, evt, handler });
            });
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
            this.end();
        }
    }

    end() {
        this.clearHighlight();
        this.removeTooltip();
        this.removeListeners();
        alert("Tutorial Completed!");
        this.currentStepIndex = -1;
        if (this.onComplete) {
            this.onComplete();
        }
    }

    removeListeners() {
        this._currentListeners.forEach(l => {
            l.element.removeEventListener(l.evt, l.handler);
        });
        this._currentListeners = [];
    }

    clearHighlight() {
        const highlighted = document.querySelectorAll('.tutorial-highlight');
        highlighted.forEach(el => el.classList.remove('tutorial-highlight'));
    }

    createTooltip(targetElement, text, hideNext) {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tutorial-tooltip';
        this.tooltip.innerHTML = text;

        if (!hideNext) {
            const nextBtn = document.createElement('button');
            nextBtn.innerText = 'Next >>';
            nextBtn.style.marginLeft = '10px';
            nextBtn.style.fontSize = '0.8em';
            nextBtn.onclick = () => this.next();
            this.tooltip.appendChild(document.createElement('br'));
            this.tooltip.appendChild(nextBtn);
        }

        document.body.appendChild(this.tooltip);

        // Position tooltip
        if (targetElement) {
            // Position tooltip relative to element
            const rect = targetElement.getBoundingClientRect();
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

            // Position below by default
            let top = rect.bottom + scrollTop + 10;
            let left = rect.left + scrollLeft + (rect.width / 2) - 100; // Centerish

            // Simple boundary check
            if (left < 10) left = 10;

            this.tooltip.style.top = top + 'px';
            this.tooltip.style.left = left + 'px';
        } else {
            // Position fixed center if no target
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
